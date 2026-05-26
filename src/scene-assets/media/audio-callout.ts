/**
 * 音频 callout：HotspotBase/Overlay 排在 World 透明（高斯）之后；Base depthTest、不写 depth。
 * 视觉在 3D 纹理上绘制；mesh 仍可通过 depthTest 遮挡，高斯不写 depth 故叠在高斯上须后排绘制。
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
    Mat4,
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
import { ensureHotspotDepthLayers, type HotspotDepthLayers } from '../hotspot-depth-layers';
import { getSceneAssetPickLayer } from '../scene-asset-pick-layer';
import { isMediaConsumptionMode, readShowAudioCalloutInViewerFromSettings } from './media-hotspot-params';
import { userPauseSceneMedia, userPlaySceneMedia } from './scene-media-playback';
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
const AUDIO_RAY_FAR = new Vec3();
const AUDIO_RAY_DIR = new Vec3();
const AUDIO_TO_PLANE = new Vec3();
const AUDIO_HIT_WORLD = new Vec3();
const AUDIO_LOCAL_HIT = new Vec3();
const AUDIO_INV_WORLD = new Mat4();
const AUDIO_PLANE_NORMAL_LOCAL = new Vec3(0, 1, 0);
const AUDIO_PLANE_NORMAL_WORLD = new Vec3();
const OVERLAY_OPACITY = 0.25;

export const AUDIO_CALLOUT_TEX_W = 512;

const AUDIO_PLAY_ICON_URL = '/assets/icons/audio-play.svg?v=2';
const AUDIO_PAUSE_ICON_URL = '/assets/icons/audio-pause.svg?v=2';

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
/** 非播放态沿用 Annotation 描边 */
const TOOLTIP_BORDER = 'rgba(0, 191, 255, 0.41)';

/** 播放中标题描边（设计稿） */
const TITLE_BORDER_W = 2;
const TITLE_BORDER_ANIM_MS = 2500;
const TITLE_GLOW_COLOR = '#1FE1FF';
/** 无场景采样时的毛玻璃底（Canvas 无法做真实 backdrop-filter） */
const TITLE_GLASS_FILL = 'rgba(0, 0, 0, 0.5)';
const TITLE_CONIC_STOPS: ReadonlyArray<[number, string]> = [
    [0, '#0A2EA5'],
    [96.92 / 360, '#E8F3FF'],
    [159.23 / 360, '#47C3FF'],
    [219.81 / 360, '#1FE1FF'],
    [292.5 / 360, '#2061FD'],
    [1, '#133A97']
];

/** SVG 原尺寸 32×32，纹理上约 2× 绘制 */
const PLAY_ICON_W = 32;
const PLAY_ICON_H = 32;
const PLAY_HIT_PAD = 24;
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

type AudioPaintState = {
    name: string;
    playing: boolean;
    iconReady: boolean;
    /** 播放中描边动画帧（约 60fps 量化） */
    borderAnimTick: number;
};

