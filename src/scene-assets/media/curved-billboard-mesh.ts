import {
    type Entity,
    type GraphicsDevice,
    Mesh,
    MeshInstance,
    PlaneGeometry,
    Vec2,
    Vec3
} from 'playcanvas';

/** 归一化曲度上限：1 对应 `VIDEO_HORIZONTAL_MAX_ARC_DEG` 整弧张角 */
export const VIDEO_HORIZONTAL_CURVATURE_MAX = 1;

/** 曲度为 1 时，屏幕宽度方向总张角（度） */
export const VIDEO_HORIZONTAL_MAX_ARC_DEG = 270;

export const VIDEO_CURVED_WIDTH_SEGMENTS = 48;
export const VIDEO_CURVED_LENGTH_SEGMENTS = 1;

const HALF_WIDTH = 0.5;
const HALF_HEIGHT = 0.5;
const CURVATURE_EPS = 1e-5;

export function clampVideoHorizontalCurvature(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(VIDEO_HORIZONTAL_CURVATURE_MAX, value));
}

/**
 * 自定义 PlaneGeometry 与内置 `render.type:'plane'` 绕序相反；翻转局部 X 后贴图左右与 image 一致。
 */
function mirrorPlaneGeometryWidth(geometry: PlaneGeometry): void {
    const positions = geometry.positions;
    if (!positions) return;
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = -positions[i];
    }
    geometry.calculateNormals();
}

/**
 * 维持 PlaneGeometry 与内置 `render.type:'plane'` 一致的朝向（XZ 平面、法线 +Y），
 * 仅沿局部 X（宽度）做圆柱弧弯曲（凹向 -Y，朝外）。
 */
function bendPlaneGeometryHorizontalArc(geometry: PlaneGeometry, curvature: number): void {
    const positions = geometry.positions;
    if (!positions) return;

    const c = clampVideoHorizontalCurvature(curvature);
    if (c <= CURVATURE_EPS) {
        return;
    }

    const thetaMax = c * VIDEO_HORIZONTAL_MAX_ARC_DEG * (Math.PI / 180);
    const halfThetaMax = thetaMax * 0.5;
    const sinHalf = Math.sin(halfThetaMax);
    const radius = sinHalf > CURVATURE_EPS ? HALF_WIDTH / sinHalf : 1e6;

    for (let i = 0; i < positions.length; i += 3) {
        const gx = positions[i];
        const gz = positions[i + 2];
        const u = HALF_WIDTH > CURVATURE_EPS ? gx / HALF_WIDTH : 0;
        const theta = u * halfThetaMax;
        const bx = radius * Math.sin(theta);
        const by = -radius * (1 - Math.cos(theta));
        const bz = gz;
        positions[i] = bx;
        positions[i + 1] = by;
        positions[i + 2] = bz;
    }
    geometry.calculateNormals();
}

function buildBillboardGeometry(curvature: number): PlaneGeometry {
    const geometry = new PlaneGeometry({
        halfExtents: new Vec2(HALF_WIDTH, HALF_HEIGHT),
        widthSegments: VIDEO_CURVED_WIDTH_SEGMENTS,
        lengthSegments: VIDEO_CURVED_LENGTH_SEGMENTS
    });
    mirrorPlaneGeometryWidth(geometry);
    bendPlaneGeometryHorizontalArc(geometry, curvature);
    return geometry;
}

export function createCurvedBillboardMesh(device: GraphicsDevice, curvature: number): Mesh {
    const geometry = buildBillboardGeometry(curvature);
    return Mesh.fromGeometry(device, geometry);
}

export type VideoHorizontalArcParams = {
    halfThetaMax: number;
    radius: number;
};

/** 与 `bendPlaneGeometryHorizontalArc` 一致；曲度为 0 时返回 null（走平面求交） */
export function getVideoHorizontalArcParams(curvature: number): VideoHorizontalArcParams | null {
    const c = clampVideoHorizontalCurvature(curvature);
    if (c <= CURVATURE_EPS) return null;
    const thetaMax = c * VIDEO_HORIZONTAL_MAX_ARC_DEG * (Math.PI / 180);
    const halfThetaMax = thetaMax * 0.5;
    const sinHalf = Math.sin(halfThetaMax);
    const radius = sinHalf > CURVATURE_EPS ? HALF_WIDTH / sinHalf : 1e6;
    return { halfThetaMax, radius };
}

export type VideoMeshPickHit = {
    point: Vec3;
    /** 与 mirror 后几何一致的纹理横向坐标（用于 `(0.5 - gx) * texW`） */
    gx: number;
    /** 纹理纵向坐标（用于 `(0.5 - gz) * texH`） */
    gz: number;
};

function bentVertexLocal(gx: number, gz: number, curvature: number): Vec3 {
    const c = clampVideoHorizontalCurvature(curvature);
    if (c <= CURVATURE_EPS) {
        return new Vec3(gx, 0, gz);
    }
    const arc = getVideoHorizontalArcParams(c)!;
    const u = HALF_WIDTH > CURVATURE_EPS ? gx / HALF_WIDTH : 0;
    const theta = u * arc.halfThetaMax;
    return new Vec3(
        arc.radius * Math.sin(theta),
        -arc.radius * (1 - Math.cos(theta)),
        gz
    );
}

