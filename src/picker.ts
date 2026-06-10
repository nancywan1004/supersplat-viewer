/**
 * World picking for splat scenes (hybrid).
 *
 * - **pick()** / 标注放置：PlayCanvas `Picker(depth=true)` + `getWorldPointAsync`（`DEPTH_PICK`，不改全局 pickPS）。
 * - **pickSurface()** / 手电筒、nav 法线：raster 仍用 alpha 加权深度累加（暗部高斯更稳）；compute 用引擎深度。
 * - Raster 累加的 pickPS 补丁仅在累加 pass 渲染期间临时启用，避免与资产 `pc.Picker` ID 拾取冲突。
 */

import {
    type AppBase,
    type Entity,
    type GSplatComponent,
    type Layer,
    type MeshInstance,
    ADDRESS_CLAMP_TO_EDGE,
    BLENDEQUATION_ADD,
    BLENDMODE_ZERO,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    FILTER_NEAREST,
    GSPLAT_RENDERER_COMPUTE,
    PIXELFORMAT_RGBA16F,
    PROJECTION_ORTHOGRAPHIC,
    Picker as EnginePicker,
    Color,
    Mat4,
    RenderPassPicker,
    RenderTarget,
    ShaderChunks,
    Texture,
    Vec3,
    Vec4,
    BlendState
} from 'playcanvas';
import type { Global } from './types';

// Override global picking to pack alpha-weighted splat depth instead of meshInstance id.
const pickDepthGlsl = /* glsl */ `
vec4 encodePickOutput(uint id) {
    const vec4 inv = vec4(1.0 / 255.0);
    const uvec4 shifts = uvec4(16, 8, 0, 24);
    uvec4 col = (uvec4(id) >> shifts) & uvec4(0xff);
    return vec4(col) * inv;
}

#ifdef GSPLAT_PICK_DEPTH
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform vec4 camera_params; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    vec4 getPickOutput() {
        float normalizedDepth;
        if (camera_params.w > 0.5) {
            normalizedDepth = gl_FragCoord.z;
        } else {
            float linearDepth = 1.0 / gl_FragCoord.w;
            normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
        }

        return vec4(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
    }
#else
    #ifndef PICK_CUSTOM_ID
        uniform uint meshInstanceId;

        vec4 getPickOutput() {
            return encodePickOutput(meshInstanceId);
        }
    #endif
#endif

#ifdef DEPTH_PICK_PASS
    #include "floatAsUintPS"
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform vec4 camera_params; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    vec4 getPickDepth() {
        float linearDepth;
        if (camera_params.w > 0.5) {
            linearDepth = gl_FragCoord.z;
        } else {
            float viewDist = 1.0 / gl_FragCoord.w;
            linearDepth = (viewDist - camera_params.z) / (camera_params.y - camera_params.z);
        }
        return float2uint(linearDepth);
    }
#endif
`;

const pickDepthWgsl = /* wgsl */ `
fn encodePickOutput(id: u32) -> vec4f {
    let inv: vec4f = vec4f(1.0 / 255.0);
    let shifts: vec4u = vec4u(16u, 8u, 0u, 24u);
    let col: vec4u = (vec4u(id) >> shifts) & vec4u(0xffu);
    return vec4f(col) * inv;
}

#ifdef GSPLAT_PICK_DEPTH
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform camera_params: vec4f; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    fn getPickOutput() -> vec4f {
        var normalizedDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            normalizedDepth = pcPosition.z;
        } else {
            let linearDepth = 1.0 / pcPosition.w;
            normalizedDepth = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }

        let a = f32(gaussianColor.a);
        return vec4f(a * normalizedDepth, 0.0, 0.0, a);
    }
#else
    #ifndef PICK_CUSTOM_ID
        uniform meshInstanceId: u32;

        fn getPickOutput() -> vec4f {
            return encodePickOutput(uniform.meshInstanceId);
        }
    #endif
#endif

#ifdef DEPTH_PICK_PASS
    #include "floatAsUintPS"
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform camera_params: vec4f; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    fn getPickDepth() -> vec4f {
        var linearDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            linearDepth = pcPosition.z;
        } else {
            let viewDist = 1.0 / pcPosition.w;
            linearDepth = (viewDist - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }
        return float2uint(linearDepth);
    }
#endif
`;

const pickPassChunkInjected = [
    '#ifdef PICK_PASS',
    '    #define GSPLAT_PICK_DEPTH',
    '    #include "pickPS"',
    '#endif'
].join('\n');

const safeChunkReplace = (s: string, find: string | RegExp, repl: string) => {
    const out = s.replace(find, repl);
    if (out === s) {
        throw new Error('picker: engine gsplat/pick chunk patch failed (engine version mismatch?)');
    }
    return out;
};

const patchGsplatPickGlsl = (chunk: string) => {
    return safeChunkReplace(
        safeChunkReplace(
            chunk,
            /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/,
            pickPassChunkInjected
        ),
        'pcFragColor0 = encodePickOutput(vPickId);',
        'pcFragColor0 = getPickOutput();'
    );
};

