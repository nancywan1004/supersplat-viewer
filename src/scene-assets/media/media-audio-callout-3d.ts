/**
 * 音频 callout：与 Annotation 相同的热区深度方案（HotspotBase depthTest + HotspotOverlay 半透明）。
 * 视觉在 3D 纹理上绘制，参与深度缓冲，可被 gsplat 遮挡。
 */

import {
    type AppBase,
    type CameraComponent,
    Entity,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    BlendState,
    BLEND_NONE,
    Color,
    CULLFACE_NONE,
    FILTER_LINEAR,
    Layer,
    Mesh,
    MeshInstance,
    PIXELFORMAT_RGBA8,
    PlaneGeometry,
    StandardMaterial,
    Texture,
    Vec3,
    type Quat
} from 'playcanvas';

import { hitSceneGizmoAtClient } from '../../gizmo-handler';
import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import { getSceneAssetPickLayer } from '../scene-asset-pick-layer';
import {
    ensureScenePlacedMediaRuntime,
    getPlacedMediaRuntime,
    type PlacedAudioRuntime
} from './media-runtime';

/** 与 Annotation 相同的 near/far 顶点夹紧，避免热点被裁切 */
const depthClampGlsl = `
    float f = gl_Position.z / gl_Position.w;
    if (f > 1.0) {
        gl_Position.z = gl_Position.w;
    } else if (f < -1.0) {
        gl_Position.z = -gl_Position.w;
    }
`;

const depthClampWgsl = `
    let f = output.position.z / output.position.w;
    if (f > 1.0) {
        output.position.z = output.position.w;
    } else if (f < -1.0) {
        output.position.z = -output.position.w;
    }
`;

const PROJ_VEC = new Vec3();
const OVERLAY_OPACITY = 0.25;

export const AUDIO_CALLOUT_TEX_W = 512;

const AUDIO_PLAY_ICON_URL = '/assets/icons/audio-play.svg';
const AUDIO_PAUSE_ICON_URL = '/assets/icons/audio-pause.svg';

/** 设计稿 tooltip 尺寸（纹理像素） */
export const AUDIO_TOOLTIP_TEX_W = 141;
export const AUDIO_TOOLTIP_TEX_H = 45;

/** 与 `.pc-annotation` tooltip 样式一致 */
const TOOLTIP_FONT =
    '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const TOOLTIP_PAD_X = 14;
const TOOLTIP_PAD_Y = 10;
const TOOLTIP_RADIUS = 4;
const TOOLTIP_LINE_H = 16;
const TOOLTIP_BORDER = 'rgba(0, 191, 255, 0.41)';

/** SVG 原尺寸 32×34，纹理上约 2× 绘制 */
const PLAY_ICON_W = 64;
const PLAY_ICON_H = 68;
const PLAY_HIT_PAD = 10;
const LABEL_TOP = 14;
const LABEL_PLAY_GAP = 10;

/** tooltip + 间距 + 播放钮 + 底边距 */
export const AUDIO_CALLOUT_TEX_H = LABEL_TOP + AUDIO_TOOLTIP_TEX_H + LABEL_PLAY_GAP + PLAY_ICON_H + 12;
/** 世界空间高度（米） */
export const AUDIO_CALLOUT_WORLD_H = 1.0;

type AudioCalloutLayout = {
    playCenterX: number;
    playCenterY: number;
    playRadius: number;
};

type AudioPaintState = { name: string; playing: boolean; iconReady: boolean };

type AudioCallout3d = {
    entryId: string;
    texture: Texture;
    materials: StandardMaterial[];
    calloutRoot: Entity;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    lastPaint: AudioPaintState | null;
};

type HotspotDepthLayers = {
    baseLayer: Layer;
    overlayLayer: Layer;
};

let sharedMesh: Mesh | null = null;
let layers: HotspotDepthLayers | null = null;
let cameraEntity: Entity | null = null;
const calloutsByEntryId = new Map<string, AudioCallout3d>();