/** 与 `mirrorPlaneGeometryWidth` 一致：网格 X 取反 */
function gridGxMirrored(i: number, segments: number): number {
    const gxRaw = -HALF_WIDTH + (i / segments) * (2 * HALF_WIDTH);
    return -gxRaw;
}

function gridGz(j: number, lengthSegments: number): number {
    return -HALF_HEIGHT + (j / lengthSegments) * (2 * HALF_HEIGHT);
}

/**
 * 射线与弯曲后网格三角形求交（与 `buildBillboardGeometry` 同拓扑，避免解析弧面在旋转/斜视角下全 miss）。
 */
export function intersectRayLocalVideoMesh(
    origin: Vec3,
    dir: Vec3,
    curvature: number
): VideoMeshPickHit | null {
    const segs = VIDEO_CURVED_WIDTH_SEGMENTS;
    const lenSegs = VIDEO_CURVED_LENGTH_SEGMENTS;
    let bestT = Infinity;
    let bestHit: VideoMeshPickHit | null = null;

    const tryTriangle = (
        ax: number,
        ay: number,
        az: number,
        gx0: number,
        gz0: number,
        bx: number,
        by: number,
        bz: number,
        gx1: number,
        gz1: number,
        cx: number,
        cy: number,
        cz: number,
        gx2: number,
        gz2: number
    ) => {
        const e1x = bx - ax;
        const e1y = by - ay;
        const e1z = bz - az;
        const e2x = cx - ax;
        const e2y = cy - ay;
        const e2z = cz - az;
        const px = dir.y * e2z - dir.z * e2y;
        const py = dir.z * e2x - dir.x * e2z;
        const pz = dir.x * e2y - dir.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-7) return;

        const inv = 1 / det;
        const tx = origin.x - ax;
        const ty = origin.y - ay;
        const tz = origin.z - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) return;

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dir.x * qx + dir.y * qy + dir.z * qz) * inv;
        if (v < 0 || u + v > 1) return;

        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t <= 1e-5 || t >= bestT) return;

        const w = 1 - u - v;
        bestT = t;
        bestHit = {
            point: new Vec3(
                origin.x + dir.x * t,
                origin.y + dir.y * t,
                origin.z + dir.z * t
            ),
            gx: gx0 * w + gx1 * u + gx2 * v,
            gz: gz0 * w + gz1 * u + gz2 * v
        };
    };

    const corner = (i: number, j: number) => {
        const gx = gridGxMirrored(i, segs);
        const gz = gridGz(j, lenSegs);
        const p = bentVertexLocal(gx, gz, curvature);
        return { x: p.x, y: p.y, z: p.z, gx, gz };
    };

    for (let i = 0; i < segs; i++) {
        for (let j = 0; j < lenSegs; j++) {
            const p00 = corner(i, j);
            const p10 = corner(i + 1, j);
            const p01 = corner(i, j + 1);
            const p11 = corner(i + 1, j + 1);
            tryTriangle(
                p00.x, p00.y, p00.z, p00.gx, p00.gz,
                p10.x, p10.y, p10.z, p10.gx, p10.gz,
                p11.x, p11.y, p11.z, p11.gx, p11.gz
            );
            tryTriangle(
                p00.x, p00.y, p00.z, p00.gx, p00.gz,
                p11.x, p11.y, p11.z, p11.gx, p11.gz,
                p01.x, p01.y, p01.z, p01.gx, p01.gz
            );
        }
    }

    return bestHit;
}

/**
 * 弧面（或平面）局部命中 → 纹理像素；与 video-controls 中 `(0.5 - lx, 0.5 - lz)` 在曲度 0 时一致。
 */
export function videoArcLocalToTexturePixels(
    lx: number,
    ly: number,
    lz: number,
    curvature: number,
    texW: number,
    texH: number
): { px: number; py: number } | null {
    const arc = getVideoHorizontalArcParams(curvature);
    const gx = arc
        ? (Math.atan2(lx, arc.radius + ly) / arc.halfThetaMax) * HALF_WIDTH
        : lx;
    const px = (0.5 - gx) * texW;
    const py = (0.5 - lz) * texH;
    if (px < -4 || py < -4 || px > texW + 4 || py > texH + 4) return null;
    return { px, py };
}

export function rebuildVideoRenderMesh(entity: Entity, curvature: number): void {
    const render = (entity as unknown as { render?: { meshInstances?: MeshInstance[] } }).render;
    const mi = render?.meshInstances?.[0];
    if (!mi?.mesh) return;

    const device = mi.mesh.device ?? (entity as unknown as { app?: { graphicsDevice?: GraphicsDevice } }).app?.graphicsDevice;
    if (!device) return;

    const oldMesh = mi.mesh;
    mi.mesh = createCurvedBillboardMesh(device, curvature);
    if (oldMesh && oldMesh !== mi.mesh) {
        const app = (entity as unknown as { app?: { once?: (n: string, fn: () => void) => void } }).app;
        const destroyOld = () => {
            try {
                oldMesh.destroy();
            } catch {
                // ignore
            }
        };
        if (app?.once) {
            app.once('frameend', destroyOld);
        } else {
            queueMicrotask(destroyOld);
        }
    }
}
