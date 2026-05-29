import {
    buildUniverseApiUrl,
    fetchUniverseJsonGet,
    fetchUniverseJsonPost,
    setUniverseAuthContext
} from './service';

const GENERATE_COLLISION_MESH = '/app/api/v1/saas/project/collision-mesh/generate';
const GET_COLLISION_MESH_STATUS = '/app/api/v1/saas/project/collision-mesh/status';

type CollisionMeshApiResponse = {
    code: number;
    data?: { fileUrl?: string; status?: string; taskId?: string };
    message: string;
};

export type CollisionMeshResult =
    | { ok: true; fileUrl: string }
    | { ok: false; message: string };

const POLL_MS = 2000;
const TIMEOUT_MS = 120_000;
const OK_CODES = new Set([1, 200]);
const READY = new Set(['ready', 'success', 'completed', 'done']);
const FAILED = new Set(['failed', 'error', 'cancelled']);

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** 请求 Universe 将项目高斯转为碰撞 GLB，异步则轮询至就绪或超时。 */
export const generateCollisionMesh = async (
    projectId: number | string,
    token: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number }
): Promise<CollisionMeshResult> => {
    if (!token) {
        return { ok: false, message: '缺少 token' };
    }

    const id = String(projectId).trim();
    if (!id) {
        return { ok: false, message: '缺少 projectId' };
    }

    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
        return { ok: false, message: 'projectId 必须是数字' };
    }

    setUniverseAuthContext({ token });

    const pollMs = options?.pollIntervalMs ?? POLL_MS;
    const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;

    const parse = (response: CollisionMeshApiResponse) => {
        const data = response.data;
        const fileUrl = typeof data?.fileUrl === 'string' ? data.fileUrl.trim() : undefined;
        const status = (data?.status ?? '').toLowerCase();
        const message = typeof response.message === 'string' ? response.message.trim() : '';
        const ok = OK_CODES.has(response.code);
        const ready = !!fileUrl || READY.has(status);
        const failed = FAILED.has(status);
        return { ok, fileUrl, status, message, ready, failed };
    };

    const postUrl = buildUniverseApiUrl(GENERATE_COLLISION_MESH);
    let current = parse(await fetchUniverseJsonPost<CollisionMeshApiResponse>(postUrl, { projectId: numericId }));

    if (!current.ok && !current.fileUrl) {
        return { ok: false, message: current.message || '触发碰撞网格生成失败' };
    }
    if (current.fileUrl && current.ready) {
        return { ok: true, fileUrl: current.fileUrl };
    }

    const deadline = Date.now() + timeoutMs;
    const statusUrl = `${buildUniverseApiUrl(GET_COLLISION_MESH_STATUS)}?projectId=${encodeURIComponent(id)}`;
    while (Date.now() < deadline) {
        await sleep(pollMs);
        current = parse(await fetchUniverseJsonGet<CollisionMeshApiResponse>(statusUrl));

        if (current.failed) {
            return { ok: false, message: current.message || '碰撞网格生成失败' };
        }
        if (current.ok && current.fileUrl && current.ready) {
            return { ok: true, fileUrl: current.fileUrl };
        }
    }

    return { ok: false, message: '碰撞网格生成超时，请稍后重试' };
};