const patchGsplatPickWgsl = (chunk: string) => {
    return safeChunkReplace(
        safeChunkReplace(
            chunk,
            /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/,
            pickPassChunkInjected
        ),
        'output.color = encodePickOutput(vPickId);',
        'output.color = getPickOutput();'
    );
};

type PickerShaderPatchState = {
    glslPickPS: string;
    glslGsplatPS: string;
    wgslPickPS: string;
    wgslGsplatPS: string;
    refCount: number;
};

/** Per-device original chunk strings + refcount so we can restore after the last Picker releases. */
const pickerShaderPatchState = new WeakMap<object, PickerShaderPatchState>();

const vec4 = new Vec4();
const viewProjMat = new Mat4();
const clearColor = new Color(0, 0, 0, 1);
const NORMAL_EPSILON = 1e-12;
const NORMAL_DEGENERATE_EPSILON = 1e-20;
// Sampling for the surface-normal estimator runs on a circular footprint of
// fixed *world* radius, projected to pixels at the picked-point's depth.
// Keeping the world area constant means adjacent cursor positions sample
// almost the same world cluster, which stabilises the plane fit. The pixel
// radius is clamped so distant picks still get enough samples and very-close
// picks don't blow the block read.
const NORMAL_SAMPLE_WORLD_RADIUS = 0.2;
const NORMAL_SAMPLE_MIN_PX = 6;
const NORMAL_SAMPLE_MAX_PX = 48;
const NORMAL_RING_FRACTIONS = [0.3, 0.55, 0.8, 1.0];
const NORMAL_OUTLIER_THRESHOLD = 2.5;
const NORMAL_SAMPLE_DIRECTIONS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1]
] as const;

/** pick 深度累加有效 alpha 下限（暗部叶/高斯在 1e-6~1e-5 下易被整像素丢弃） */
const PICK_SURFACE_MIN_ALPHA = 2e-5;
/** 中心像素有效时，只在小圆形邻域内找明显更近的前景，避免边缘处吃到旁边物体。 */
const PICK_NEAREST_INNER_RADIUS_PX = 2;
/** 中心像素无效时，放大搜索范围作为兜底。 */
const PICK_NEAREST_FALLBACK_RADIUS_PX = 5;
/** 邻域候选必须比中心深度明显更近才替代中心，过滤半透明噪声与边缘误抢。 */
const PICK_NEAREST_FRONT_DELTA_M = 0.12;
const PICK_NEAREST_FRONT_DELTA_RATIO = 0.015;
/** 近处候选必须在邻域内形成稳定小簇，避免单个前景尾部像素抢走后景墙面。 */
const PICK_NEAREST_MIN_SUPPORT = 3;
const PICK_NEAREST_MIN_SUPPORT_RATIO = 0.32;
const PICK_NEAREST_CLUSTER_TOLERANCE_M = 0.25;
const PICK_NEAREST_CLUSTER_TOLERANCE_RATIO = 0.035;

type PickSurface = {
    /** 推荐给通用调用方的表面点；优先中心深度，中心无效/低可信时才由稳定邻域接管。 */
    position: Vec3;
    /** 光标中心像素的 alpha 加权深度（中心无效时为空）。 */
    centerPosition?: Vec3;
    /**
     * 光标邻域内**最近**有效表面（相机距离最小）。
     * 半透明/很暗的高斯在中心像素 alpha 低时，加权深度易落到后方；手电筒等跟手拾取应优先用此字段。
     */
    nearestPosition?: Vec3;
    /** 与 position 相同的显式推荐点，便于调用方不再猜 position / nearestPosition 的语义。 */
    preferredPosition?: Vec3;
    /** 中心像素累积 alpha；compute 路径中心有效时记为 1，无中心命中记为 0。 */
    centerAlpha?: number;
    /** 邻域最近候选附近的支持样本数。 */
    nearestSupport?: number;
    /** 本次邻域参与评估的有效样本数。 */
    sampleCount?: number;
    /** 推荐点来源。 */
    source?: 'center' | 'nearest';
    normal: Vec3;
};

type RasterSurfaceSample = {
    position: Vec3;
    alpha: number;
};

type PickCameraSnapshot = {
    position: Vec3;
    viewMatrix: Mat4;
    projectionMatrix: Mat4;
    nearClip: number;
    farClip: number;
    projection: number;
};

type PickPosition = {
    position: Vec3;
    camera: PickCameraSnapshot;
    screenX: number;
    screenY: number;
    width: number;
    height: number;
    isComputeRenderer: boolean;
};

export type PickerDepthMap = {
    texture: Texture;
    width: number;
    height: number;
    camera: PickCameraSnapshot;
};

// Shared buffer for half-to-float conversion
const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

// Convert 16-bit half-float to 32-bit float using bit manipulation.
const half2Float = (h: number): number => {
    const sign = (h & 0x8000) << 16;
    const exponent = (h & 0x7C00) >> 10;
    const mantissa = h & 0x03FF;

    if (exponent === 0) {
        if (mantissa === 0) {
            uint32[0] = sign;
        } else {
            let e = -1;
            let m = mantissa;
            do {
                e++;
                m <<= 1;
            } while ((m & 0x0400) === 0);
            uint32[0] = sign | ((127 - 15 - e) << 23) | ((m & 0x03FF) << 13);
        }
    } else if (exponent === 31) {
        uint32[0] = sign | 0x7F800000 | (mantissa << 13);
    } else {
        uint32[0] = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
    }

    return float32[0];
};

