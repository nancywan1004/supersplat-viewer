import {
    type Entity,
    type GraphicsDevice,
    Mesh,
    MeshInstance,
    PlaneGeometry,
    Vec2
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

export function rebuildVideoRenderMesh(entity: Entity, curvature: number): void {
    const render = (entity as unknown as { render?: { meshInstances?: MeshInstance[] } }).render;
    const mi = render?.meshInstances?.[0];
    if (!mi?.mesh) return;

    const device = mi.mesh.device ?? (entity as unknown as { app?: { graphicsDevice?: GraphicsDevice } }).app?.graphicsDevice;
    if (!device) return;

    const oldMesh = mi.mesh;
    mi.mesh = createCurvedBillboardMesh(device, curvature);
    if (oldMesh && oldMesh !== mi.mesh) {
        try {
            oldMesh.destroy();
        } catch {
            // ignore
        }
    }
}
