import { Texture, Vec3, PIXELFORMAT_R8, ADDRESS_CLAMP_TO_EDGE, FILTER_LINEAR } from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

const VOLUME_SIZE = 64;
const VOLUME_SLICES = VOLUME_SIZE * VOLUME_SIZE; // 4096
const VOLUME_MARGIN = 0.5;

export interface CommittedPoint {
    position: Vec3;
    radius: number;
}

/** 带所属区域局部亮度 -1～1 的已提交点，用于多区域叠加烘焙 */
export interface CommittedPointWithBrightness extends CommittedPoint {
    brightness: number;
}

/**
 * 从已提交圆列表 + 亮度构建 3D 亮度场，烘焙到 2D 图集纹理（64×4096），
 * shader 一次采样得到 mask，无 64 点上限，且每 splat O(1)。
 *
 * 多区域约束对本模块的含义：
 * - 单区域入口 buildCommittedBrightnessVolume()：假定 points 来源于「某一个 LocalLightRegion 的 committed 集合」
 *   或旧版 worldSpacePoints，整体亮度由统一的 brightness 乘数控制；
 * - 多区域入口 buildCommittedBrightnessVolumeFromRegions()：假定 points 已由调用方按 LocalLightRegion 展开并带上各自的
 *   brightness（-1～1），此处只负责在烘焙阶段把它们叠加为单张体积纹理：
 *   - AABB 取所有区域的并集；
 *   - 每个体素按所有点的贡献权重平均得到有效亮度，并编码到 R8（0～1 = -1～1）；
 *   - GPU 侧始终只需要「一张纹理 + 一次采样」，与区域数量无关。
 *
 * 这样可以保证「体积在渲染阶段按区域叠加」这一原则，而不改变 NightMode/BloomController 对外暴露的 API 形态。
 */
export function buildCommittedBrightnessVolume(
    device: GraphicsDevice,
    points: CommittedPoint[],
    existingTexture: Texture | null
): { texture: Texture; aabbMin: Vec3; aabbMax: Vec3 } {
    const aabbMin = new Vec3(0, 0, 0);
    const aabbMax = new Vec3(1, 1, 1);

    if (points.length === 0) {
        if (!existingTexture) {
            const tex = new Texture(device, {
                name: 'committedBrightnessVolume',
                width: 1,
                height: 1,
                format: PIXELFORMAT_R8,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                mipmaps: false
            });
            const pixels = tex.lock();
            pixels[0] = 0;
            tex.unlock();
            tex.upload();
            return { texture: tex, aabbMin, aabbMax };
        }
        return { texture: existingTexture, aabbMin, aabbMax };
    }

    // AABB from all circles (position ± radius) + margin
    const margin = VOLUME_MARGIN;
    aabbMin.set(Infinity, Infinity, Infinity);
    aabbMax.set(-Infinity, -Infinity, -Infinity);
    for (const p of points) {
        const r = Math.max(0.01, p.radius);
        aabbMin.x = Math.min(aabbMin.x, p.position.x - r - margin);
        aabbMin.y = Math.min(aabbMin.y, p.position.y - r - margin);
        aabbMin.z = Math.min(aabbMin.z, p.position.z - r - margin);
        aabbMax.x = Math.max(aabbMax.x, p.position.x + r + margin);
        aabbMax.y = Math.max(aabbMax.y, p.position.y + r + margin);
        aabbMax.z = Math.max(aabbMax.z, p.position.z + r + margin);
    }
    let sizeX = aabbMax.x - aabbMin.x;
    let sizeY = aabbMax.y - aabbMin.y;
    let sizeZ = aabbMax.z - aabbMin.z;
    if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) {
        aabbMin.set(0, 0, 0);
        aabbMax.set(1, 1, 1);
        sizeX = sizeY = sizeZ = 1;
    }

    const width = VOLUME_SIZE;
    const height = VOLUME_SLICES; // 64*64

    let tex = existingTexture;
    if (!tex || tex.width !== width || tex.height !== height) {
        if (tex) tex.destroy();
        tex = new Texture(device, {
            name: 'committedBrightnessVolume',
            width,
            height,
            format: PIXELFORMAT_R8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            mipmaps: false
        });
    }

    const pixels = tex.lock();
    const scaleX = sizeX > 0 ? 1 / sizeX : 1;
    const scaleY = sizeY > 0 ? 1 / sizeY : 1;
    const scaleZ = sizeZ > 0 ? 1 / sizeZ : 1;

    for (let iz = 0; iz < VOLUME_SIZE; iz++) {
        for (let iy = 0; iy < VOLUME_SIZE; iy++) {
            for (let ix = 0; ix < VOLUME_SIZE; ix++) {
                const wx = aabbMin.x + (ix + 0.5) / VOLUME_SIZE * sizeX;
                const wy = aabbMin.y + (iy + 0.5) / VOLUME_SIZE * sizeY;
                const wz = aabbMin.z + (iz + 0.5) / VOLUME_SIZE * sizeZ;
                let mask = 0;
                for (const p of points) {
                    const dx = wx - p.position.x;
                    const dy = wy - p.position.y;
                    const dz = wz - p.position.z;
                    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    const r = Math.max(0.01, p.radius);
                    // 85% 半径实心 + 外圈 15% 渐变，与 2D mask 实心圆接近
                    const t = 1 - smoothstep(r * 0.85, r, d);
                    mask += t;
                }
                mask = Math.min(1, mask);
                const idx = ix + iy * width + iz * width * VOLUME_SIZE;
                pixels[idx] = Math.round(mask * 255);
            }
        }
    }
    tex.unlock();
    tex.upload();

    return { texture: tex, aabbMin, aabbMax };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * 多区域叠加：从带亮度的已提交点列表构建 3D 有效亮度场，烘焙到同一张 2D 图集。
 * 每个体素按各点贡献加权得到有效亮度 (-1～1)，编码为 0～255 写入 R8；
 * AABB 取所有区域的并集。单纹理、单次采样，无额外 GPU 开销。
 */