const registerPickerShaderPatches = (app: AppBase) => {
    const device = app.graphicsDevice;
    const existing = pickerShaderPatchState.get(device);
    if (existing) {
        existing.refCount++;
        return;
    }

    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');

    const glslPickPS = glslChunks.get('pickPS');
    const glslGsplatPS = glslChunks.get('gsplatPS');
    const wgslPickPS = wgslChunks.get('pickPS');
    const wgslGsplatPS = wgslChunks.get('gsplatPS');

    // Patch strings before mutating ShaderChunks so engine mismatches leave globals untouched.
    const patchedGlslGsplatPS = patchGsplatPickGlsl(glslGsplatPS);
    const patchedWgslGsplatPS = patchGsplatPickWgsl(wgslGsplatPS);

    const state: PickerShaderPatchState = {
        glslPickPS,
        glslGsplatPS,
        wgslPickPS,
        wgslGsplatPS,
        refCount: 1
    };
    pickerShaderPatchState.set(device, state);

    glslChunks.set('pickPS', pickDepthGlsl);
    wgslChunks.set('pickPS', pickDepthWgsl);
    glslChunks.set('gsplatPS', patchedGlslGsplatPS);
    wgslChunks.set('gsplatPS', patchedWgslGsplatPS);
};

const unregisterPickerShaderPatches = (app: AppBase) => {
    const device = app.graphicsDevice;
    const state = pickerShaderPatchState.get(device);
    if (!state) {
        return;
    }
    state.refCount--;
    if (state.refCount > 0) {
        return;
    }

    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');
    glslChunks.set('pickPS', state.glslPickPS);
    glslChunks.set('gsplatPS', state.glslGsplatPS);
    wgslChunks.set('pickPS', state.wgslPickPS);
    wgslChunks.set('gsplatPS', state.wgslGsplatPS);
    pickerShaderPatchState.delete(device);
};

const ensureComputePickIdsReady = (app: AppBase, camera: Entity, worldLayer: Layer) => {
    const gsplatScene = app.scene.gsplat;
    if (gsplatScene.currentRenderer !== GSPLAT_RENDERER_COMPUTE) {
        return;
    }

    if (!gsplatScene.enableIds) {
        gsplatScene.enableIds = true;
    }

    const director = (app.renderer as unknown as {
        gsplatDirector?: {
            camerasMap?: Map<unknown, {
                layersMap?: Map<unknown, {
                    gsplatManager?: {
                        handleFormatChange?: () => void;
                        workBuffer?: { syncWithFormat?: () => void };
                        update?: () => void;
                    };
                }>;
            }>;
        };
    }).gsplatDirector;
    const manager = director?.camerasMap?.get(camera.camera)?.layersMap?.get(worldLayer)?.gsplatManager;
    if (!manager) {
        return;
    }

    manager.handleFormatChange?.();
    manager.workBuffer?.syncWithFormat?.();
    manager.update?.();
};

const createPickCameraSnapshot = (): PickCameraSnapshot => ({
    position: new Vec3(),
    viewMatrix: new Mat4(),
    projectionMatrix: new Mat4(),
    nearClip: 0,
    farClip: 0,
    projection: 0
});

const captureCameraSnapshot = (camera: Entity, out: PickCameraSnapshot) => {
    const cam = camera.camera;
    out.position.copy(camera.getPosition());
    out.viewMatrix.copy(cam.viewMatrix);
    out.projectionMatrix.copy(cam.projectionMatrix);
    out.nearClip = cam.nearClip;
    out.farClip = cam.farClip;
    out.projection = cam.projection;
};

const getWorldPoint = (camera: PickCameraSnapshot, x: number, y: number, width: number, height: number, normalizedDepth: number, out?: Vec3) => {
    if (!Number.isFinite(normalizedDepth) || normalizedDepth < 0 || normalizedDepth > 1) {
        return null;
    }

    const { farClip: far, nearClip: near } = camera;
    const ndcDepth = camera.projection === PROJECTION_ORTHOGRAPHIC ?
        normalizedDepth :
        far * normalizedDepth / (normalizedDepth * (far - near) + near);

    viewProjMat.mul2(camera.projectionMatrix, camera.viewMatrix).invert();
    vec4.set(x / width * 2 - 1, (1 - y / height) * 2 - 1, ndcDepth * 2 - 1, 1);
    viewProjMat.transformVec4(vec4, vec4);
    if (!Number.isFinite(vec4.w) || Math.abs(vec4.w) < 1e-8) {
        return null;
    }

    vec4.mulScalar(1 / vec4.w);
    if (!Number.isFinite(vec4.x) || !Number.isFinite(vec4.y) || !Number.isFinite(vec4.z)) {
        return null;
    }

    return (out ?? new Vec3()).set(vec4.x, vec4.y, vec4.z);
};

