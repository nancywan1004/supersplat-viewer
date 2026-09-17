import {
    buildUniverseApiUrl,
    fetchUniverseJsonGet,
    fetchUniverseJsonPost,
    setUniverseAuthContext
} from './service';

/** 网关前缀转发：`POST/GET {apiHost}/conversion/voxel-collision/jobs` */
const VOXEL_COLLISION_JOBS_PATH = '/conversion/voxel-collision/jobs';

const POLL_INTERVAL_MS = 2000;
/** 进入 running 后，在服务端 timeoutMs 之上再留缓冲，以便收到 failed 而不是客户端先放弃。 */
const RUNNING_POLL_BUFFER_MS = 30_000;
/** 排队过久的兜底（不含转换超时）。 */
const MAX_QUEUED_POLL_MS = 30 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1000;

/** glTF binary magic `glTF` */
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] as const;

type VoxelCollisionJobData = {
    jobId?: string;
    status?: string;
    error?: string;
    queuePosition?: number;
    queuedMs?: number;
    runningElapsedMs?: number;
    elapsedMs?: number;
    timeoutMs?: number;
    etaMs?: number;
    progress?: number;
    data?: { url?: string };
};

type VoxelCollisionSubmitResponse = {
    code: number;
    message?: string;
    /** 网关错误信封用 `msg`（如 `{code:401,msg:'认证失败!'}`），业务侧用 `message` */
    msg?: string;
    data?: VoxelCollisionJobData;
};

type VoxelCollisionJobResponse = {
    code: number;
    message?: string;
    msg?: string;
    data?: VoxelCollisionJobData;
};

// 取服务端/网关的错误文案：业务 `message` 优先，网关 `msg` 兜底。
const errorTextOf = (payload: { message?: string; msg?: string } | undefined | null): string => {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (message) {
        return message;
    }
    const msg = typeof payload?.msg === 'string' ? payload.msg.trim() : '';
    return msg;
};

export type CollisionJobProgress = {
    jobId: string;
    status: 'queued' | 'running';
    queuePosition: number;
    queuedMs: number;
    runningElapsedMs: number;
    elapsedMs: number;
    timeoutMs: number;
    etaMs: number;
    /** 0–100 估算，不是 GPU 真实百分比。 */
    progress: number;
};

/** 默认不绑项目文件；`projectId` 仍带上供网关鉴权。成功后下载 GLB 入库会话表。 */
export const DEFAULT_COLLISION_MESH_UPLOAD = false;

export type GenerateCollisionMeshOptions = {
    /** 缺省 `false`：不登记项目文件，结果从 `GET .../jobs/:jobId/glb` 取。 */
    upload?: boolean;
    /**
     * `upload: true` 时必填且须为数字；`upload: false` 时可缺省
     * （服务端不登记项目文件，也不需要它）。有值时仍随请求带上，供网关鉴权。
     */
    projectId?: number | string;
    onProgress?: (progress: CollisionJobProgress) => void;
    /** 覆盖接口根地址：仅供 localhost 本地联调指向本机转换服务（缺省走 Universe 网关）。 */
    apiBaseUrl?: string;
};

export type CollisionMeshResult =
    | { ok: true; blob: Blob }
    | { ok: true; fileUrl: string }
    | { ok: false; message: string };

const OK_CODES = new Set([1, 200]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

const httpStatusFromError = (error: unknown): number | undefined => {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/状态码:\s*(\d+)/);
    if (!match) return undefined;
    return Number(match[1]);
};