let interactionCanvas: HTMLCanvasElement | null = null;
let interactionGlobal: Global | null = null;
let audioPlayIconCanvas: HTMLCanvasElement | null = null;
let audioPauseIconCanvas: HTMLCanvasElement | null = null;
let audioIconsLoadPromise: Promise<void> | null = null;
let measureCanvasCtx: CanvasRenderingContext2D | null = null;

function getMeasureCanvasCtx(): CanvasRenderingContext2D | null {
    if (!measureCanvasCtx) {
        measureCanvasCtx = document.createElement('canvas').getContext('2d');
    }
    return measureCanvasCtx;
}

function isAudioCalloutIconsReady(): boolean {
    return !!(audioPlayIconCanvas && audioPauseIconCanvas);
}

/** 预栅格化到独立 canvas，再合成到 callout 主纹理。 */
async function loadIconRasterCanvas(url: string): Promise<HTMLCanvasElement | null> {
    const resolved = new URL(url, window.location.href).href;
    try {
        const res = await fetch(resolved);
        if (!res.ok) return null;
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const img = await new Promise<HTMLImageElement | null>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = objectUrl;
        });
        URL.revokeObjectURL(objectUrl);
        if (!img?.naturalWidth) return null;

        const canvas = document.createElement('canvas');
        canvas.width = PLAY_ICON_W;
        canvas.height = PLAY_ICON_H;
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, PLAY_ICON_W, PLAY_ICON_H);
        ctx.drawImage(img, 0, 0, PLAY_ICON_W, PLAY_ICON_H);
        return canvas;
    } catch {
        return null;
    }
}

function getAudioControlIconCanvas(playing: boolean): HTMLCanvasElement | null {
    return playing ? audioPauseIconCanvas : audioPlayIconCanvas;
}

function loadAudioCalloutIcons(onReady?: () => void): Promise<void> {
    if (isAudioCalloutIconsReady()) {
        onReady?.();
        return Promise.resolve();
    }
    if (audioIconsLoadPromise) {
        return audioIconsLoadPromise.then(() => onReady?.());
    }
    audioIconsLoadPromise = Promise.all([
        loadIconRasterCanvas(AUDIO_PLAY_ICON_URL).then((c) => {
            audioPlayIconCanvas = c;
        }),
        loadIconRasterCanvas(AUDIO_PAUSE_ICON_URL).then((c) => {
            audioPauseIconCanvas = c;
        })
    ]).then(() => {
        onReady?.();
    });
    return audioIconsLoadPromise;
}

function invalidateAllCalloutTextures(global: Global): void {
    for (const entry of global.state.scenePlacedEntities ?? []) {
        const callout = calloutsByEntryId.get(entry.id);
        if (!callout) continue;
        callout.lastPaint = null;
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : null;
        if (m?.kind === 'audio') syncCalloutTexture(global, entry, callout, m);
    }
}

type TooltipBox = { x: number; y: number; width: number; height: number; displayName: string };

function measureAnnotationTooltipBox(ctx: CanvasRenderingContext2D, name: string): TooltipBox {
    ctx.font = TOOLTIP_FONT;
    const innerMax = AUDIO_TOOLTIP_TEX_W - TOOLTIP_PAD_X * 2;
    let displayName = name;
    if (ctx.measureText(displayName).width > innerMax) {
        const ell = '…';
        let lo = 0;
        let hi = displayName.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const trial = `${displayName.slice(0, mid)}${ell}`;
            if (ctx.measureText(trial).width <= innerMax) lo = mid;
            else hi = mid - 1;
        }
        displayName = `${displayName.slice(0, lo)}${ell}`;
    }
    const x = (AUDIO_CALLOUT_TEX_W - AUDIO_TOOLTIP_TEX_W) * 0.5;
    const y = LABEL_TOP;
    return {
        x,
        y,
        width: AUDIO_TOOLTIP_TEX_W,
        height: AUDIO_TOOLTIP_TEX_H,
        displayName
    };
}