const setCameraFacingNormal = (cameraPosition: Vec3, position: Vec3, normal: Vec3) => {
    normal.sub2(cameraPosition, position);
    const len = normal.length();
    if (len > 1e-6) {
        normal.mulScalar(1 / len);
    } else {
        normal.set(0, 1, 0);
    }

    return normal;
};

const distanceSqTo = (a: Vec3, b: Vec3): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
};

const resolveSurfaceNearestPosition = (
    center: Vec3 | null,
    nearest: Vec3 | null,
    cameraPosition: Vec3,
    nearestSupport: number,
    totalSamples: number
): Vec3 | null => {
    if (!center) return nearest;
    if (!nearest) return center;
    const centerDistSq = distanceSqTo(center, cameraPosition);
    const nearestDistSq = distanceSqTo(nearest, cameraPosition);
    if (nearestDistSq >= centerDistSq) return center;

    const centerDist = Math.sqrt(centerDistSq);
    const nearestDist = Math.sqrt(nearestDistSq);
    const minDelta = Math.max(PICK_NEAREST_FRONT_DELTA_M, centerDist * PICK_NEAREST_FRONT_DELTA_RATIO);
    const minSupport = Math.max(
        PICK_NEAREST_MIN_SUPPORT,
        Math.ceil(totalSamples * PICK_NEAREST_MIN_SUPPORT_RATIO)
    );
    if (nearestSupport < minSupport) return center;
    return centerDist - nearestDist > minDelta ? nearest : center;
};

type PlaneFit = {
    cx: number; cy: number; cz: number;
    vx: number; vy: number; vz: number;
};

// Project a world-space radius around `pos` to its on-screen pixel radius for
// the given camera. Uses the projection matrix's [1][1] entry (= 1/tan(fov/2)
// for perspective, = 1/orthoHeight for orthographic) so we don't need fov or
// orthoHeight on the snapshot.
const worldRadiusToPixelRadius = (cam: PickCameraSnapshot, pos: Vec3, canvasHeight: number, worldRadius: number): number => {
    const projY = cam.projectionMatrix.data[5];
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        return worldRadius * projY * canvasHeight / 2;
    }
    const dx = pos.x - cam.position.x;
    const dy = pos.y - cam.position.y;
    const dz = pos.z - cam.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-6) return Infinity;
    return worldRadius * projY * canvasHeight / (2 * distance);
};

// Single least-squares plane fit through a cluster of 3D points. The normal
// is the eigenvector of the smallest eigenvalue of the points' 3x3 covariance
// matrix, computed in closed form (analytic eigendecomposition for 3x3
// symmetric, Smith 1961). Returns null on degenerate input.
const fitPlaneOnce = (points: Vec3[]): PlaneFit | null => {
    const n = points.length;
    if (n < 3) return null;

    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += points[i].x; cy += points[i].y; cz += points[i].z;
    }
    cx /= n; cy /= n; cz /= n;

    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (let i = 0; i < n; i++) {
        const dx = points[i].x - cx;
        const dy = points[i].y - cy;
        const dz = points[i].z - cz;
        cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
        cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
    }

    const q = (cxx + cyy + czz) / 3;
    const a = cxx - q, b = cyy - q, c = czz - q;
    const p2 = a * a + b * b + c * c + 2 * (cxy * cxy + cxz * cxz + cyz * cyz);
    if (p2 < NORMAL_DEGENERATE_EPSILON) return null;
    const p = Math.sqrt(p2 / 6);
    const inv = 1 / p;
    const Bxx = a * inv, Bxy = cxy * inv, Bxz = cxz * inv;
    const Byy = b * inv, Byz = cyz * inv, Bzz = c * inv;
    const detB = Bxx * (Byy * Bzz - Byz * Byz) -
                 Bxy * (Bxy * Bzz - Byz * Bxz) +
                 Bxz * (Bxy * Byz - Byy * Bxz);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const lambdaMin = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);

    const Mxx = cxx - lambdaMin, Myy = cyy - lambdaMin, Mzz = czz - lambdaMin;
    const v1x = cxy * cyz - cxz * Myy;
    const v1y = cxz * cxy - Mxx * cyz;
    const v1z = Mxx * Myy - cxy * cxy;
    const v2x = cxy * Mzz - cxz * cyz;
    const v2y = cxz * cxz - Mxx * Mzz;
    const v2z = Mxx * cyz - cxy * cxz;
    const v3x = Myy * Mzz - cyz * cyz;
    const v3y = cyz * cxz - cxy * Mzz;
    const v3z = cxy * cyz - Myy * cxz;
    const l1 = v1x * v1x + v1y * v1y + v1z * v1z;
    const l2 = v2x * v2x + v2y * v2y + v2z * v2z;
    const l3 = v3x * v3x + v3y * v3y + v3z * v3z;
    let vx: number, vy: number, vz: number, lSq: number;
    if (l1 >= l2 && l1 >= l3) {
        vx = v1x; vy = v1y; vz = v1z; lSq = l1;
    } else if (l2 >= l3) {
        vx = v2x; vy = v2y; vz = v2z; lSq = l2;
    } else {
        vx = v3x; vy = v3y; vz = v3z; lSq = l3;
    }
    if (lSq < NORMAL_EPSILON) return null;
    const invLen = 1 / Math.sqrt(lSq);
    return { cx, cy, cz, vx: vx * invLen, vy: vy * invLen, vz: vz * invLen };
};