const asFiniteNumber = (value: unknown, fallback: number): number => {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const isGlbBuffer = (bytes: Uint8Array): boolean => {
    if (bytes.length < 4) return false;
    return (
        bytes[0] === GLB_MAGIC[0] &&
        bytes[1] === GLB_MAGIC[1] &&
        bytes[2] === GLB_MAGIC[2] &&
        bytes[3] === GLB_MAGIC[3]
    );
};

const progressFromJobData = (
    jobId: string,
    status: 'queued' | 'running',
    data: NonNullable<VoxelCollisionJobResponse['data']>
): CollisionJobProgress => {
    const timeoutMs = asFiniteNumber(data.timeoutMs, DEFAULT_JOB_TIMEOUT_MS);
    return {
        jobId,
        status,
        queuePosition: asFiniteNumber(data.queuePosition, status === 'queued' ? 1 : 0),
        queuedMs: asFiniteNumber(data.queuedMs, 0),
        runningElapsedMs: asFiniteNumber(data.runningElapsedMs, 0),
        elapsedMs: asFiniteNumber(data.elapsedMs, 0),
        timeoutMs,
        etaMs: asFiniteNumber(data.etaMs, status === 'running' ? timeoutMs : 0),
        progress: asFiniteNumber(data.progress, status === 'queued' ? 1 : 20)
    };
};

const downloadCollisionGlb = async (fileUrl: string): Promise<CollisionMeshResult> => {
    let response: Response;
    try {
        response = await fetch(fileUrl);
    } catch (error) {
        console.warn('[VoxelCollision] download glb failed', { fileUrl, error });
        return { ok: false, message: '下载碰撞 GLB 失败' };
    }
    if (!response.ok) {
        return { ok: false, message: `下载碰撞 GLB 失败，状态码: ${response.status}` };
    }
    let buffer: ArrayBuffer;
    try {
        buffer = await response.arrayBuffer();
    } catch (error) {
        console.warn('[VoxelCollision] download glb failed', { fileUrl, error });
        return { ok: false, message: '读取碰撞 GLB 失败' };
    }
    const bytes = new Uint8Array(buffer);
    if (!isGlbBuffer(bytes)) {
        return { ok: false, message: '下载的碰撞文件不是 GLB' };
    }
    return { ok: true, blob: new Blob([buffer], { type: 'model/gltf-binary' }) };
};

/**
 * 请求 Universe 将高斯模型转为碰撞 GLB（提交异步任务并轮询）。
 *
 * 默认 `{ modelUrl, upload: false }`：不登记项目文件，**不需要 token / projectId**。
 * - `upload: false` → `GET .../jobs/:jobId/glb` 取二进制，交给调用方入库；传了 token / projectId 也会照带上供网关鉴权。
 * - `upload: true` → 服务端上传 OSS 并登记到 projectId 名下，直接返回 `data.url`（此时 token、projectId 必填）。
 *
 * 客户端超时从任务进入 `running` 起算（对齐服务端 `VOXEL_JOB_TIMEOUT_MS`），不含排队。
 *
 * @see 网关 `POST /conversion/voxel-collision/jobs` + `GET /conversion/voxel-collision/jobs/:jobId`
 */
export const generateCollisionMesh = async (
    modelUrl: string,
    token: string,
    options?: GenerateCollisionMeshOptions
): Promise<CollisionMeshResult> => {
    const trimmedModelUrl = modelUrl.trim();
    if (!trimmedModelUrl) {
        return { ok: false, message: '缺少 modelUrl' };
    }

    const upload = options?.upload === true;
    // Authorization 只在 upload: true（登记项目文件）时由服务端校验；
    // upload: false 走任务级 GLB，不需要 token。
    if (!token && upload) {
        return { ok: false, message: '缺少 token' };
    }
    // upload: false 时服务端不登记项目文件，projectId 非必需（见 service/README.md）。
    // 仍把可用值带上：走网关时缺它会被鉴权拒掉（401）。
    const id = String(options?.projectId ?? '').trim();
    let numericId: number | undefined;
    if (id) {
        numericId = Number(id);
        if (!Number.isFinite(numericId)) {
            return { ok: false, message: 'projectId 必须是数字' };
        }
    } else if (upload) {
        return { ok: false, message: '缺少 projectId' };
    }

    setUniverseAuthContext({ token });

    const started = performance.now();
    const elapsedMs = () => Math.round(performance.now() - started);

    const apiBaseUrl = options?.apiBaseUrl?.trim().replace(/\/+$/, '');
    const buildApiUrl = (path: string) => {
        return apiBaseUrl ? `${apiBaseUrl}${path}` : buildUniverseApiUrl(path);
    };

    const submitUrl = buildApiUrl(VOXEL_COLLISION_JOBS_PATH);
    let submit: VoxelCollisionSubmitResponse;
    try {
        submit = await fetchUniverseJsonPost<VoxelCollisionSubmitResponse>(submitUrl, {
            ...(numericId !== undefined ? { projectId: numericId } : {}),
            modelUrl: trimmedModelUrl,
            upload
        });
    } catch (error) {
        const status = httpStatusFromError(error);
        if (status === 429) {
            console.warn('[VoxelCollision] generate failed', {
                projectId: numericId,
                elapsedMs: elapsedMs(),
                message: '任务队列已满'
            });
            return { ok: false, message: '任务队列已满，请稍后重试' };
        }
        console.warn('[VoxelCollision] generate failed', {
            elapsedMs: elapsedMs(),
            error
        });
        throw error;
    }

    if (!OK_CODES.has(submit.code)) {
        const serverMessage = errorTextOf(submit);
        const message = serverMessage || '体素碰撞任务提交失败';
        // 带上 base/凭证上下文：body 里出现 401/403 时通常是网关鉴权层拒绝，
        // 而不是转换服务本身（服务端 upload:false 不校验 Authorization）。
        console.warn('[VoxelCollision] generate failed', {
            url: submitUrl,
            upload,
            hasToken: !!token,
            projectId: numericId ?? null,
            code: submit.code,
            serverMessage: serverMessage || undefined,
            message,
            elapsedMs: elapsedMs()
        });
        return { ok: false, message };
    }

    const jobId = typeof submit.data?.jobId === 'string' ? submit.data.jobId.trim() : '';
    if (!jobId) {
        return { ok: false, message: '体素碰撞接口未返回 jobId' };
    }

    console.log('[VoxelCollision] job queued', {
        projectId: numericId,
        jobId,
        elapsedMs: elapsedMs()
    });

    const pollUrl = buildApiUrl(`${VOXEL_COLLISION_JOBS_PATH}/${jobId}`);
    const queuedDeadline = Date.now() + MAX_QUEUED_POLL_MS;
    let runningDeadline: number | null = null;

    const reportProgress = (data: VoxelCollisionJobData | undefined, status: string | undefined) => {
        if (status !== 'queued' && status !== 'running') return;
        const progress = progressFromJobData(jobId, status, data ?? {});
        options?.onProgress?.(progress);
        if (status === 'running' && runningDeadline === null) {
            runningDeadline = Date.now() + progress.timeoutMs + RUNNING_POLL_BUFFER_MS;
        }
    };

    reportProgress(submit.data, submit.data?.status);

    while (true) {
        let poll: VoxelCollisionJobResponse;
        try {
            poll = await fetchUniverseJsonGet<VoxelCollisionJobResponse>(pollUrl);
        } catch (error) {
            const status = httpStatusFromError(error);
            if (status === 404) {
                console.warn('[VoxelCollision] generate failed', {
                    projectId: numericId,
                    jobId,
                    elapsedMs: elapsedMs(),
                    message: '任务不存在或已过期'
                });
                return { ok: false, message: '任务不存在或已过期，请重新生成' };
            }
            console.warn('[VoxelCollision] generate failed', {
                projectId: numericId,
                jobId,
                elapsedMs: elapsedMs(),
                error
            });
            throw error;
        }

        if (!OK_CODES.has(poll.code)) {
            return { ok: false, message: errorTextOf(poll) || '查询体素碰撞任务失败' };
        }

        const status = poll.data?.status;
        if (status === 'queued' || status === 'running') {
            reportProgress(poll.data, status);

            if (status === 'queued' && Date.now() > queuedDeadline) {
                console.warn('[VoxelCollision] generate failed', {
                    projectId: numericId,
                    jobId,
                    elapsedMs: elapsedMs(),
                    message: '排队等待超时'
                });
                return { ok: false, message: '碰撞网格排队等待超时，请稍后重试' };
            }

            if (status === 'running') {
                if (runningDeadline !== null && Date.now() > runningDeadline) {
                    console.warn('[VoxelCollision] generate failed', {
                        projectId: numericId,
                        jobId,
                        elapsedMs: elapsedMs(),
                        message: '等待任务超时'
                    });
                    return { ok: false, message: '等待碰撞网格生成超时，请稍后重试' };
                }
            }

            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (status === 'failed') {
            const message =
                (typeof poll.data?.error === 'string' && poll.data.error.trim())
                || errorTextOf(poll)
                || '体素碰撞生成失败';
            console.warn('[VoxelCollision] generate failed', {
                projectId: numericId,
                jobId,
                elapsedMs: elapsedMs(),
                message
            });
            return { ok: false, message };
        }

        if (status === 'succeeded') {
            // upload: true → 服务端已上传 OSS 并登记，用其 data.url；
            // upload: false → 服务端不落库，GLB 由任务级端点直出。
            let fileUrl = '';
            if (upload) {
                fileUrl = typeof poll.data?.data?.url === 'string' ? poll.data.data.url.trim() : '';
            } else {
                fileUrl = buildApiUrl(`${VOXEL_COLLISION_JOBS_PATH}/${jobId}/glb`);
            }
            if (!fileUrl) {
                return { ok: false, message: '体素碰撞接口未返回 GLB 下载地址' };
            }
            console.log('[VoxelCollision] generate finished', {
                projectId: numericId,
                jobId,
                elapsedMs: elapsedMs(),
                fileUrl,
                upload
            });
            if (upload) {
                return { ok: true, fileUrl };
            }
            const downloaded = await downloadCollisionGlb(fileUrl);
            if (downloaded.ok === false) {
                console.warn('[VoxelCollision] glb ingest fallback to fileUrl', {
                    fileUrl,
                    message: downloaded.message
                });
                return { ok: true, fileUrl };
            }
            return downloaded;
        }

        return { ok: false, message: `未知任务状态: ${status ?? 'empty'}` };
    }
};
