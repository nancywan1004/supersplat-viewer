import {
    Entity,
    Material,
    SHADERLANGUAGE_GLSL,
    SHADERLANGUAGE_WGSL,
    Vec3,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice
} from 'playcanvas';

import {
    POINTILLISM_DEFAULTS,
    POINTILLISM_DOT_RADIUS_PX_MAX,
    POINTILLISM_GAP_SPACING_MAX,
    POINTILLISM_GAP_SPACING_MIN,
    POINTILLISM_PAINT_GRAIN_MAX,
    POINTILLISM_PAINT_GRAIN_MIN,
    POINTILLISM_PAINT_OPACITY_MAX,
    POINTILLISM_PAINT_OPACITY_MIN,
    POINTILLISM_STROKE_LENGTH_MAX,
    POINTILLISM_STROKE_LENGTH_MIN,
    POINTILLISM_STROKE_WIDTH_MAX,
    POINTILLISM_STROKE_WIDTH_MIN,
    POINTILLISM_UNIFORM_NAMES as PU,
    pointillismModifyGlsl,
    pointillismModifyWgsl,
    pointillismModifyPsGlsl,
    pointillismModifyPsWgsl,
    resolvePointillismComplementaryMix,
    resolvePointillismDotRadiusPx,
    resolvePointillismDotRadiusSlopes,
    resolvePointillismEdgeThreshold,
    resolvePointillismMinVisibleAlpha,
    POINTILLISM_CONTRAST_DOT_MIX_MAX,
    POINTILLISM_SKY_DOT_VISUAL_MATCH_MIN,
    POINTILLISM_SKY_DOT_VISUAL_MATCH_MAX
} from './pointillism-stipple-shaders';
import {
    coercePointillismBool,
    DEFAULT_POINTILLISM_POST_SETTINGS,
    PointillismPostController
} from './pointillism-stipple-post';
import { applySkyboxPointillismUniforms } from './skybox-pointillism-runtime';
import { computeSkyboxPointillismMetrics } from './skybox-pointillism-shaders';
import { extractGlslWgslModifyBlocks, POINTILLISM_STIPPLE_COMPOSER_ID } from '../../gsplat-effect-layers-extractor';
import { POINTILLISM_STIPPLE_REGISTRY_EFFECT_ID } from '../../effect-types';
import {
    isOneShotRevealPlayingExclusiveGsplat,
    pointillismUsesRegistryComposerPath
} from '../../effects-pipeline-policy';
import { nightModeUsesComposerPath } from '../../../lighting/night-mode';
import { skipUnifiedMaterialListener } from '../../gsplat-unified-work-buffer';
import { GsplatShaderEffect } from '../../gsplat-shader-effect';