type AudioCallout3d = {
    entryId: string;
    texture: Texture;
    materials: StandardMaterial[];
    calloutRoot: Entity;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    lastPaint: AudioPaintState | null;
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

/** Canvas 直出 RGBA 预乘，避免半透明黑/蓝边在 3D 直出 alpha 混合时染黑场景。 */
function premultiplyCanvasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        data[i] = Math.round(data[i] * a);
        data[i + 1] = Math.round(data[i + 1] * a);
        data[i + 2] = Math.round(data[i + 2] * a);
    }
    ctx.putImageData(imageData, 0, 0);
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
        premultiplyCanvasAlpha(ctx, PLAY_ICON_W, PLAY_ICON_H);
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
    material.alphaTest = 0.001;
    // 纹理已预乘 alpha：用 ONE / ONE_MINUS_SRC_ALPHA，避免半透明像素把场景染黑一圈
    material.blendState = new BlendState(
        true,
        BLENDEQUATION_ADD,
        BLENDMODE_ONE,
        BLENDMODE_ONE_MINUS_SRC_ALPHA,
        BLENDEQUATION_ADD,
        BLENDMODE_ONE,
        BLENDMODE_ONE_MINUS_SRC_ALPHA
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

/** 与 `.pc-annotation` / `.pc-annotation--selected` 一致（非播放态） */
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

function createTitleConicGradient(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    startDeg: number
): CanvasGradient {
    const g = ctx.createConicGradient((startDeg * Math.PI) / 180, cx, cy);
    for (const [t, color] of TITLE_CONIC_STOPS) {
        g.addColorStop(t, color);
    }
    return g;
}

/**
 * 播放中：圆锥渐变描边顺时针流动（2.5s/圈）+ 外发光 + 毛玻璃底。
 * `animTimeMs` 为 `performance.now()`，与 CSS `from 90deg` 圆锥渐变一致。
 */
function drawPlayingAudioTitleTooltip(
    ctx: CanvasRenderingContext2D,
    box: TooltipBox,
    animTimeMs: number
): void {
    const { x, y, width, height, displayName } = box;
    const cx = x + width * 0.5;
    const cy = y + height * 0.5;
    const r = TOOLTIP_RADIUS;

    ctx.save();
    ctx.shadowColor = TITLE_GLOW_COLOR;
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    roundRectPath(ctx, x, y, width, height, r);
    ctx.strokeStyle = 'rgba(31, 225, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    roundRectPath(ctx, x, y, width, height, r);
    ctx.fillStyle = TITLE_GLASS_FILL;
    ctx.fill();

    const cycle = (animTimeMs % TITLE_BORDER_ANIM_MS) / TITLE_BORDER_ANIM_MS;
    const startDeg = 90 + cycle * 360;

    const inset = TITLE_BORDER_W * 0.5;
    roundRectPath(
        ctx,
        x + inset,
        y + inset,
        width - TITLE_BORDER_W,
        height - TITLE_BORDER_W,
        Math.max(0, r - inset)
    );
    ctx.lineWidth = TITLE_BORDER_W;
    ctx.strokeStyle = createTitleConicGradient(ctx, cx, cy, startDeg);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = TOOLTIP_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName, cx, cy);
}

function drawAudioTitleTooltip(
    ctx: CanvasRenderingContext2D,
    box: TooltipBox,
    playing: boolean,
    animTimeMs: number
): void {
    if (playing) {
        drawPlayingAudioTitleTooltip(ctx, box, animTimeMs);
    } else {
        drawAnnotationTooltipLabel(ctx, box, false);
    }
}