function computeAudioCalloutLayout(texW: number, ctx: CanvasRenderingContext2D, name: string): AudioCalloutLayout {
    const tooltip = measureAnnotationTooltipBox(ctx, name);
    const playCenterX = texW * 0.5;
    const playCenterY = tooltip.y + tooltip.height + LABEL_PLAY_GAP + PLAY_ICON_H * 0.5;
    const playRadius = Math.max(PLAY_ICON_W, PLAY_ICON_H) * 0.5;
    return { playCenterX, playCenterY, playRadius };
}

function ensureHotspotDepthLayers(app: AppBase, camEntity: Entity): HotspotDepthLayers {
    if (layers) return layers;

    const sceneLayers = app.scene.layers;
    const worldLayer = sceneLayers.getLayerByName('World');
    if (!worldLayer) {
        throw new Error('World layer missing for audio callout depth layers');
    }

    let baseLayer = sceneLayers.getLayerByName('HotspotBase');
    let overlayLayer = sceneLayers.getLayerByName('HotspotOverlay');

    if (!baseLayer) {
        baseLayer = new Layer({ name: 'HotspotBase' });
        sceneLayers.insert(baseLayer, sceneLayers.getOpaqueIndex(worldLayer) + 1);
    }
    if (!overlayLayer) {
        overlayLayer = new Layer({ name: 'HotspotOverlay' });
        sceneLayers.insert(overlayLayer, sceneLayers.getTransparentIndex(worldLayer) + 1);
    }

    const cam = camEntity.camera;
    const layerIds = new Set(cam.layers);
    layerIds.add(baseLayer.id);
    layerIds.add(overlayLayer.id);
    cam.layers = [...layerIds];

    layers = { baseLayer, overlayLayer };
    return layers;
}

/** 与 Annotation 相同：无 X 镜像的平面，配合 camera billboard + rotateLocal(90,0,0)。 */
function ensureSharedMesh(app: AppBase): Mesh {
    if (!sharedMesh) {
        sharedMesh = Mesh.fromGeometry(app.graphicsDevice, new PlaneGeometry({
            widthSegments: 1,
            lengthSegments: 1
        }));
    }
    return sharedMesh;
}

function createCalloutMaterial(texture: Texture, opacity: number, depthTest: boolean, depthWrite: boolean): StandardMaterial {
    const material = new StandardMaterial();
    material.diffuse = Color.BLACK;
    material.emissive.set(1, 1, 1);
    material.emissiveMap = texture;
    material.opacityMap = texture;
    material.opacity = opacity;
    material.alphaTest = 0.01;
    material.blendState = new BlendState(
        true,
        BLENDEQUATION_ADD,
        BLENDMODE_SRC_ALPHA,
        BLENDMODE_ONE_MINUS_SRC_ALPHA,
        BLENDEQUATION_ADD,
        BLENDMODE_ONE,
        BLENDMODE_ONE
    );
    material.depthTest = depthTest;
    material.depthWrite = depthWrite;
    material.cull = CULLFACE_NONE;
    material.useLighting = false;
    material.shaderChunks.glsl.add({ litUserMainEndVS: depthClampGlsl });
    material.shaderChunks.wgsl.add({ litUserMainEndVS: depthClampWgsl });
    material.update();
    return material;
}

function roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

/** 与 `.pc-annotation` / `.pc-annotation--selected` 一致 */
function drawAnnotationTooltipLabel(
    ctx: CanvasRenderingContext2D,
    box: TooltipBox,
    selected: boolean
): void {
    const { x, y, width, height, displayName } = box;

    roundRectPath(ctx, x, y, width, height, TOOLTIP_RADIUS);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fill();

    if (selected) {
        roundRectPath(ctx, x - 3, y - 3, width + 6, height + 6, TOOLTIP_RADIUS + 1);
        ctx.strokeStyle = TOOLTIP_BORDER;
        ctx.lineWidth = 3;
        ctx.stroke();
        roundRectPath(ctx, x, y, width, height, TOOLTIP_RADIUS);
        ctx.strokeStyle = TOOLTIP_BORDER;
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    ctx.fillStyle = '#fff';
    ctx.font = TOOLTIP_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName, x + width * 0.5, y + height * 0.5);
}