export function buildCommittedBrightnessVolumeFromRegions(
    device: GraphicsDevice,
    points: CommittedPointWithBrightness[],
    existingTexture: Texture | null
): { texture: Texture; aabbMin: Vec3; aabbMax: Vec3 } {
    const aabbMin = new Vec3(0, 0, 0);
    const aabbMax = new Vec3(1, 1, 1);

    if (points.length === 0) {
        if (!existingTexture) {
            const tex = new Texture(device, {
                name: 'committedBrightnessVolume',
                width: 1,
                height: 1,
                format: PIXELFORMAT_R8,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                mipmaps: false
            });
            const pixels = tex.lock();
            pixels[0] = 0;
            tex.unlock();
            tex.upload();
            return { texture: tex, aabbMin, aabbMax };
        }
        return { texture: existingTexture, aabbMin, aabbMax };
    }

    const margin = VOLUME_MARGIN;
    aabbMin.set(Infinity, Infinity, Infinity);
    aabbMax.set(-Infinity, -Infinity, -Infinity);
    for (const p of points) {
        const r = Math.max(0.01, p.radius);
        aabbMin.x = Math.min(aabbMin.x, p.position.x - r - margin);
        aabbMin.y = Math.min(aabbMin.y, p.position.y - r - margin);
        aabbMin.z = Math.min(aabbMin.z, p.position.z - r - margin);
        aabbMax.x = Math.max(aabbMax.x, p.position.x + r + margin);
        aabbMax.y = Math.max(aabbMax.y, p.position.y + r + margin);
        aabbMax.z = Math.max(aabbMax.z, p.position.z + r + margin);
    }
    let sizeX = aabbMax.x - aabbMin.x;
    let sizeY = aabbMax.y - aabbMin.y;
    let sizeZ = aabbMax.z - aabbMin.z;
    if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) {
        aabbMin.set(0, 0, 0);
        aabbMax.set(1, 1, 1);
        sizeX = sizeY = sizeZ = 1;
    }

    const width = VOLUME_SIZE;
    const height = VOLUME_SLICES;

    let tex = existingTexture;
    if (!tex || tex.width !== width || tex.height !== height) {
        if (tex) tex.destroy();
        tex = new Texture(device, {
            name: 'committedBrightnessVolume',
            width,
            height,
            format: PIXELFORMAT_R8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            mipmaps: false
        });
    }

    const pixels = tex.lock();
    for (let iz = 0; iz < VOLUME_SIZE; iz++) {
        for (let iy = 0; iy < VOLUME_SIZE; iy++) {
            for (let ix = 0; ix < VOLUME_SIZE; ix++) {
                const wx = aabbMin.x + (ix + 0.5) / VOLUME_SIZE * sizeX;
                const wy = aabbMin.y + (iy + 0.5) / VOLUME_SIZE * sizeY;
                const wz = aabbMin.z + (iz + 0.5) / VOLUME_SIZE * sizeZ;
                let weightSum = 0;
                let brightnessSum = 0;
                for (const p of points) {
                    const dx = wx - p.position.x;
                    const dy = wy - p.position.y;
                    const dz = wz - p.position.z;
                    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    const r = Math.max(0.01, p.radius);
                    const t = 1 - smoothstep(r * 0.85, r, d);
                    const b = Math.max(-1, Math.min(1, p.brightness));
                    weightSum += t;
                    brightnessSum += t * b;
                }
                const idx = ix + iy * width + iz * width * VOLUME_SIZE;
                if (weightSum <= 1e-6) {
                    pixels[idx] = 0;
                } else {
                    const effectiveBrightness = Math.max(-1, Math.min(1, brightnessSum / weightSum));
                    const encoded = Math.round((effectiveBrightness * 0.5 + 0.5) * 255);
                    pixels[idx] = Math.max(1, Math.min(255, encoded));
                }
            }
        }
    }
    tex.unlock();
    tex.upload();

    return { texture: tex, aabbMin, aabbMax };
}

export { VOLUME_SIZE, VOLUME_SLICES };