type SavedFragmentChunks = {
    gsplatModifyPS: { glsl?: string; wgsl?: string };
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

class GsplatPersistentPointillismStipple extends GsplatShaderEffect {
    static scriptName = 'gsplatPersistentPointillismStipple';

    /** 仅当 modify shader 源码变更时需递增以触发 composer 重编译 */
    private _pointillismComposerRev = 1;

    /** 一次性开场 reveal 独占 gsplatModifyVS 时，已从合成器摘掉点彩 contribution */
    private _pointillismComposerSuppressed = false;

    private readonly _savedFragmentChunks = new Map<Material, SavedFragmentChunks>();

    private _postController: PointillismPostController | null = null;

    private _camera: CameraComponent | null = null;

    brushSize = Number.NaN;

    brushAspect = Number.NaN;

    brushHardness = POINTILLISM_DEFAULTS.brushHardness;

    colorVibration = Number.NaN;

    darkPaintBoost = Number.NaN;

    highlightSkip = Number.NaN;

    dotScale = POINTILLISM_DEFAULTS.dotScale;

    dotSizeFactor = POINTILLISM_DEFAULTS.dotSizeFactor;

    strokeAspect = POINTILLISM_DEFAULTS.strokeAspect;

    roundness = POINTILLISM_DEFAULTS.roundness;

    strokeSoftness = POINTILLISM_DEFAULTS.strokeSoftness;

    strokeLength = POINTILLISM_DEFAULTS.strokeLength;

    strokeWidth = POINTILLISM_DEFAULTS.strokeWidth;

    shapeJitter = POINTILLISM_DEFAULTS.shapeJitter;

    paintThickness = POINTILLISM_DEFAULTS.paintThickness;

    paintOpacity = POINTILLISM_DEFAULTS.paintOpacity;

    paintGrain = POINTILLISM_DEFAULTS.paintGrain;

    saturation = POINTILLISM_DEFAULTS.saturation;

    lumaLevels = POINTILLISM_DEFAULTS.lumaLevels;

    contrastDotMix = POINTILLISM_DEFAULTS.contrastDotMix;

    warmCoolSplit = POINTILLISM_DEFAULTS.warmCoolSplit;

    paletteStrength = POINTILLISM_DEFAULTS.paletteStrength;

    paletteIndex = POINTILLISM_DEFAULTS.paletteIndex;

    sourceStructureBlend = POINTILLISM_DEFAULTS.sourceStructureBlend;

    highlightSparsity = POINTILLISM_DEFAULTS.highlightSparsity;

    darkDensityBoost = POINTILLISM_DEFAULTS.darkDensityBoost;

    seed = POINTILLISM_DEFAULTS.seed;

    minVisibleAlpha = POINTILLISM_DEFAULTS.minVisibleAlpha;

    dotRadiusPx = POINTILLISM_DEFAULTS.dotRadiusPx;

    gapSpacing = POINTILLISM_DEFAULTS.gapSpacing;

    denoiseStrength = POINTILLISM_DEFAULTS.denoiseStrength;

    gapFill = POINTILLISM_DEFAULTS.gapFill;

    postEffectEnabled = POINTILLISM_DEFAULTS.postEffectEnabled;

    stippleSize = POINTILLISM_DEFAULTS.stippleSize;

    levels = POINTILLISM_DEFAULTS.levels;

    levelRange = POINTILLISM_DEFAULTS.levelRange;

    ditherSpread = POINTILLISM_DEFAULTS.ditherSpread;

    skyboxPointillismStrength = POINTILLISM_DEFAULTS.skyboxPointillismStrength;

    skyDotVisualMatch = POINTILLISM_DEFAULTS.skyDotVisualMatch;

    paperStrength = POINTILLISM_DEFAULTS.paperStrength;

    paperTint: [number, number, number] = [...POINTILLISM_DEFAULTS.paperTint];

    edgeStrength = POINTILLISM_DEFAULTS.edgeStrength;

    initialize() {
        super.initialize();
        this.on('enable', () => this.applyPostConfig(true));
        this.on('disable', () => {
            this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
            this.pushSkyboxPointillismUniforms();
            (this.app as { __global?: { events?: { fire: (name: string) => void } } }).__global?.events?.fire('postEffect:changed');
            this.app.renderNextFrame = true;
        });

        const global = (this.app as { __global?: { events?: { on: Function; off: Function } } }).__global;
        const onCameraPipelineChanged = () => {
            if (!this.enabled) {
                return;
            }
            this.app.once('frameend', () => {
                this.syncMaterialsAndShaders();
                this.updateEffect(this.effectTime, 0);
            });
        };
        const onSkyboxShaderPatched = () => {
            if (this.enabled) {
                this.pushSkyboxPointillismUniforms();
            }
        };
        global?.events?.on('postEffect:changed', onCameraPipelineChanged);
        global?.events?.on('skyboxShader:patched', onSkyboxShaderPatched);
        const onSkyboxTextureApplied = () => {
            if (!this.enabled) {
                return;
            }
            this.pushSkyboxPointillismUniforms();
            this.app.renderNextFrame = true;
        };
        global?.events?.on('skyboxTexture:applied', onSkyboxTextureApplied);
        this.on('destroy', () => {
            global?.events?.off('postEffect:changed', onCameraPipelineChanged);
            global?.events?.off('skyboxShader:patched', onSkyboxShaderPatched);
            global?.events?.off('skyboxTexture:applied', onSkyboxTextureApplied);
        });
    }

    private getAppState() {
        return (this.app as { __global?: { state?: import('../../../../types').State } }).__global?.state;
    }

    /** 一次性 reveal 独占 gsplatModifyVS 时，点彩仅保留 gsplatPS patch，不写 modify */
    private shouldSuppressPointillismModifyForOneShotReveal(): boolean {
        return isOneShotRevealPlayingExclusiveGsplat(this.getAppState());
    }

    private usesPointillismComposerPath(): boolean {
        return nightModeUsesComposerPath() && !!(this.app as any).effectsRuntime?.composer;
    }

    private getEffectsRuntime(): any {
        return (this.app as any).effectsRuntime ?? null;
    }

    setupUnifiedEventListener() {
        if (skipUnifiedMaterialListener(this.entity)) {
            return;
        }
        super.setupUnifiedEventListener();
    }

    private _postMountWanted: boolean | undefined;

    /** UI / 协议热更新：同步 uniform 与后处理（对齐 palette-pixel / yiyun-dianran） */
    applyConfig() {
        this._viewPosDirty = true;
        this.syncMaterialsAndShaders();
        this.updateEffect(this.effectTime, 0);
        this.applyPostConfig(false);
        this.app.renderNextFrame = true;
    }

    /** 仅刷新后处理挂载（对齐 yiyun-dianran.applyPostEffectConfig） */
    applyPostEffectConfig() {
        this.applyPostConfig(true);
        this.app.renderNextFrame = true;
    }

    getShaderGLSL() {
        return pointillismModifyGlsl;
    }

    getShaderWGSL() {
        return pointillismModifyWgsl;
    }

    private readonly resolveCameraFrame = (): CameraFrame | null => {
        return (this.app as { getCameraFrame?: () => CameraFrame | null | undefined }).getCameraFrame?.() ?? null;
    };

    applyPostConfig(forceCameraReconfigure = false) {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
        if (!camera) {
            return;
        }

        const cameraRecreated = !this._postController || this._camera !== camera;
        if (cameraRecreated) {
            this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
            this._postController = new PointillismPostController(this.app, camera);
            this._camera = camera;
        }

        const wantPost = this.enabled && coercePointillismBool(
            this.postEffectEnabled,
            POINTILLISM_DEFAULTS.postEffectEnabled
        );
        const mountChanged = forceCameraReconfigure
            || cameraRecreated
            || this._postMountWanted !== wantPost;
        this._postMountWanted = wantPost;

        const global = (this.app as { __global?: { events?: { fire: (name: string) => void } } }).__global;

        // 仅在挂载状态变化时通知 CameraFrame；避免调点径等参数时反复 configureCamera 导致材质脱节
        if (mountChanged && wantPost) {
            global?.events?.fire('postEffect:changed');
        }

        this._postController.apply(this.buildPostSettings(), {
            getCameraFrame: this.resolveCameraFrame
        });

        if (mountChanged && !wantPost) {
            global?.events?.fire('postEffect:changed');
        }
    }

    private buildPostSettings() {
        const contrastDotMix = clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX);
        const edgeStrength = clamp(this.edgeStrength, 0, 1);
        return {
            enabled: this.enabled,
            postEffectEnabled: coercePointillismBool(
                this.postEffectEnabled,
                POINTILLISM_DEFAULTS.postEffectEnabled
            ),
            stippleSize: this.stippleSize,
            paletteIndex: this.paletteIndex,
            paletteStrength: this.paletteStrength,
            levels: this.levels,
            levelRange: this.levelRange,
            ditherSpread: this.ditherSpread,
            warmCoolSplit: this.warmCoolSplit,
            sourceStructureBlend: this.sourceStructureBlend,
            saturation: this.saturation,
            complementaryMix: resolvePointillismComplementaryMix(contrastDotMix),
            contrastDotMix,
            dotRadiusPx: clamp(
                Number.isFinite(this.dotRadiusPx) ? this.dotRadiusPx : POINTILLISM_DEFAULTS.dotRadiusPx,
                0.25,
                POINTILLISM_DOT_RADIUS_PX_MAX
            ),
            gapSpacing: clamp(
                Number.isFinite(this.gapSpacing) ? this.gapSpacing : POINTILLISM_DEFAULTS.gapSpacing,
                POINTILLISM_GAP_SPACING_MIN,
                POINTILLISM_GAP_SPACING_MAX
            ),
            seed: this.seed,
            paperStrength: this.paperStrength,
            paperTint: [...this.paperTint],
            edgeThreshold: resolvePointillismEdgeThreshold(edgeStrength),
            edgeStrength,
            denoiseStrength: clamp(
                Number.isFinite(this.denoiseStrength)
                    ? this.denoiseStrength
                    : POINTILLISM_DEFAULTS.denoiseStrength,
                0,
                1
            ),
            gapFill: clamp(
                Number.isFinite(this.gapFill) ? this.gapFill : POINTILLISM_DEFAULTS.gapFill,
                0,
                1
            ),
            skyboxPointillismStrength: this.enabled
                ? clamp(
                    Number.isFinite(this.skyboxPointillismStrength)
                        ? this.skyboxPointillismStrength
                        : POINTILLISM_DEFAULTS.skyboxPointillismStrength,
                    0,
                    1
                )
                : 0
        };
    }

    applyShaderToMaterial(material: Material) {
        this.patchFragmentShader(material);
        if (!this.shouldSuppressPointillismModifyForOneShotReveal() && !this.usesPointillismComposerPath()) {
            super.applyShaderToMaterial(material);
        }
        this.materialsApplied.add(material);
        this.markUniformReplayNeeded();
        this.pushPointillismUniforms();
    }

    applyShaders() {
        if (!this.usesPointillismComposerPath()) {
            super.applyShaders();
            if (!this.shouldSuppressPointillismModifyForOneShotReveal()) {
                for (const material of this.materialsApplied) {
                    this.ensureModifyShader(material);
                }
            }
        } else {
            if (this.entity.gsplat?.unified) {
                this.applyToUnifiedMaterials();
            } else {
                this.applyToComponentMaterial();
            }
            if (this.shouldSuppressPointillismModifyForOneShotReveal()) {
                this.suppressPointillismComposerContribution();
            } else {
                this._pointillismComposerSuppressed = false;
                this.syncPointillismComposerContribution();
            }
        }
        this.markUniformReplayNeeded();
        this.pushPointillismUniforms();
        this.applyPostConfig(true);
    }

    private collectActiveUnifiedMaterials(): Set<Material> {
        const out = new Set<Material>();
        // @ts-ignore runtime gsplat system
        const gsplatSystem = this.app.systems.gsplat;
        const scene = this.app.scene;
        const composition = scene.layers;
        const componentLayers = this.entity.gsplat?.layers;
        if (!gsplatSystem || !componentLayers) {
            return out;
        }

        let targetCameras;
        if (this.camera?.camera) {
            const inner = this.camera.camera.camera;
            targetCameras = inner ? [inner] : composition.cameras.map((c) => c.camera);
        } else {
            targetCameras = composition.cameras.map((cameraComponent) => cameraComponent.camera);
        }

        for (const camera of targetCameras) {
            for (const layerId of componentLayers) {
                if (camera.layers.indexOf(layerId) < 0) {
                    continue;
                }
                const layer = composition.getLayerById(layerId);
                if (!layer) {
                    continue;
                }
                const material = gsplatSystem.getGSplatMaterial(camera, layer);
                if (material) {
                    out.add(material);
                }
            }
        }
        return out;
    }

    /** LOD / CameraFrame 换材质后：刷新材质集合并补 gsplatPS / gsplatModifyVS */
    private syncMaterialsAndShaders(): boolean {
        if (!this.enabled || !this.initialized) {
            return false;
        }

        let repaired = false;

        if (this.entity.gsplat?.unified) {
            const active = this.collectActiveUnifiedMaterials();
            for (const material of [...this.materialsApplied]) {
                if (!active.has(material)) {
                    this.restoreFragmentShader(material);
                    this.materialsApplied.delete(material);
                }
            }
            for (const material of active) {
                if (!this.materialsApplied.has(material)) {
                    this.applyShaderToMaterial(material);
                    this.materialsApplied.add(material);
                    repaired = true;
                } else if (this.ensureFragmentShaderPatch(material)) {
                    repaired = true;
                }
            }
            if (active.size > 0) {
                this.needsRetry = false;
            }
        } else {
            for (const material of [...this.materialsApplied]) {
                if (this.ensureFragmentShaderPatch(material)) {
                    repaired = true;
                }
            }
        }

        if (!this.shouldSuppressPointillismModifyForOneShotReveal()) {
            if (this.usesPointillismComposerPath()) {
                if (this.syncPointillismComposerContribution()) {
                    repaired = true;
                }
            } else {
                for (const material of this.materialsApplied) {
                    if (this.ensureModifyShader(material)) {
                        repaired = true;
                    }
                }
            }
        }

        return repaired;
    }

    private syncPointillismComposerContribution(): boolean {
        const rt = this.getEffectsRuntime();
        if (!rt?.composer || this.materialsApplied.size === 0) {
            return false;
        }
        if (this.shouldSuppressPointillismModifyForOneShotReveal()) {
            this.suppressPointillismComposerContribution();
            return false;
        }
        if (pointillismUsesRegistryComposerPath()) {
            rt.syncPersistentGsplatRegistryFromSettings?.();
            rt.applySceneGsplatFromRegistry(POINTILLISM_STIPPLE_REGISTRY_EFFECT_ID, this.materialsApplied, {
                revision: this._pointillismComposerRev
            });
            return true;
        }
        const shaderBlocks = extractGlslWgslModifyBlocks(pointillismModifyGlsl, pointillismModifyWgsl);
        rt.applySceneGsplatContribution(
            {
                id: POINTILLISM_STIPPLE_COMPOSER_ID,
                priority: 30,
                scope: 'scene',
                enabled: true,
                version: this._pointillismComposerRev,
                shaderBlocks,
                capabilities: { allowConcurrentWithPersistent: true }
            },
            this.materialsApplied
        );
        return true;
    }

    private suppressPointillismComposerContribution(): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.removeSceneGsplatContribution || this.materialsApplied.size === 0) {
            return;
        }
        if (this._pointillismComposerSuppressed) {
            return;
        }
        rt.removeSceneGsplatContribution(POINTILLISM_STIPPLE_COMPOSER_ID, new Set(this.materialsApplied));
        this._pointillismComposerSuppressed = true;
    }

    private fragmentPatchMarker(material: Material): boolean {
        const device = this.app.graphicsDevice as GraphicsDevice;
        const lang = device?.isWebGPU ? SHADERLANGUAGE_WGSL : SHADERLANGUAGE_GLSL;
        const modifyPs = material.getShaderChunks(lang).get('gsplatModifyPS');
        return typeof modifyPs === 'string' && modifyPs.includes('pointillismShapeUV');
    }

    private ensureFragmentShaderPatch(material: Material): boolean {
        if (this.fragmentPatchMarker(material)) {
            return false;
        }
        if (this._savedFragmentChunks.has(material)) {
            this._savedFragmentChunks.delete(material);
        }
        this.patchFragmentShader(material);
        return true;
    }

    private ensureModifyShader(material: Material): boolean {
        if (this.usesPointillismComposerPath()) {
            return false;
        }
        const device = this.app.graphicsDevice as GraphicsDevice;
        const lang = device?.isWebGPU ? SHADERLANGUAGE_WGSL : SHADERLANGUAGE_GLSL;
        const expectedModify = lang === SHADERLANGUAGE_WGSL ? this.getShaderWGSL() : this.getShaderGLSL();
        const modifyChunk = material.getShaderChunks(lang).get('gsplatModifyVS');
        const modifyOk = typeof modifyChunk === 'string'
            && modifyChunk.includes('uPointillismDotScale')
            && modifyChunk.includes('modifySplatColor');
        if (modifyOk) {
            return false;
        }
        material.getShaderChunks(lang).set('gsplatModifyVS', expectedModify);
        material.update();
        return true;
    }

    removeShaders() {
        const mats = new Set(this.materialsApplied);
        for (const material of mats) {
            this.restoreFragmentShader(material);
        }
        for (const material of this._savedFragmentChunks.keys()) {
            if (!mats.has(material)) {
                this.restoreFragmentShader(material);
            }
        }

        if (this.usesPointillismComposerPath()) {
            const rt = this.getEffectsRuntime();
            if (rt?.removeSceneGsplatContribution && mats.size > 0) {
                rt.removeSceneGsplatContribution(POINTILLISM_STIPPLE_COMPOSER_ID, mats);
            } else if (rt?.composer && mats.size > 0) {
                rt.composer.removeContribution(POINTILLISM_STIPPLE_COMPOSER_ID);
                rt.composer.compose();
                const last = rt.composer.getLastComposition();
                if (last) {
                    rt.composer.applyComposedToMaterials(mats, last);
                }
            }
            this.materialsApplied.clear();
            this._pointillismComposerSuppressed = false;
        } else {
            super.removeShaders();
        }

        this._uniformScalars.clear();
        this._uniformReplayNeeded = true;
        this._viewPosUniformDirty = true;

        this._postMountWanted = undefined;
        this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
        this.pushSkyboxPointillismUniforms();
        (this.app as { __global?: { events?: { fire: (name: string) => void } } }).__global?.events?.fire('postEffect:changed');
    }

    private patchFragmentShader(material: Material): void {
        if (this._savedFragmentChunks.has(material)) return;

        try {
            const saved: SavedFragmentChunks = {
                gsplatModifyPS: {
                    glsl: material.getShaderChunks(SHADERLANGUAGE_GLSL).get('gsplatModifyPS') ?? undefined,
                    wgsl: material.getShaderChunks(SHADERLANGUAGE_WGSL).get('gsplatModifyPS') ?? undefined
                }
            };
            material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyPS', pointillismModifyPsGlsl);
            material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatModifyPS', pointillismModifyPsWgsl);
            material.clearVariants();
            material.update();
            this._savedFragmentChunks.set(material, saved);
        } catch (e) {
            console.warn('[pointillism-stipple] failed to patch splat fragment shader:', e);
            this.restoreFragmentShader(material);
        }
    }

    private restoreFragmentShader(material: Material): void {
        const saved = this._savedFragmentChunks.get(material);
        if (!saved) return;

        const modifyPs = saved.gsplatModifyPS;
        if (modifyPs.glsl === undefined) {
            material.getShaderChunks(SHADERLANGUAGE_GLSL).delete('gsplatModifyPS');
        } else {
            material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyPS', modifyPs.glsl);
        }
        if (modifyPs.wgsl === undefined) {
            material.getShaderChunks(SHADERLANGUAGE_WGSL).delete('gsplatModifyPS');
        } else {
            material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatModifyPS', modifyPs.wgsl);
        }
        material.clearVariants();
        material.update();
        this._savedFragmentChunks.delete(material);
    }

    private readonly _viewPos = new Float32Array(3);
    private readonly _viewPosScratch = new Vec3();
    private readonly _lastViewPosScratch = new Vec3();
    private readonly _uniformScalars = new Map<string, number>();
    private _uniformReplayNeeded = true;
    private _viewPosUniformDirty = true;
    private _refViewDistCache = 0;
    private _syncFrameCounter = 0;
    private _viewPosDirty = true;

    private markUniformReplayNeeded(): void {
        this._uniformReplayNeeded = true;
        this._viewPosUniformDirty = true;
    }

    private setUniformCached(name: string, value: number): void {
        const prev = this._uniformScalars.get(name);
        if (!this._uniformReplayNeeded && prev === value) {
            return;
        }
        this._uniformScalars.set(name, value);
        this.setUniform(name, value);
    }

    private setViewPosUniformIfDirty(): void {
        if (!this._viewPosUniformDirty && !this._uniformReplayNeeded) {
            return;
        }
        this._viewPosUniformDirty = false;
        this.setUniform(PU.viewPos, this._viewPos);
    }

    private resolveRefViewDist(camWorld: Vec3 | undefined): number {
        if (this._refViewDistCache > 0) {
            return this._refViewDistCache;
        }
        const gsplat = this.entity.gsplat as {
            customAabb?: { halfExtents: Vec3 };
            resource?: { aabb?: { halfExtents: Vec3 } };
        } | undefined;
        const he = gsplat?.customAabb?.halfExtents ?? gsplat?.resource?.aabb?.halfExtents;
        if (he) {
            this._refViewDistCache = Math.max(he.x, he.y, he.z) * 3.0;
        } else if (camWorld) {
            this._refViewDistCache = Math.max(this.entity.getPosition().distance(camWorld), 1.0);
        } else {
            this._refViewDistCache = 10.0;
        }
        return this._refViewDistCache;
    }

    updateEffect(_effectTime: number, _dt: number) {
        this._syncFrameCounter += 1;
        if (this._syncFrameCounter >= 90) {
            this._syncFrameCounter = 0;
            if (this.syncMaterialsAndShaders()) {
                this.app.renderNextFrame = true;
            }
        }
        this.pushPointillismUniforms();
        this.syncPostSettingsOnly();

        if (this.usesPointillismComposerPath() && this.materialsApplied.size > 0) {
            if (this.shouldSuppressPointillismModifyForOneShotReveal()) {
                this.suppressPointillismComposerContribution();
            } else if (this._pointillismComposerSuppressed) {
                this._pointillismComposerSuppressed = false;
                this.syncPointillismComposerContribution();
            }
        }
    }

    /** 每帧轻量同步 post uniform（不重挂载 CameraFrame） */
    private syncPostSettingsOnly(): void {
        if (!this._postController) {
            return;
        }
        const wantPost = this.enabled && coercePointillismBool(
            this.postEffectEnabled,
            POINTILLISM_DEFAULTS.postEffectEnabled
        );
        if (!wantPost) {
            return;
        }
        this._postController.syncSettings(this.buildPostSettings());
    }

    private pushSkyboxPointillismUniforms() {
        const contrastDotMix = clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX);
        const colorVibration = clamp(
            Number.isFinite(this.colorVibration) ? this.colorVibration : this.contrastDotMix,
            0,
            1
        );
        const strength = this.enabled
            ? clamp(
                Number.isFinite(this.skyboxPointillismStrength)
                    ? this.skyboxPointillismStrength
                    : POINTILLISM_DEFAULTS.skyboxPointillismStrength,
                0,
                1
            )
            : 0;

        const brushSize = Number.isFinite(this.brushSize)
            ? this.brushSize
            : POINTILLISM_DEFAULTS.brushSize;
        const brushAspect = Number.isFinite(this.brushAspect)
            ? this.brushAspect
            : this.strokeAspect;
        const brushHardness = Number.isFinite(this.brushHardness)
            ? this.brushHardness
            : 1 - this.strokeSoftness;

        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera;
        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        const canvasHeight = Math.max(canvas?.clientHeight ?? 720, 1);
        const fovRad = ((camera?.fov ?? 45) * Math.PI) / 180;
        const typicalPx = resolvePointillismDotRadiusPx(this.dotRadiusPx, this.stippleSize, brushSize);
        const slopes = resolvePointillismDotRadiusSlopes(typicalPx, canvasHeight, fovRad);
        const dotRadiusPx = clamp(
            Number.isFinite(this.dotRadiusPx) ? this.dotRadiusPx : POINTILLISM_DEFAULTS.dotRadiusPx,
            0.25,
            POINTILLISM_DOT_RADIUS_PX_MAX
        );
        const gapSpacing = clamp(
            Number.isFinite(this.gapSpacing) ? this.gapSpacing : POINTILLISM_DEFAULTS.gapSpacing,
            POINTILLISM_GAP_SPACING_MIN,
            POINTILLISM_GAP_SPACING_MAX
        );
        const dotScale = clamp(this.dotScale, 0.85, 1.15);
        const skyDotVisualMatch = clamp(
            Number.isFinite(this.skyDotVisualMatch)
                ? this.skyDotVisualMatch
                : POINTILLISM_DEFAULTS.skyDotVisualMatch,
            POINTILLISM_SKY_DOT_VISUAL_MATCH_MIN,
            POINTILLISM_SKY_DOT_VISUAL_MATCH_MAX
        );
        const skyMetrics = computeSkyboxPointillismMetrics(
            slopes.typical,
            gapSpacing,
            dotScale,
            skyDotVisualMatch
        );

        applySkyboxPointillismUniforms(this.app, {
            strength,
            angularSpacing: skyMetrics.angularSpacing,
            rxCellScale: skyMetrics.rxCellScale,
            dotRadiusSlope: slopes.min,
            dotRadiusPx,
            dotScale,
            gapSpacing,
            saturation: clamp(this.saturation, 0, 3),
            levelRange: clamp(this.levelRange, 0.5, 2),
            warmCoolSplit: clamp(this.warmCoolSplit, 0, 1),
            colorVibration,
            contrastDotMix,
            seed: Number.isFinite(this.seed) ? this.seed : POINTILLISM_DEFAULTS.seed,
            strokeLength: clamp(
                this.strokeLength,
                POINTILLISM_STROKE_LENGTH_MIN,
                POINTILLISM_STROKE_LENGTH_MAX
            ),
            strokeWidth: clamp(
                this.strokeWidth,
                POINTILLISM_STROKE_WIDTH_MIN,
                POINTILLISM_STROKE_WIDTH_MAX
            ),
            brushAspect: clamp(brushAspect, 0.5, 1.2),
            brushHardness: clamp(brushHardness, 0, 1),
            paintGrain: clamp(
                Number.isFinite(this.paintGrain) ? this.paintGrain : POINTILLISM_DEFAULTS.paintGrain,
                0,
                1
            ),
            paperStrength: clamp(this.paperStrength, 0, 1),
            paperTint: [...this.paperTint] as [number, number, number]
        });
    }

    private pushPointillismUniforms() {
        this.pushSkyboxPointillismUniforms();
        const brushSize = Number.isFinite(this.brushSize)
            ? this.brushSize
            : POINTILLISM_DEFAULTS.brushSize;
        const brushAspect = Number.isFinite(this.brushAspect)
            ? this.brushAspect
            : this.strokeAspect;
        const brushHardness = Number.isFinite(this.brushHardness)
            ? this.brushHardness
            : 1 - this.strokeSoftness;
        const colorVibration = Number.isFinite(this.colorVibration)
            ? this.colorVibration
            : this.contrastDotMix;
        const darkPaintBoost = Number.isFinite(this.darkPaintBoost)
            ? this.darkPaintBoost
            : this.darkDensityBoost;
        const highlightSkip = Number.isFinite(this.highlightSkip)
            ? this.highlightSkip
            : this.highlightSparsity;

        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera;
        const camWorld = cameraEntity?.getPosition();
        const unified = !!(this.entity.gsplat as { unified?: boolean } | undefined)?.unified;
        if (camWorld) {
            if (unified) {
                this._viewPosScratch.copy(camWorld);
            } else {
                this._viewPosScratch.set(-camWorld.x, -camWorld.y, camWorld.z);
            }
            if (this._viewPosDirty || this._viewPosScratch.distance(this._lastViewPosScratch) > 0.01) {
                this._lastViewPosScratch.copy(this._viewPosScratch);
                this._viewPos[0] = this._viewPosScratch.x;
                this._viewPos[1] = this._viewPosScratch.y;
                this._viewPos[2] = this._viewPosScratch.z;
                this._viewPosDirty = false;
                this._viewPosUniformDirty = true;
            }
        }

        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        const canvasHeight = Math.max(canvas?.clientHeight ?? 720, 1);
        const fovRad = ((camera?.fov ?? 45) * Math.PI) / 180;
        const typicalPx = resolvePointillismDotRadiusPx(this.dotRadiusPx, this.stippleSize, brushSize);
        const slopes = resolvePointillismDotRadiusSlopes(typicalPx, canvasHeight, fovRad);
        const refViewDist = this.resolveRefViewDist(camWorld);
        const bucketSlope = slopes.typical * 1.75;

        this.setViewPosUniformIfDirty();
        this.setUniformCached(PU.dotRadiusSlope, slopes.min);
        this.setUniformCached(PU.typicalDotRadiusSlope, slopes.typical);
        this.setUniformCached(PU.maxDotRadiusSlope, slopes.max);
        this.setUniformCached(PU.refViewDist, refViewDist);
        this.setUniformCached(PU.bucketSlope, bucketSlope);
        this.setUniformCached(PU.brushSize, 1.0);
        this.setUniformCached(PU.brushAspect, clamp(brushAspect, 0.5, 1.2));
        this.setUniformCached(PU.brushHardness, clamp(brushHardness, 0, 1));
        this.setUniformCached(PU.colorVibration, clamp(colorVibration, 0, 1));
        this.setUniformCached(PU.darkPaintBoost, clamp(darkPaintBoost, 0, 1));
        this.setUniformCached(PU.highlightSkip, clamp(highlightSkip, 0, 1));
        this.setUniformCached(PU.dotScale, clamp(this.dotScale, 0.85, 1.15));
        this.setUniformCached(PU.dotSizeFactor, clamp(this.dotSizeFactor, 0.01, 0.32));
        this.setUniformCached(PU.strokeAspect, clamp(this.strokeAspect, 0.85, 2.2));
        this.setUniformCached(PU.roundness, clamp(this.roundness, 0, 1));
        this.setUniformCached(PU.strokeSoftness, clamp(this.strokeSoftness, 0.08, 0.55));
        this.setUniformCached(PU.strokeLength, clamp(this.strokeLength, POINTILLISM_STROKE_LENGTH_MIN, POINTILLISM_STROKE_LENGTH_MAX));
        this.setUniformCached(PU.strokeWidth, clamp(this.strokeWidth, POINTILLISM_STROKE_WIDTH_MIN, POINTILLISM_STROKE_WIDTH_MAX));
        this.setUniformCached(PU.shapeJitter, clamp(this.shapeJitter, 0, 0.08));
        this.setUniformCached(PU.paintThickness, clamp(this.paintThickness, 0.5, 1.5));
        this.setUniformCached(PU.paintOpacity, clamp(this.paintOpacity, POINTILLISM_PAINT_OPACITY_MIN, POINTILLISM_PAINT_OPACITY_MAX));
        this.setUniformCached(
            PU.paintGrain,
            clamp(
                Number.isFinite(this.paintGrain) ? this.paintGrain : POINTILLISM_DEFAULTS.paintGrain,
                POINTILLISM_PAINT_GRAIN_MIN,
                POINTILLISM_PAINT_GRAIN_MAX
            )
        );
        this.setUniformCached(PU.saturation, clamp(this.saturation, 0, 3));
        this.setUniformCached(PU.lumaLevels, clamp(Math.floor(this.lumaLevels), 2, 24));
        this.setUniformCached(PU.contrastDotMix, clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX));
        this.setUniformCached(
            PU.complementaryMix,
            resolvePointillismComplementaryMix(clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX))
        );
        this.setUniformCached(PU.warmCoolSplit, clamp(this.warmCoolSplit, 0, 1));
        this.setUniformCached(PU.paletteStrength, clamp(this.paletteStrength, 0, 1));
        this.setUniformCached(PU.paletteIndex, clamp(Math.floor(this.paletteIndex), 0, 3));
        this.setUniformCached(PU.sourceStructureBlend, clamp(this.sourceStructureBlend, 0, 1));
        this.setUniformCached(PU.highlightSparsity, clamp(this.highlightSparsity, 0, 1));
        this.setUniformCached(PU.darkDensityBoost, clamp(this.darkDensityBoost, 0, 1));
        this.setUniformCached(PU.seed, Number.isFinite(this.seed) ? this.seed : POINTILLISM_DEFAULTS.seed);
        const denoiseT = clamp(
            Number.isFinite(this.denoiseStrength)
                ? this.denoiseStrength
                : POINTILLISM_DEFAULTS.denoiseStrength,
            0,
            1
        );
        this.setUniformCached(PU.denoiseStrength, denoiseT);
        this.setUniformCached(
            PU.minVisibleAlpha,
            resolvePointillismMinVisibleAlpha(denoiseT)
        );
        this.setUniformCached(
            PU.gapFill,
            clamp(
                Number.isFinite(this.gapFill) ? this.gapFill : POINTILLISM_DEFAULTS.gapFill,
                0,
                1
            )
        );
        this.setUniformCached(
            PU.gapSpacing,
            clamp(
                Number.isFinite(this.gapSpacing) ? this.gapSpacing : POINTILLISM_DEFAULTS.gapSpacing,
                POINTILLISM_GAP_SPACING_MIN,
                POINTILLISM_GAP_SPACING_MAX
            )
        );

        if (this.materialsApplied.size > 0) {
            this._uniformReplayNeeded = false;
        }
    }

    destroy() {
        super.destroy();
        this._postController?.destroy();
        this._postController = null;
        this._camera = null;
    }
}

export { GsplatPersistentPointillismStipple };