function drawAudioCallout(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    name: string,
    playing: boolean
): void {
    ctx.clearRect(0, 0, w, h);

    const tooltip = measureAnnotationTooltipBox(ctx, name);
    drawAnnotationTooltipLabel(ctx, tooltip, playing);

    const layout = computeAudioCalloutLayout(w, ctx, name);
    const controlIcon = getAudioControlIconCanvas(playing);
    if (controlIcon) {
        const ix = layout.playCenterX - PLAY_ICON_W * 0.5;
        const iy = layout.playCenterY - PLAY_ICON_H * 0.5;
        ctx.drawImage(controlIcon, ix, iy, PLAY_ICON_W, PLAY_ICON_H);
    }
}

function isAudioVisuallyPlaying(global: Global, m: PlacedAudioRuntime): boolean {
    if (readViewMediaMuted(global)) return false;
    return !m.audioEl.paused && m.audioEl.volume > 0;
}

function isAudioCalloutEligible(entry: ScenePlacedItem): boolean {
    return !!(entry.entity?.enabled && entry.visible !== false && entry.assetType === 'audio');
}

function syncCalloutTexture(global: Global, entry: ScenePlacedItem, callout: AudioCallout3d, m: PlacedAudioRuntime): void {
    const name = entry.name || '音频';
    const playing = isAudioVisuallyPlaying(global, m);
    const iconReady = isAudioCalloutIconsReady();
    if (
        callout.lastPaint?.name === name
        && callout.lastPaint?.playing === playing
        && callout.lastPaint?.iconReady === iconReady
    ) {
        return;
    }

    callout.lastPaint = { name, playing, iconReady };
    drawAudioCallout(callout.ctx, AUDIO_CALLOUT_TEX_W, AUDIO_CALLOUT_TEX_H, name, playing);
    try {
        callout.texture.upload();
    } catch {
        // ignore
    }
}

function updateHotspotTransform(hotspot: Entity, cameraRotation: Quat): void {
    hotspot.setRotation(cameraRotation);
    hotspot.rotateLocal(90, 0, 0);
}

function updateCalloutBillboard(global: Global, entry: ScenePlacedItem, callout: AudioCallout3d): void {
    const cam = cameraEntity;
    const audioEntity = entry.entity;
    if (!cam || !audioEntity) return;

    if (!isAudioCalloutEligible(entry)) {
        callout.calloutRoot.enabled = false;
        return;
    }

    callout.calloutRoot.enabled = true;

    const worldPos = audioEntity.getPosition();
    cam.camera.viewMatrix.transformPoint(worldPos, PROJ_VEC);
    if (PROJ_VEC.z >= 0) {
        callout.calloutRoot.enabled = false;
        return;
    }

    updateHotspotTransform(callout.calloutRoot, cam.getRotation());

    const aspect = AUDIO_CALLOUT_TEX_W / AUDIO_CALLOUT_TEX_H;
    const h = AUDIO_CALLOUT_WORLD_H;
    callout.calloutRoot.setLocalScale(h * aspect, h, 1);
}

