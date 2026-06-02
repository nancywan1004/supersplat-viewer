import {
    buildUniverseApiUrl,
    fetchUniverseJsonPost,
    setUniverseAuthContext
} from './service';

/** 网关：`POST {apiHost}/conversion/voxel-collision` */
const VOXEL_COLLISION_PATH = '/conversion/voxel-collision';

type VoxelCollisionApiResponse = {
    code: number;
    message?: string;
    data?: { url?: string };
};

export type CollisionMeshResult =
    | { ok: true; fileUrl: string }
    | { ok: false; message: string };

const OK_CODES = new Set([1, 200]);

/**
 * 请求 Universe 将高斯模型转为碰撞 GLB（同步返回下载地址）。
 *
 * @see 网关 `POST /conversion/voxel-collision`，body `{ projectId, modelUrl }`，成功 `code === 1`，`data.url` 为 GLB 地址。
 */
export const generateCollisionMesh = async (
    projectId: number | string,
    token: string,
    modelUrl: string
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

    const trimmedModelUrl = modelUrl.trim();
    if (!trimmedModelUrl) {
        return { ok: false, message: '缺少 modelUrl' };
    }

    setUniverseAuthContext({ token });

    const started = performance.now();
    const elapsedMs = () => Math.round(performance.now() - started);

    const postUrl = buildUniverseApiUrl(VOXEL_COLLISION_PATH);
    let response: VoxelCollisionApiResponse;
    try {
        response = await fetchUniverseJsonPost<VoxelCollisionApiResponse>(postUrl, {
            projectId: numericId,
            modelUrl: trimmedModelUrl
        });
    } catch (error) {
        console.warn('[VoxelCollision] generate failed', {
            projectId: numericId,
            elapsedMs: elapsedMs(),
            error
        });
        throw error;
    }

    if (!OK_CODES.has(response.code)) {
        const message =
            typeof response.message === 'string' && response.message.trim()
                ? response.message.trim()
                : '体素碰撞生成失败';
        console.warn('[VoxelCollision] generate failed', {
            projectId: numericId,
            elapsedMs: elapsedMs(),
            code: response.code,
            message
        });
        return { ok: false, message };
    }

    const fileUrl = typeof response.data?.url === 'string' ? response.data.url.trim() : '';
    if (!fileUrl) {
        console.warn('[VoxelCollision] generate failed', {
            projectId: numericId,
            elapsedMs: elapsedMs(),
            message: '体素碰撞接口未返回 GLB 下载地址'
        });
        return { ok: false, message: '体素碰撞接口未返回 GLB 下载地址' };
    }

    console.log('[VoxelCollision] generate finished', {
        projectId: numericId,
        elapsedMs: elapsedMs(),
        fileUrl
    });
    return { ok: true, fileUrl };
};