function drawAudioCallout(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    name: string,
    playing: boolean,
    animTimeMs: number
): void {
    ctx.clearRect(0, 0, w, h);

    const tooltip = measureAnnotationTooltipBox(ctx, name);
    drawAudioTitleTooltip(ctx, tooltip, playing, animTimeMs);

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

function isAudioCalloutEligible(entry: ScenePlacedItem, global?: Global): boolean {
    if (global && isMediaConsumptionMode(global)) {
        // 浏览模式（Viewer / 编辑预览）：受 settings.audio.showCalloutInViewer 控制，
        // 且仅在热区内才可见，与视频控件「热区内才可交互」对齐
        if (!readShowAudioCalloutInViewerFromSettings(global.settings)) return false;
        if (entry.mediaRuntime?.inHotspotZone !== true) return false;
    }
    return !!(entry.entity?.enabled && entry.visible !== false && entry.assetType === 'audio');
}

function syncCalloutTexture(global: Global, entry: ScenePlacedItem, callout: AudioCallout3d, m: PlacedAudioRuntime): void {
    const name = entry.name || '音频';
    const playing = isAudioVisuallyPlaying(global, m);
    const iconReady = isAudioCalloutIconsReady();
    const borderAnimTick = playing ? Math.floor(performance.now() / 16) : -1;
    if (
        callout.lastPaint?.name === name
        && callout.lastPaint?.playing === playing
        && callout.lastPaint?.iconReady === iconReady
        && callout.lastPaint?.borderAnimTick === borderAnimTick
    ) {
        return;
    }

    callout.lastPaint = { name, playing, iconReady, borderAnimTick };
    drawAudioCallout(
        callout.ctx,
        AUDIO_CALLOUT_TEX_W,
        AUDIO_CALLOUT_TEX_H,
        name,
        playing,
        performance.now()
    );
    premultiplyCanvasAlpha(callout.ctx, AUDIO_CALLOUT_TEX_W, AUDIO_CALLOUT_TEX_H);
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

    if (!isAudioCalloutEligible(entry, global)) {
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
    if (!layers) {
        layers = ensureHotspotDepthLayers(app, cameraEntity);
    }
    const { baseLayer, overlayLayer } = layers;
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
        createCalloutMaterial(texture, 1, true, false),
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

function initAudioCalloutSystem(global: Global): () => void {
    const { app, events } = global;
    cameraEntity = global.camera;
    layers = ensureHotspotDepthLayers(app, cameraEntity);
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

// --- 3D quad 射线点击（避免非正视角下屏幕 AABB 误触） ---

function hitTestPlayNormalized(u: number, v: number, layout: AudioCalloutLayout): boolean {
    const px = layout.playCenterX;
    const py = layout.playCenterY;
    const playLeftU = (px - layout.playRadius - PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_W;
    const playRightU = (px + layout.playRadius + PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_W;
    const playTopV = (py - layout.playRadius - PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_H;
    const playBottomV = (py + layout.playRadius + PLAY_HIT_PAD) / AUDIO_CALLOUT_TEX_H;
    return u >= playLeftU && u <= playRightU && v >= playTopV && v <= playBottomV;
}

function pickCalloutUvViaRayPlane(
    global: Global,
    cam: CameraComponent,
    calloutRoot: Entity,
    canvasX: number,
    canvasY: number
): { u: number; v: number } | null {
    const rayOrigin = global.camera.getPosition();
    cam.screenToWorld(canvasX, canvasY, cam.farClip, AUDIO_RAY_FAR);
    AUDIO_RAY_DIR.sub2(AUDIO_RAY_FAR, rayOrigin);
    const rayLen = AUDIO_RAY_DIR.length();
    if (rayLen < 1e-5) return null;
    AUDIO_RAY_DIR.mulScalar(1 / rayLen);

    const planePoint = calloutRoot.getPosition();
    calloutRoot.getWorldTransform().transformVector(AUDIO_PLANE_NORMAL_LOCAL, AUDIO_PLANE_NORMAL_WORLD);
    AUDIO_PLANE_NORMAL_WORLD.normalize();
    AUDIO_TO_PLANE.sub2(planePoint, rayOrigin);
    if (AUDIO_PLANE_NORMAL_WORLD.dot(AUDIO_TO_PLANE) < 0) {
        AUDIO_PLANE_NORMAL_WORLD.mulScalar(-1);
    }

    const denom = AUDIO_RAY_DIR.dot(AUDIO_PLANE_NORMAL_WORLD);
    if (Math.abs(denom) < 1e-5) return null;

    const t = AUDIO_TO_PLANE.dot(AUDIO_PLANE_NORMAL_WORLD) / denom;
    if (t < 0) return null;

    AUDIO_HIT_WORLD.set(
        rayOrigin.x + AUDIO_RAY_DIR.x * t,
        rayOrigin.y + AUDIO_RAY_DIR.y * t,
        rayOrigin.z + AUDIO_RAY_DIR.z * t
    );

    cam.viewMatrix.transformPoint(AUDIO_HIT_WORLD, PROJ_VEC);
    if (PROJ_VEC.z >= 0) return null;

    AUDIO_INV_WORLD.invert(calloutRoot.getWorldTransform());
    AUDIO_INV_WORLD.transformPoint(AUDIO_HIT_WORLD, AUDIO_LOCAL_HIT);
    const lx = AUDIO_LOCAL_HIT.x;
    const ly = AUDIO_LOCAL_HIT.y;
    const lz = AUDIO_LOCAL_HIT.z;
    if (Math.abs(lx) > 0.52 || Math.abs(lz) > 0.52 || Math.abs(ly) > 0.12) {
        return null;
    }

    return {
        u: lx + 0.5,
        v: 0.5 - lz
    };
}

function toggleAudioPlayback(global: Global, entry: ScenePlacedItem, m: PlacedAudioRuntime): void {
    if (readViewMediaMuted(global)) return;

    const a = m.audioEl;
    if (a.paused || a.volume === 0) {
        userPlaySceneMedia(global, entry);
    } else {
        userPauseSceneMedia(global, entry);
    }
    const callout = calloutsByEntryId.get(entry.id);
    if (callout) syncCalloutTexture(global, entry, callout, m);
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
        if (!isAudioCalloutEligible(entry, global) || !entry.entity) continue;
        const callout = calloutsByEntryId.get(entry.id);
        if (!callout?.calloutRoot.enabled) continue;

        const hitUv = pickCalloutUvViaRayPlane(global, cam, callout.calloutRoot, canvasX, canvasY);
        if (!hitUv) continue;
        const layout = measureCtx
            ? computeAudioCalloutLayout(AUDIO_CALLOUT_TEX_W, measureCtx, entry.name || '音频')
            : {
                playCenterX: AUDIO_CALLOUT_TEX_W * 0.5,
                playCenterY: LABEL_TOP + AUDIO_TOOLTIP_TEX_H + LABEL_PLAY_GAP + PLAY_ICON_H * 0.5,
                playRadius: Math.max(PLAY_ICON_W, PLAY_ICON_H) * 0.5
            };
        let playHit = false;
        for (const u of [hitUv.u, 1 - hitUv.u]) {
            for (const v of [hitUv.v, 1 - hitUv.v]) {
                if (hitTestPlayNormalized(u, v, layout)) {
                    playHit = true;
                    break;
                }
            }
            if (playHit) break;
        }
        if (!playHit) continue;

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
    const inConsumption = isMediaConsumptionMode(global);
    // 浏览模式下仅当显示 callout 开关打开才接管点击
    if (inConsumption && !readShowAudioCalloutInViewerFromSettings(global.settings)) {
        return false;
    }
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

    // 浏览模式下仅 toggle 播放，不修改场景选中
    if (!inConsumption) {
        global.state.selectedSceneEntityId = hit.entry.id;
        global.events.fire('sceneAsset:selected', { source: 'scene' });
    }

    toggleAudioPlayback(global, hit.entry, hit.m);
    return true;
}

/** 点击 callout 任意可见区域时选中音频（编辑模式场景点击，非仅播放钮）。 */
export function findAudioCalloutSelectHitFromClient(
    global: Global,
    clientX: number,
    clientY: number
): ScenePlacedItem | null {
    if (isMediaConsumptionMode(global)) {
        return null;
    }
    const canvas = interactionCanvas ?? (global.app.graphicsDevice.canvas as HTMLCanvasElement | undefined);
    if (!canvas) return null;

    const pt = clientToCanvas(canvas, global, clientX, clientY);
    if (!pt) return null;

    const cam = global.camera.camera;
    let best: { entry: ScenePlacedItem; depth: number } | null = null;
    const eye = global.camera.getPosition();

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!isAudioCalloutEligible(entry, global) || !entry.entity) continue;
        const callout = calloutsByEntryId.get(entry.id);
        if (!callout?.calloutRoot.enabled) continue;

        const hitUv = pickCalloutUvViaRayPlane(global, cam, callout.calloutRoot, pt.x, pt.y);
        if (!hitUv) continue;

        const depth = eye.distance(entry.entity.getPosition());
        if (!best || depth < best.depth) {
            best = { entry, depth };
        }
    }

    return best?.entry ?? null;
}

function initAudioCalloutInteraction(global: Global, canvas: HTMLCanvasElement): () => void {
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

/** Viewer 入口：音频 callout 渲染与指针交互 */
export function initSceneAudioCallout(global: Global): () => void {
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
    const cleanupSystem = initAudioCalloutSystem(global);
    const cleanupInteraction = canvas ? initAudioCalloutInteraction(global, canvas) : () => {};
    return () => {
        cleanupInteraction();
        cleanupSystem();
    };
}