function createAudioCallout3d(global: Global, entry: ScenePlacedItem, m: PlacedAudioRuntime): AudioCallout3d | null {
    const audioEntity = entry.entity;
    if (!audioEntity || !cameraEntity) return null;

    const { app } = global;
    const { baseLayer, overlayLayer } = ensureHotspotDepthLayers(app, cameraEntity);
    const mesh = ensureSharedMesh(app);

    const canvas = document.createElement('canvas');
    canvas.width = AUDIO_CALLOUT_TEX_W;
    canvas.height = AUDIO_CALLOUT_TEX_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const texture = new Texture(app.graphicsDevice, {
        width: AUDIO_CALLOUT_TEX_W,
        height: AUDIO_CALLOUT_TEX_H,
        format: PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: FILTER_LINEAR,
        magFilter: FILTER_LINEAR
    });
    texture.setSource(canvas);

    const materials = [
        createCalloutMaterial(texture, 1, true, true),
        createCalloutMaterial(texture, OVERLAY_OPACITY, false, false)
    ];

    const calloutRoot = new Entity('audio-callout-3d');
    audioEntity.addChild(calloutRoot);

    const base = new Entity('base');
    const baseMi = new MeshInstance(mesh, materials[0]);
    baseMi.cull = false;
    base.addComponent('render', {
        layers: [baseLayer.id],
        meshInstances: [baseMi]
    });

    const overlay = new Entity('overlay');
    const overlayMi = new MeshInstance(mesh, materials[1]);
    overlayMi.cull = false;
    overlay.addComponent('render', {
        layers: [overlayLayer.id],
        meshInstances: [overlayMi]
    });

    calloutRoot.addChild(base);
    calloutRoot.addChild(overlay);

    const callout: AudioCallout3d = {
        entryId: entry.id,
        texture,
        materials,
        calloutRoot,
        canvas,
        ctx,
        lastPaint: null
    };

    syncCalloutTexture(global, entry, callout, m);
    return callout;
}

function destroyAudioCallout3d(callout: AudioCallout3d): void {
    callout.materials.forEach((mat) => {
        try {
            mat.destroy();
        } catch {
            // ignore
        }
    });
    try {
        callout.texture.destroy();
    } catch {
        // ignore
    }
    callout.calloutRoot.destroy();
}

/** 已放置音频：拾取球只在 SceneAssetPick 层（不参与相机渲染，避免叠在视频前出现黑块）。 */
function ensureAudioPickMesh(entity: Entity, app: AppBase): void {
    const pickLayer = getSceneAssetPickLayer(app);
    const pickLayerId = pickLayer.id;

    if (entity.render) {
        entity.render.layers = [pickLayerId];
        return;
    }

    const pickMat = new StandardMaterial();
    pickMat.useLighting = false;
    pickMat.diffuse = Color.BLACK;
    pickMat.opacity = 0.001;
    pickMat.alphaTest = 0;
    pickMat.depthWrite = false;
    pickMat.blendType = BLEND_NONE;
    pickMat.cull = CULLFACE_NONE;
    pickMat.update();

    const pickRadius = AUDIO_CALLOUT_WORLD_H * 0.45;
    entity.addComponent('render', {
        type: 'sphere',
        material: pickMat,
        layers: [pickLayerId],
        castShadows: false,
        receiveShadows: false
    });
    entity.setLocalScale(pickRadius, pickRadius, pickRadius);
}

export function registerAudioCallout3d(global: Global, entry: ScenePlacedItem): void {
    if (calloutsByEntryId.has(entry.id)) return;
    const entity = entry.entity;
    if (!entity) return;
    const m = getPlacedMediaRuntime(entity);
    if (m?.kind !== 'audio') return;

    ensureAudioPickMesh(entity, global.app);

    const callout = createAudioCallout3d(global, entry, m);
    if (callout) calloutsByEntryId.set(entry.id, callout);
}

export function unregisterAudioCallout3d(entryId: string): void {
    const callout = calloutsByEntryId.get(entryId);
    if (!callout) return;
    destroyAudioCallout3d(callout);
    calloutsByEntryId.delete(entryId);
}

export function syncAudioCallout3dRegistry(global: Global): void {
    const live = new Set<string>();
    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!entry?.entity) continue;
        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind !== 'audio') continue;
        live.add(entry.id);
        if (!calloutsByEntryId.has(entry.id)) {
            registerAudioCallout3d(global, entry);
        }
    }
    for (const id of [...calloutsByEntryId.keys()]) {
        if (!live.has(id)) unregisterAudioCallout3d(id);
    }
}

