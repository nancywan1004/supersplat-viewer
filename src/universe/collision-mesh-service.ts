import {
    buildUniverseApiUrl,
    setUniverseAuthContext
} from './service';

/** 网关：`POST {apiHost}/conversion/voxel-collision` */
const VOXEL_COLLISION_PATH = '/conversion/voxel-collision';

/** glTF binary magic `glTF` */
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] as const;

const OK_CODES = new Set([1, 200]);

/** 默认不绑项目文件，只回 GLB；`projectId` 仍带上供网关鉴权。 */
export const DEFAULT_COLLISION_MESH_UPLOAD = false;

export type GenerateCollisionMeshOptions = {
    /** 缺省 `false`：不登记项目文件。 */
    upload?: boolean;
    projectId?: number | string;
};

export type CollisionMeshResult =
    | { ok: true; blob: Blob }
    | { ok: true; fileUrl: string }
    | { ok: false; message: string };

const isGlbBuffer = (bytes: Uint8Array): boolean => {
    if (bytes.length < 4) return false;
    return (
        bytes[0] === GLB_MAGIC[0] &&
        bytes[1] === GLB_MAGIC[1] &&
        bytes[2] === GLB_MAGIC[2] &&
        bytes[3] === GLB_MAGIC[3]
    );
};

const messageFromJsonBody = (text: string): string | undefined => {
    try {
        const json = JSON.parse(text) as { message?: unknown; code?: unknown };
        if (typeof json.message === 'string' && json.message.trim()) {
            return json.message.trim();
        }
        if (json.code !== undefined && json.code !== 1 && json.code !== 200) {
            return `体素碰撞生成失败（code=${String(json.code)}）`;
        }
    } catch {
        // not JSON
    }
    return undefined;
};

const parseJsonUrl = (text: string): string | undefined => {
    try {
        const json = JSON.parse(text) as { code?: unknown; data?: { url?: unknown } };
        if (!OK_CODES.has(Number(json.code))) return undefined;
        const url = typeof json.data?.url === 'string' ? json.data.url.trim() : '';
        return url || undefined;
    } catch {
        return undefined;
    }
};

/**
 * 请求 Universe 将高斯模型转为碰撞 GLB。
 * 默认 `{ modelUrl, projectId, upload: false }`：鉴权带 projectId，文件不登记到项目。
 */
export const generateCollisionMesh = async (
    modelUrl: string,
    token: string,
    options?: GenerateCollisionMeshOptions
): Promise<CollisionMeshResult> => {
    if (!token) {
        return { ok: false, message: '缺少 token' };
    }

    const trimmedModelUrl = modelUrl.trim();
    if (!trimmedModelUrl) {
        return { ok: false, message: '缺少 modelUrl' };
    }

    const upload = options?.upload === true;
    const id = String(options?.projectId ?? '').trim();
    if (!id) {
        return { ok: false, message: '缺少 projectId' };
    }
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
        return { ok: false, message: 'projectId 必须是数字' };
    }

    setUniverseAuthContext({ token });

    const started = performance.now();
    const elapsedMs = () => Math.round(performance.now() - started);

    const postUrl = buildUniverseApiUrl(VOXEL_COLLISION_PATH);
    const body = {
        modelUrl: trimmedModelUrl,
        projectId: numericId,
        upload
    };

    let response: Response;
    try {
        response = await fetch(postUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: token || ''
            },
            body: JSON.stringify(body)
        });
    } catch (error) {
        console.warn('[VoxelCollision] generate failed', {
            elapsedMs: elapsedMs(),
            error
        });
        throw error;
    }

    let buffer: ArrayBuffer;
    try {
        buffer = await response.arrayBuffer();
    } catch (error) {
        console.warn('[VoxelCollision] generate failed', {
            elapsedMs: elapsedMs(),
            error
        });
        return { ok: false, message: '读取体素碰撞响应失败' };
    }

    const bytes = new Uint8Array(buffer);

    if (!response.ok) {
        const text = new TextDecoder().decode(bytes);
        const message =
            messageFromJsonBody(text) ||
            `请求失败，状态码: ${response.status}`;
        console.warn('[VoxelCollision] generate failed', {
            elapsedMs: elapsedMs(),
            status: response.status,
            message
        });
        return { ok: false, message };
    }

    if (isGlbBuffer(bytes)) {
        const blob = new Blob([buffer], { type: 'model/gltf-binary' });
        console.log('[VoxelCollision] generate finished', {
            elapsedMs: elapsedMs(),
            bytes: buffer.byteLength,
            upload
        });
        return { ok: true, blob };
    }

    const text = new TextDecoder().decode(bytes);
    const fileUrl = parseJsonUrl(text);
    if (fileUrl) {
        console.log('[VoxelCollision] generate finished', {
            elapsedMs: elapsedMs(),
            fileUrl,
            upload
        });
        return { ok: true, fileUrl };
    }

    const message = messageFromJsonBody(text) || '体素碰撞接口未返回 GLB 或下载地址';
    console.warn('[VoxelCollision] generate failed', {
        elapsedMs: elapsedMs(),
        message
    });
    return { ok: false, message };
};
