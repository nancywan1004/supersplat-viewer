import { Texture, Vec3, PIXELFORMAT_R8, ADDRESS_CLAMP_TO_EDGE, FILTER_LINEAR } from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

const VOLUME_SIZE = 64;
const VOLUME_SLICES = VOLUME_SIZE * VOLUME_SIZE; // 4096
const VOLUME_MARGIN = 0.5;

export interface CommittedPoint {
    position: Vec3;
    radius: number;
}

/**
 * 从已提交圆列表 + 亮度构建 3D 亮度场，烘焙到 2D 图集纹理（64×4096），
 * shader 一次采样得到 mask，无 64 点上限，且每 splat O(1)。
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
                    // 外扩 falloff (0.5r~1.3r)，与笔刷可见范围一致，避免退出 brush 后局部调亮区域看起来变小
                    const t = 1 - smoothstep(r * 0.5, r * 1.3, d);
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

export { VOLUME_SIZE, VOLUME_SLICES };