export function prerenderAudioCallouts(global: Global): void {
    if (!cameraEntity) return;
    for (const entry of global.state.scenePlacedEntities ?? []) {
        const callout = calloutsByEntryId.get(entry.id);
        if (!callout || !entry.entity) continue;
        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind !== 'audio') continue;
        updateCalloutBillboard(global, entry, callout);
        syncCalloutTexture(global, entry, callout, m);
    }
}

export function initAudioCallout3dSystem(global: Global): () => void {
    const { app, events } = global;
    cameraEntity = global.camera;
    ensureHotspotDepthLayers(app, cameraEntity);
    ensureSharedMesh(app);
    void loadAudioCalloutIcons(() => invalidateAllCalloutTextures(global));

    const onPrerender = () => prerenderAudioCallouts(global);
    const onRegistry = () => syncAudioCallout3dRegistry(global);
    const onState = () => {
        for (const entry of global.state.scenePlacedEntities ?? []) {
            const callout = calloutsByEntryId.get(entry.id);
            if (!callout || !entry.entity) continue;
            const m = getPlacedMediaRuntime(entry.entity);
            if (m?.kind === 'audio') syncCalloutTexture(global, entry, callout, m);
        }
    };

    app.on('prerender', onPrerender);
    events.on('sceneAssets:added', onRegistry);
    events.on('viewMediaMuted:changed', onState);
    events.on('mediaOverlay:playbackChanged', onState);
    syncAudioCallout3dRegistry(global);

    return () => {
        app.off('prerender', onPrerender);
        events.off('sceneAssets:added', onRegistry);
        events.off('viewMediaMuted:changed', onState);
        events.off('mediaOverlay:playbackChanged', onState);
        for (const id of [...calloutsByEntryId.keys()]) {
            unregisterAudioCallout3d(id);
        }
        layers = null;
        cameraEntity = null;
    };
}

// --- 屏幕空间点击（与 video 播控类似，基于 mesh 屏幕包围盒） ---

type ScreenBounds = { minX: number; minY: number; maxX: number; maxY: number };

function buildEntityScreenBounds(cam: CameraComponent, entity: Entity): ScreenBounds | null {
    const scratch = new Vec3();
    const anyEntity = entity as Entity & {
        render?: { meshInstances?: { aabb?: { getMin?: () => Vec3; getMax?: () => Vec3; center: Vec3; halfExtents: Vec3 } }[] };
    };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let anyVisible = false;

    const collect = (node: Entity) => {
        const r = node.render;
        if (r?.meshInstances) {
            for (const mi of r.meshInstances) {
                const aabb = mi.aabb;
                if (!aabb) continue;
                const miMin = aabb.getMin?.() ?? new Vec3().copy(aabb.center).sub(aabb.halfExtents);
                const miMax = aabb.getMax?.() ?? new Vec3().copy(aabb.center).add(aabb.halfExtents);
                const corners = [
                    new Vec3(miMin.x, miMin.y, miMin.z),
                    new Vec3(miMax.x, miMin.y, miMin.z),
                    new Vec3(miMin.x, miMax.y, miMin.z),
                    new Vec3(miMax.x, miMax.y, miMin.z),
                    new Vec3(miMin.x, miMin.y, miMax.z),
                    new Vec3(miMax.x, miMin.y, miMax.z),
                    new Vec3(miMin.x, miMax.y, miMax.z),
                    new Vec3(miMax.x, miMax.y, miMax.z)
                ];
                for (const c of corners) {
                    cam.viewMatrix.transformPoint(c, PROJ_VEC);
                    if (PROJ_VEC.z >= 0) continue;
                    cam.worldToScreen(c, scratch);
                    minX = Math.min(minX, scratch.x);
                    minY = Math.min(minY, scratch.y);
                    maxX = Math.max(maxX, scratch.x);
                    maxY = Math.max(maxY, scratch.y);
                    anyVisible = true;
                }
            }
        }
        for (const child of node.children as Entity[]) {
            collect(child);
        }
    };

    collect(entity);
    if (!anyVisible || maxX <= minX || maxY <= minY) return null;
    return { minX, minY, maxX, maxY };
}