// Two-pass plane fit: first pass on all points, then drop points whose
// distance from the fitted plane exceeds NORMAL_OUTLIER_THRESHOLD * the mean
// residual, refit on the inliers. Sign-flips the result toward toCamera so
// the cursor's tangent basis stays consistent. Returns false on degenerate
// input (fewer than 3 points, collinear/coincident samples).
const fitPlaneNormal = (points: Vec3[], toCamera: Vec3, outNormal: Vec3): boolean => {
    const first = fitPlaneOnce(points);
    if (!first) return false;

    let residualSum = 0;
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - first.cx;
        const dy = points[i].y - first.cy;
        const dz = points[i].z - first.cz;
        residualSum += Math.abs(dx * first.vx + dy * first.vy + dz * first.vz);
    }
    const threshold = (residualSum / points.length) * NORMAL_OUTLIER_THRESHOLD;

    const inliers: Vec3[] = [];
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - first.cx;
        const dy = points[i].y - first.cy;
        const dz = points[i].z - first.cz;
        if (Math.abs(dx * first.vx + dy * first.vy + dz * first.vz) <= threshold) {
            inliers.push(points[i]);
        }
    }

    let result = first;
    if (inliers.length >= 3 && inliers.length < points.length) {
        const refined = fitPlaneOnce(inliers);
        if (refined) result = refined;
    }

    let { vx, vy, vz } = result;
    if (vx * toCamera.x + vy * toCamera.y + vz * toCamera.z < 0) {
        vx = -vx; vy = -vy; vz = -vz;
    }
    outNormal.set(vx, vy, vz);
    return true;
};

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;

    pickSurface: (x: number, y: number) => Promise<PickSurface | null>;

    prepareDepthMap: () => PickerDepthMap | null;

    release: () => void;

    constructor(app: AppBase, camera: Entity) {
        const { graphicsDevice } = app;

        let enginePicker: EnginePicker | undefined;
        let accumBuffer: Texture;
        let accumTarget: RenderTarget;
        let accumPass: RenderPassPicker;
        let pickQueue = Promise.resolve();
        let rasterCacheValid = false;
        let engineCacheValid = false;
        let rasterCacheWidth = 0;
        let rasterCacheHeight = 0;
        let engineCacheWidth = 0;
        let engineCacheHeight = 0;
        let rasterCacheRenderVersion = -1;
        let engineCacheRenderVersion = -1;
        let sceneRenderVersion = 0;
        const rasterCacheCamera: PickCameraSnapshot = createPickCameraSnapshot();
        const engineCacheCamera: PickCameraSnapshot = createPickCameraSnapshot();
        const onFrameEnd = () => {
            sceneRenderVersion++;
        };
        app.on('frameend', onFrameEnd);

        const initRasterAccum = (width: number, height: number) => {
            accumBuffer = new Texture(graphicsDevice, {
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                name: 'picker-accum'
            });

            accumTarget = new RenderTarget({
                colorBuffer: accumBuffer,
                depth: false // not needed — gaussians are rendered back to front
            });

            accumPass = new RenderPassPicker(graphicsDevice, app.renderer);
            // RGB: additive depth accumulation. Alpha: multiplicative transmittance.
            accumPass.blendState = new BlendState(
                true,
                BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,
                BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA
            );
        };

        const readTexture = <T extends Uint8Array | Uint16Array>(
            texture: Texture,
            x: number,
            y: number,
            target: RenderTarget
        ): Promise<T> => {
            const texY = graphicsDevice.isWebGL2 ? target.height - y - 1 : y;

            return texture.read(x, texY, 1, 1, {
                renderTarget: target,
                immediate: true
            }) as Promise<T>;
        };

        const snapshotMatches = (
            cacheCamera: PickCameraSnapshot,
            cacheWidth: number,
            cacheHeight: number,
            cacheRenderVersion: number,
            width: number,
            height: number
        ) => {
            const cam = camera.camera;
            return cacheWidth === width &&
                cacheHeight === height &&
                cacheRenderVersion === sceneRenderVersion &&
                cacheCamera.viewMatrix.equals(cam.viewMatrix) &&
                cacheCamera.projectionMatrix.equals(cam.projectionMatrix) &&
                cacheCamera.nearClip === cam.nearClip &&
                cacheCamera.farClip === cam.farClip &&
                cacheCamera.projection === cam.projection;
        };

        const withShadowMaskPickScope = (run: () => void) => {
            const shadowMaskCameraEntity = app.root.findByName('shadowMaskCamera') as Entity | null;
            const shadowMaskCameraWasEnabled = shadowMaskCameraEntity?.enabled === true;
            if (shadowMaskCameraWasEnabled && shadowMaskCameraEntity) {
                shadowMaskCameraEntity.enabled = false;
            }
            try {
                run();
            } finally {
                if (shadowMaskCameraWasEnabled && shadowMaskCameraEntity) {
                    shadowMaskCameraEntity.enabled = true;
                }
            }
        };

        const cloneCameraSnapshot = (source: PickCameraSnapshot): PickCameraSnapshot => {
            const snapshot = createPickCameraSnapshot();
            snapshot.position.copy(source.position);
            snapshot.viewMatrix.copy(source.viewMatrix);
            snapshot.projectionMatrix.copy(source.projectionMatrix);
            snapshot.nearClip = source.nearClip;
            snapshot.farClip = source.farClip;
            snapshot.projection = source.projection;
            return snapshot;
        };

        const readRasterBlock = async (
            blockX: number,
            blockY: number,
            blockWidth: number,
            blockHeight: number,
            viewportWidth: number,
            viewportHeight: number,
            pickCamera: PickCameraSnapshot
        ): Promise<(x: number, y: number) => RasterSurfaceSample | null> => {
            const texY = graphicsDevice.isWebGL2 ? accumTarget.height - blockY - blockHeight : blockY;

            const pixels = await accumBuffer.read(blockX, texY, blockWidth, blockHeight, {
                renderTarget: accumTarget,
                immediate: true
            }) as Uint16Array;

            return (x: number, y: number) => {
                const localX = x - blockX;
                const localY = y - blockY;
                if (localX < 0 || localX >= blockWidth || localY < 0 || localY >= blockHeight) {
                    return null;
                }

                const row = graphicsDevice.isWebGL2 ? blockHeight - localY - 1 : localY;
                const index = (row * blockWidth + localX) * 4;
                const r = half2Float(pixels[index]);
                const transmittance = half2Float(pixels[index + 3]);
                const alpha = 1 - transmittance;

                if (!Number.isFinite(r) || !Number.isFinite(alpha) || alpha < PICK_SURFACE_MIN_ALPHA) {
                    return null;
                }

                const normalizedDepth = r / alpha;
                const position = getWorldPoint(pickCamera, x, y, viewportWidth, viewportHeight, normalizedDepth);
                return position ? { position, alpha } : null;
            };
        };

        const ensureEngineDepthRendered = (width: number, height: number, worldLayer: Layer) => {
            if (engineCacheValid && snapshotMatches(engineCacheCamera, engineCacheWidth, engineCacheHeight, engineCacheRenderVersion, width, height)) {
                return;
            }
            withShadowMaskPickScope(() => {
                enginePicker ??= new EnginePicker(app, width, height, true);
                enginePicker.resize(width, height);
                ensureComputePickIdsReady(app, camera, worldLayer);
                enginePicker.prepare(camera.camera, app.scene, [worldLayer]);
            });
            captureCameraSnapshot(camera, engineCacheCamera);
            engineCacheWidth = width;
            engineCacheHeight = height;
            engineCacheRenderVersion = sceneRenderVersion;
            engineCacheValid = true;
        };

        const ensureRasterAccumRendered = (width: number, height: number, worldLayer: Layer) => {
            if (rasterCacheValid && snapshotMatches(rasterCacheCamera, rasterCacheWidth, rasterCacheHeight, rasterCacheRenderVersion, width, height)) {
                return;
            }

            const prevEnableIds = app.scene.gsplat.enableIds;
            app.scene.gsplat.enableIds = true;
            try {
                withShadowMaskPickScope(() => {
                    registerPickerShaderPatches(app);
                    try {
                        if (!accumPass) {
                            initRasterAccum(width, height);
                        } else if (rasterCacheWidth !== width || rasterCacheHeight !== height) {
                            accumTarget.resize(width, height);
                        }

                        accumPass.init(accumTarget);
                        accumPass.setClearColor(clearColor);
                        accumPass.update(
                            camera.camera,
                            app.scene,
                            [worldLayer],
                            new Map<number, MeshInstance | GSplatComponent>(),
                            false
                        );
                        accumPass.render();
                    } finally {
                        unregisterPickerShaderPatches(app);
                    }
                });
            } finally {
                app.scene.gsplat.enableIds = prevEnableIds;
            }

            captureCameraSnapshot(camera, rasterCacheCamera);
            rasterCacheWidth = width;
            rasterCacheHeight = height;
            rasterCacheRenderVersion = sceneRenderVersion;
            rasterCacheValid = true;
        };

        const prepareSample = (x: number, y: number) => {
            const width = Math.floor(graphicsDevice.width);
            const height = Math.floor(graphicsDevice.height);

            // bail out if the device hasn't been sized yet
            if (width <= 0 || height <= 0) {
                return null;
            }

            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }

            const isComputeRenderer = app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE;
            const canvas = graphicsDevice.canvas as HTMLCanvasElement | undefined;
            // 保持本地既有语义：compute 路径按 client 尺寸采样，避免 CSS 缩放 / DPR 下坐标漂移。
            const pickWidth = isComputeRenderer ? Math.floor(canvas?.clientWidth || width) : width;
            const pickHeight = isComputeRenderer ? Math.floor(canvas?.clientHeight || height) : height;
            if (pickWidth <= 0 || pickHeight <= 0) {
                return null;
            }
            const screenX = Math.min(pickWidth - 1, Math.max(0, Math.floor(x * pickWidth)));
            const screenY = Math.min(pickHeight - 1, Math.max(0, Math.floor(y * pickHeight)));

            return {
                width: pickWidth,
                height: pickHeight,
                screenX,
                screenY,
                isComputeRenderer,
                worldLayer
            };
        };

        const prepareDepthMap = (): PickerDepthMap | null => {
            const width = Math.floor(graphicsDevice.width);
            const height = Math.floor(graphicsDevice.height);
            if (width <= 0 || height <= 0) {
                return null;
            }

            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }

            const isComputeRenderer = app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE;
            // The compute renderer's depth path is owned by the engine picker and is not exposed as
            // a reusable texture here. Raster gsplat scenes use our accum target directly.
            if (isComputeRenderer) {
                return null;
            }

            ensureRasterAccumRendered(width, height, worldLayer);
            return {
                texture: accumBuffer,
                width,
                height,
                camera: cloneCameraSnapshot(rasterCacheCamera)
            };
        };

        const serializePick = <T>(operation: () => Promise<T>): Promise<T> => {
            // The render targets are shared by all picks on this instance.
            const result = pickQueue.then(operation, operation);
            pickQueue = result.then((): void => undefined, (): void => undefined);
            return result;
        };

        const pick = async (x: number, y: number) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, worldLayer } = sample;
            ensureEngineDepthRendered(width, height, worldLayer);
            return enginePicker!.getWorldPointAsync(screenX, screenY);
        };

        const pickSurface = async (x: number, y: number) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, isComputeRenderer, worldLayer } = sample;

            if (isComputeRenderer) {
                ensureEngineDepthRendered(width, height, worldLayer);
                const pickCamera = cloneCameraSnapshot(engineCacheCamera);
                const normalizedDepth = await enginePicker!.getPointDepthAsync(screenX, screenY);
                const centerPosition = normalizedDepth !== null ?
                    getWorldPoint(pickCamera, screenX, screenY, width, height, normalizedDepth) :
                    null;
                let nearestPosition: Vec3 | null = centerPosition;
                let nearestDist = centerPosition ? Math.sqrt(distanceSqTo(centerPosition, pickCamera.position)) : Infinity;
                const sampleDistances: number[] = [];
                const camPos = pickCamera.position;
                const nearestR = centerPosition ? PICK_NEAREST_INNER_RADIUS_PX : PICK_NEAREST_FALLBACK_RADIUS_PX;
                for (let py = screenY - nearestR; py <= screenY + nearestR; py++) {
                    for (let px = screenX - nearestR; px <= screenX + nearestR; px++) {
                        if (px < 0 || px >= width || py < 0 || py >= height) continue;
                        const ox = px - screenX;
                        const oy = py - screenY;
                        if (ox * ox + oy * oy > nearestR * nearestR) continue;
                        const pt = await enginePicker!.getWorldPointAsync(px, py);
                        if (!pt) continue;
                        const dist = Math.sqrt(distanceSqTo(pt, camPos));
                        sampleDistances.push(dist);
                        if (dist < nearestDist) {
                            nearestDist = dist;
                            nearestPosition = pt;
                        }
                    }
                }
                const clusterTolerance = Math.max(
                    PICK_NEAREST_CLUSTER_TOLERANCE_M,
                    nearestDist * PICK_NEAREST_CLUSTER_TOLERANCE_RATIO
                );
                const nearestSupport = Number.isFinite(nearestDist)
                    ? sampleDistances.filter(dist => dist <= nearestDist + clusterTolerance).length
                    : 0;
                const preferredPosition = resolveSurfaceNearestPosition(
                    centerPosition,
                    nearestPosition,
                    camPos,
                    nearestSupport,
                    sampleDistances.length
                );
                if (!preferredPosition) {
                    return null;
                }
                const source: PickSurface['source'] = preferredPosition === centerPosition ? 'center' : 'nearest';
                return {
                    position: preferredPosition,
                    centerPosition: centerPosition ?? undefined,
                    nearestPosition: nearestPosition ?? preferredPosition,
                    preferredPosition,
                    centerAlpha: centerPosition ? 1 : 0,
                    nearestSupport,
                    sampleCount: sampleDistances.length,
                    source,
                    normal: new Vec3(0, 1, 0)
                };
            }

            ensureRasterAccumRendered(width, height, worldLayer);
            const pickCamera = cloneCameraSnapshot(rasterCacheCamera);

            // Single block read serves both depth (center pixel) and normal
            // samples. Sized to the maximum possible ring pixel-radius so the
            // dynamic ring offsets always lie inside the buffer we read.
            const blockX = Math.max(0, screenX - NORMAL_SAMPLE_MAX_PX);
            const blockY = Math.max(0, screenY - NORMAL_SAMPLE_MAX_PX);
            const blockWidth = Math.min(width - 1, screenX + NORMAL_SAMPLE_MAX_PX) - blockX + 1;
            const blockHeight = Math.min(height - 1, screenY + NORMAL_SAMPLE_MAX_PX) - blockY + 1;
            const rasterBlock = await readRasterBlock(
                blockX,
                blockY,
                blockWidth,
                blockHeight,
                width,
                height,
                pickCamera
            );

            const centerSample = rasterBlock(screenX, screenY);
            const centerPosition = centerSample?.position ?? null;
            const centerAlpha = centerSample?.alpha ?? 0;
            let nearestPosition: Vec3 | null = centerPosition;
            let nearestDist = centerPosition ? Math.sqrt(distanceSqTo(centerPosition, pickCamera.position)) : Infinity;
            const sampleDistances: number[] = [];
            const camPos = pickCamera.position;
            const nearestR = centerPosition ? PICK_NEAREST_INNER_RADIUS_PX : PICK_NEAREST_FALLBACK_RADIUS_PX;
            for (let py = screenY - nearestR; py <= screenY + nearestR; py++) {
                for (let px = screenX - nearestR; px <= screenX + nearestR; px++) {
                    if (px < 0 || px >= width || py < 0 || py >= height) continue;
                    const ox = px - screenX;
                    const oy = py - screenY;
                    if (ox * ox + oy * oy > nearestR * nearestR) continue;
                    const pt = rasterBlock(px, py);
                    if (!pt) continue;
                    const dist = Math.sqrt(distanceSqTo(pt.position, camPos));
                    sampleDistances.push(dist);
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        nearestPosition = pt.position;
                    }
                }
            }
            const clusterTolerance = Math.max(
                PICK_NEAREST_CLUSTER_TOLERANCE_M,
                nearestDist * PICK_NEAREST_CLUSTER_TOLERANCE_RATIO
            );
            const nearestSupport = Number.isFinite(nearestDist)
                ? sampleDistances.filter(dist => dist <= nearestDist + clusterTolerance).length
                : 0;
            const preferredPosition = resolveSurfaceNearestPosition(
                centerPosition,
                nearestPosition,
                camPos,
                nearestSupport,
                sampleDistances.length
            );

            if (!preferredPosition) {
                return null;
            }

            const samplePixel = (px: number, py: number) => {
                if (px < 0 || px >= width || py < 0 || py >= height) {
                    return null;
                }
                return rasterBlock(px, py)?.position ?? null;
            };

            // Pixel radius corresponding to a fixed world radius at the
            // picked-point's depth. Clamped so distant picks still sample
            // enough pixels and very-close picks stay inside the block read.
            const pixelRadius = Math.max(NORMAL_SAMPLE_MIN_PX,
                Math.min(NORMAL_SAMPLE_MAX_PX,
                    worldRadiusToPixelRadius(pickCamera, preferredPosition, height, NORMAL_SAMPLE_WORLD_RADIUS)));
            const ringPixelRadii = NORMAL_RING_FRACTIONS.map(f => Math.max(1, Math.round(f * pixelRadius)));
            const sampleRings = ringPixelRadii.map((radius) => {
                return NORMAL_SAMPLE_DIRECTIONS.map(([dx, dy]) => {
                    return samplePixel(screenX + dx * radius, screenY + dy * radius);
                });
            });

            const anchorPos = preferredPosition;
            const toCamera = setCameraFacingNormal(pickCamera.position, anchorPos, new Vec3());

            // Collect every valid 3D sample: the picked position plus all ring
            // samples that didn't fall off-screen or fail the depth read.
            const fitPoints: Vec3[] = [anchorPos];
            for (let i = 0; i < sampleRings.length; i++) {
                const ring = sampleRings[i];
                for (let j = 0; j < ring.length; j++) {
                    const pt = ring[j];
                    if (pt) fitPoints.push(pt);
                }
            }

            const normal = new Vec3();
            if (!fitPlaneNormal(fitPoints, toCamera, normal)) {
                normal.copy(toCamera);
            }

            const source: PickSurface['source'] = preferredPosition === centerPosition ? 'center' : 'nearest';
            return {
                position: preferredPosition,
                centerPosition: centerPosition ?? undefined,
                nearestPosition: nearestPosition ?? preferredPosition,
                preferredPosition,
                centerAlpha,
                nearestSupport,
                sampleCount: sampleDistances.length,
                source,
                normal
            };
        };

        this.pick = (x: number, y: number) => serializePick(() => pick(x, y));

        this.pickSurface = (x: number, y: number) => serializePick(() => pickSurface(x, y));

        this.prepareDepthMap = prepareDepthMap;

        this.release = () => {
            app.off('frameend', onFrameEnd);
            unregisterPickerShaderPatches(app);
            enginePicker?.destroy();
            accumPass?.destroy();
            accumTarget?.destroy();
            accumBuffer?.destroy();
            rasterCacheValid = false;
            engineCacheValid = false;
        };
    }
}

export type { PickSurface, PickCameraSnapshot };

function getSharedPicker(global: Global): Picker {
    if (!global.picker) {
        global.picker = new Picker(global.app, global.camera);
    }
    return global.picker;
}

async function pickWorldFromClientXY(global: Global, clientX: number, clientY: number): Promise<Vec3 | null> {
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const rw = rect.width;
    const rh = rect.height;
    if (rw <= 0 || rh <= 0) return null;

    const nx = (clientX - rect.left) / rw;
    const ny = (clientY - rect.top) / rh;

    return getSharedPicker(global).pick(nx, ny);
}

export { Picker, getSharedPicker, getWorldPoint, captureCameraSnapshot, pickWorldFromClientXY };