function hitTestPlayNormalized(u: number, v: number, layout: AudioCalloutLayout): boolean {
    const px = layout.playCenterX;
    const py = layout.playCenterY;
    const playLeftU = (px - layout.playRadius - PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_W;
    const playRightU = (px + layout.playRadius + PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_W;
    const playTopV = (py - layout.playRadius - PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_H;
    const playBottomV = (py + layout.playRadius + PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_H;
    return u >= playLeftU && u <= playRightU && v >= playTopV && v <= playBottomV;
}

/** 屏幕归一化命中；尝试 U/V 翻转以兼容投影镜像（与 video 播控一致）。 */
function hitTestPlayInBounds(
    canvasX: number,
    canvasY: number,
    bounds: ScreenBounds,
    layout: AudioCalloutLayout
): boolean {
    const boxW = Math.max(1, bounds.maxX - bounds.minX);
    const boxH = Math.max(1, bounds.maxY - bounds.minY);
    const u0 = (canvasX - bounds.minX) / boxW;
    const v0 = (canvasY - bounds.minY) / boxH;
    for (const u of [u0, 1 - u0]) {
        for (const v of [v0, 1 - v0]) {
            if (hitTestPlayNormalized(u, v, layout)) return true;
        }
    }
    return false;
}

function toggleAudioPlayback(global: Global, entry: ScenePlacedItem, m: PlacedAudioRuntime): void {
    if (readViewMediaMuted(global)) return;

    const a = m.audioEl;
    const rt = ensureScenePlacedMediaRuntime(entry);
    if (a.paused || a.volume === 0) {
        rt.userPaused = false;
        a.volume = 1;
        a.play().catch(() => {});
    } else {
        rt.userPaused = true;
        try {
            a.pause();
        } catch {
            // ignore
        }
        a.volume = 0;
    }
    const callout = calloutsByEntryId.get(entry.id);
    if (callout) syncCalloutTexture(global, entry, callout, m);
    global.events.fire('mediaOverlay:playbackChanged', {
        id: entry.id,
        kind: 'audio',
        playing: isAudioVisuallyPlaying(global, m)
    });
    global.events.fire('mediaOverlay:userPlayback');
    global.events.fire('mediaHotspot:userActivate');
}

function findAudioPlayHit(global: Global, canvasX: number, canvasY: number): {
    entry: ScenePlacedItem;
    m: PlacedAudioRuntime;
} | null {
    const cam = global.camera.camera;
    const eye = global.camera.getPosition();
    const measureCtx = getMeasureCanvasCtx();

    let best: { entry: ScenePlacedItem; m: PlacedAudioRuntime; depth: number } | null = null;

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!isAudioCalloutEligible(entry) || !entry.entity) continue;
        const callout = calloutsByEntryId.get(entry.id);
        if (!callout?.calloutRoot.enabled) continue;

        const bounds = buildEntityScreenBounds(cam, callout.calloutRoot);
        if (!bounds) continue;
        if (
            canvasX < bounds.minX - 8
            || canvasX > bounds.maxX + 8
            || canvasY < bounds.minY - 8
            || canvasY > bounds.maxY + 8
        ) {
            continue;
        }
        const layout = measureCtx
            ? computeAudioCalloutLayout(AUDIO_CALLOUT_TEX_W, measureCtx, entry.name || '音频')
            : {
                playCenterX: AUDIO_CALLOUT_TEX_W * 0.5,
                playCenterY: LABEL_TOP + AUDIO_TOOLTIP_TEX_H + LABEL_PLAY_GAP + PLAY_ICON_H * 0.5,
                playRadius: Math.max(PLAY_ICON_W, PLAY_ICON_H) * 0.5
            };
        if (!hitTestPlayInBounds(canvasX, canvasY, bounds, layout)) continue;

        const depth = eye.distance(entry.entity.getPosition());
        if (!best || depth < best.depth) {
            const m = getPlacedMediaRuntime(entry.entity);
            if (m?.kind === 'audio') best = { entry, m, depth };
        }
    }

    return best ? { entry: best.entry, m: best.m } : null;
}

function clientToCanvas(canvas: HTMLCanvasElement, global: Global, clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    const { width: cw, height: ch } = global.app.graphicsDevice.clientRect;
    const safeW = Math.max(1, rect.width);
    const safeH = Math.max(1, rect.height);
    const scaleX = (cw || canvas.clientWidth || safeW) / safeW;
    const scaleY = (ch || canvas.clientHeight || safeH) / safeH;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    if (x < 0 || y < 0 || x > (cw || safeW) || y > (ch || safeH)) return null;
    return { x, y };
}

export function tryClaimAudioCalloutPointerDown(global: Global, e: PointerEvent): boolean {
    if (global.state.gizmoPointerActive || hitSceneGizmoAtClient(global, e.clientX, e.clientY)) {
        return false;
    }
    if (!e.isPrimary || e.button !== 0) return false;
    const canvas = interactionCanvas;
    if (!canvas) return false;

    const pt = clientToCanvas(canvas, global, e.clientX, e.clientY);
    if (!pt) return false;

    const hit = findAudioPlayHit(global, pt.x, pt.y);
    if (!hit) return false;

    global.state.selectedSceneEntityId = hit.entry.id;
    global.events.fire('sceneAsset:selected', { source: 'scene' });

    toggleAudioPlayback(global, hit.entry, hit.m);
    return true;
}

function isPointInScreenBounds(
    canvasX: number,
    canvasY: number,
    bounds: ScreenBounds,
    pad = 8
): boolean {
    return (
        canvasX >= bounds.minX - pad
        && canvasX <= bounds.maxX + pad
        && canvasY >= bounds.minY - pad
        && canvasY <= bounds.maxY + pad
    );
}

/** 点击 callout 任意可见区域时选中音频（编辑模式场景点击，非仅播放钮）。 */
export function findAudioCalloutSelectHitFromClient(
    global: Global,
    clientX: number,
    clientY: number
): ScenePlacedItem | null {
    const canvas = interactionCanvas ?? (global.app.graphicsDevice.canvas as HTMLCanvasElement | undefined);
    if (!canvas) return null;

    const pt = clientToCanvas(canvas, global, clientX, clientY);
    if (!pt) return null;

    const cam = global.camera.camera;
    let best: { entry: ScenePlacedItem; depth: number } | null = null;
    const eye = global.camera.getPosition();

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!isAudioCalloutEligible(entry) || !entry.entity) continue;
        const callout = calloutsByEntryId.get(entry.id);
        if (!callout?.calloutRoot.enabled) continue;

        const bounds = buildEntityScreenBounds(cam, callout.calloutRoot);
        if (!bounds || !isPointInScreenBounds(pt.x, pt.y, bounds)) continue;

        const depth = eye.distance(entry.entity.getPosition());
        if (!best || depth < best.depth) {
            best = { entry, depth };
        }
    }

    return best?.entry ?? null;
}

export function initAudioCalloutInteraction(global: Global, canvas: HTMLCanvasElement): () => void {
    interactionCanvas = canvas;
    interactionGlobal = global;

    let detach: (() => void) | null = null;
    const arbiter = (global as Global & { __inputArbiter?: import('../../input-arbiter').InputArbiter }).__inputArbiter;
    if (arbiter) {
        detach = arbiter.registerPointerDownHandler({
            id: 'media.audio-callout',
            priority: 205,
            handle: (ctx) => tryClaimAudioCalloutPointerDown(global, ctx.pointerEvent)
        });
    }

    return () => {
        detach?.();
        detach = null;
        interactionCanvas = null;
        interactionGlobal = null;
    };
}
