import type { Vec3 } from 'playcanvas';
import type { Global } from '../../types';
import type { ExperienceSettings } from '../../schemas/v2';
import { pickWorldFromClientXY } from '../../picker/index';
import { updatePointLightsFromSettings } from '../../light';
import { ensureBloom, ensureBloomEditorSession } from '../../settings-serialize/settings-serialize-helper';
import { allocateNextUserLightId, applyLightAdd } from '../../editor-modules/protocol-adapters/environment-protocol-adapter';
import type { WorldSpaceBloomData } from './world-space-bloom-data';
import { parseKind } from './brush-view';

/** 屏幕笔刷半径映射到世界半径时的缩放系数：<1 可减少“2D 预览偏大、3D 结果偏肥” */
const BRUSH_WORLD_RADIUS_SCALE = 0.65;

/** committed 点集质心，用于新建区域时落默认点光位置 */
function committedCentroid(committed: Array<{ position?: [number, number, number] }>): [number, number, number] | null {
    if (!Array.isArray(committed) || committed.length === 0) return null;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    for (const c of committed) {
        const p = c?.position;
        if (!p || p.length < 3) continue;
        sx += p[0];
        sy += p[1];
        sz += p[2];
        n++;
    }
    if (n === 0) return null;
    return [sx / n, sy / n, sz / n];
}

type LightBrushMessage = {
    type?: string;
    payload?: {
        id?: string;
        value?: unknown;
        tintColor?: number[];
        tintBlend?: number;
        /**
         * 是否跳过 FINISH 内自动 `LIGHT_ADD`。**未传视为 `true`**（父级分步建灯）；显式 `false` 时与子应用内「完成」一致自动绑灯。
         */
        skipAutoLinkedLight?: boolean;
    };
};

export interface BloomBrushFlowContext {
    global: Global;
    worldSpaceData: WorldSpaceBloomData;
    getIsDrawing(): boolean;
    setIsDrawing(v: boolean): void;
    getIsErasing(): boolean;
    setIsErasing(v: boolean): void;
    hasActiveLocalLightRegion(): boolean;
    fireWorldSpaceChanged(): void;
    invalidateBrushCaches(): void;
    saveWorldSpaceConfig(): void;
    syncCommittedToNightMode(): void;
    exportRegion(): { worldSpaceJSON: { committed?: unknown[] } | null; committedBrightness: number };
    getCurrentRegionCenter(): Vec3 | null;
}

export class BloomBrushFlowController {
    private readonly ctx: BloomBrushFlowContext;

    constructor(ctx: BloomBrushFlowContext) {
        this.ctx = ctx;
    }

    handleMessageBridgeLightBrush = (data: LightBrushMessage): void => {
        const t = data?.type;
        const payload = (data?.payload ?? {}) as {
            id?: string;
            value?: unknown;
            tintColor?: number[];
            tintBlend?: number;
            skipAutoLinkedLight?: boolean;
        };

        const createdDraftForToolStart = this.ensureDraftForBrushStart(t);
        if (!this.ctx.hasActiveLocalLightRegion()) {
            return;
        }

        switch (t) {
        case 'LIGHT_BRUSH_START':
            this.handleBrushStart(createdDraftForToolStart);
            break;
        case 'LIGHT_ERASER_START':
            this.handleEraserStart();
            break;
        case 'LIGHT_BRUSH_CLEAR':
            this.handleBrushClear();
            break;
        case 'LIGHT_BRUSH_COLOR_UPDATE':
            this.handleBrushColorUpdate(payload);
            break;
        case 'LIGHT_BRUSH_FINISH':
            this.handleBrushFinish(payload);
            break;
        case 'LIGHT_BRUSH_BLOOM_UPDATE':
            this.handleBrushBloomUpdate(payload);
            break;
        default:
            break;
        }
    };

    handlePointerDown = (e: PointerEvent): void => {
        if (!this.isBloomBrushEnabled()) return;
        if (this.isInteractiveTarget(e.target)) return;
        if (e.button !== 0) return;
        if (!this.isInsideCanvas(e.clientX, e.clientY)) return;

        if (this.ensureDraftWhenRegionsEmpty()) {
            this.ctx.global.events.fire('postEffect:changed');
        }
        this.ctx.setIsDrawing(true);
        e.preventDefault();
        e.stopPropagation();

        const canvas = this.ctx.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        pickWorldFromClientXY(this.ctx.global, e.clientX, e.clientY).then(worldPos => {
            if (!worldPos) return;
            if (!Number.isFinite(worldPos.x) || !Number.isFinite(worldPos.y) || !Number.isFinite(worldPos.z)) return;
            const bloom = this.ctx.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
            const brushSize = Math.max(0.1, Number(bloom?.bloomBrushSize ?? 10));
            const cameraPos = this.ctx.global.camera.getPosition();
            const distance = worldPos.distance(cameraPos);
            const sceneCam = (this.ctx.global.camera as { camera?: { camera?: { fov?: number } } }).camera?.camera;
            const fovDeg = sceneCam?.fov ?? 60;
            const fovRad = (fovDeg * Math.PI) / 180;
            const canvasHeight = canvas.clientHeight || canvas.height;
            if (canvasHeight <= 0 || distance <= 0.001) return;
            const worldRadius = ((brushSize * 2 * distance * Math.tan(fovRad / 2)) / canvasHeight) * BRUSH_WORLD_RADIUS_SCALE;
            if (!Number.isFinite(worldRadius) || worldRadius <= 0) return;
            if (this.ctx.getIsErasing()) {
                this.ctx.worldSpaceData.eraseAt(worldPos, worldRadius);
            } else {
                this.ctx.worldSpaceData.addPoint(worldPos, worldRadius, 1.0);
            }
            this.ctx.fireWorldSpaceChanged();
            (this.ctx.global.app as any).renderNextFrame = true;

            if (!this.ctx.getIsDrawing()) {
                this.ctx.invalidateBrushCaches();
                this.ctx.global.events.fire('postEffect:changed');
            }
        });
    };

    handlePointerMove = (e: PointerEvent): void => {
        if (!this.ctx.getIsDrawing()) return;
        if (this.ensureDraftWhenRegionsEmpty()) {
            this.ctx.global.events.fire('postEffect:changed');
        }

        if (this.isInteractiveTarget(e.target)) {
            this.ctx.setIsDrawing(false);
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const canvas = this.ctx.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        pickWorldFromClientXY(this.ctx.global, e.clientX, e.clientY).then(worldPos => {
            if (!worldPos) return;
            if (!Number.isFinite(worldPos.x) || !Number.isFinite(worldPos.y) || !Number.isFinite(worldPos.z)) return;
            const bloom = this.ctx.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
            const brushSize = Math.max(0.1, Number(bloom?.bloomBrushSize ?? 10));
            const cameraPos = this.ctx.global.camera.getPosition();
            const distance = worldPos.distance(cameraPos);
            const sceneCam = (this.ctx.global.camera as { camera?: { camera?: { fov?: number } } }).camera?.camera;
            const fovDeg = sceneCam?.fov ?? 60;
            const fovRad = (fovDeg * Math.PI) / 180;
            const canvasHeight = canvas.clientHeight || canvas.height;
            if (canvasHeight <= 0 || distance <= 0.001) return;
            const worldRadius = ((brushSize * 2 * distance * Math.tan(fovRad / 2)) / canvasHeight) * BRUSH_WORLD_RADIUS_SCALE;
            if (!Number.isFinite(worldRadius) || worldRadius <= 0) return;
            if (this.ctx.getIsErasing()) {
                this.ctx.worldSpaceData.eraseAt(worldPos, worldRadius);
            } else {
                this.ctx.worldSpaceData.addPoint(worldPos, worldRadius, 1.0);
            }
            this.ctx.fireWorldSpaceChanged();
            (this.ctx.global.app as any).renderNextFrame = true;

            if (!this.ctx.getIsDrawing()) {
                this.ctx.invalidateBrushCaches();
                this.ctx.global.events.fire('postEffect:changed');
            }
        });
    };

    handlePointerUp = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        if (!this.ctx.getIsDrawing()) return;

        this.ctx.setIsDrawing(false);
        e.preventDefault();
        e.stopPropagation();
        this.ctx.invalidateBrushCaches();
        this.ctx.fireWorldSpaceChanged();
        (this.ctx.global.app as any).renderNextFrame = true;
        this.ctx.global.events.fire('postEffect:changed');
    };

    private exp(): ExperienceSettings {
        return this.ctx.global.settings as ExperienceSettings;
    }

    private ensureBloomSettings(): ReturnType<typeof ensureBloom> {
        return ensureBloom(this.exp());
    }

    private ensureBloomSes(): ReturnType<typeof ensureBloomEditorSession> {
        return ensureBloomEditorSession(this.exp());
    }

    private getActiveRegionId(): string | null {
        const id = this.ensureBloomSes().activeLocalLightRegionId;
        return typeof id === 'string' && id.trim().length > 0 ? id : null;
    }

    /**
     * 尚无已提交 `localLightRegions` 时，绘制真源只能是草稿：若 active 非 `draft-*`，在此处与 START 对齐并写入 `draft-*`，
     * 避免渲染侧再用「有笔迹即当草稿」兜底。
     * @returns 是否新写了 `draft-*`
     */
    private ensureDraftWhenRegionsEmpty(): boolean {
        const bloom = this.ensureBloomSettings();
        const regions = bloom.localLightRegions ?? [];
        if (regions.length > 0) return false;
        const ses = this.ensureBloomSes();
        if (!ses.bloomBrush) return false;
        const raw = ses.activeLocalLightRegionId;
        if (parseKind(raw) === 'draft') return false;
        const draftId = `draft-${Date.now()}`;
        ses.activeLocalLightRegionId = draftId;
        this.ctx.global.events.fire('bloomLocalLightRegion:listChanged');
        return true;
    }

    private ensureDraftForBrushStart(type: string | undefined): boolean {
        if (type !== 'LIGHT_BRUSH_START') return false;
        const ses = this.ensureBloomSes();
        const activeIdForStart = ses.activeLocalLightRegionId;
        // 当前版本仅支持“新增亮灯区域草稿”，不支持对已有 region 二次绘制编辑。
        // 因此：只要当前 active 不是 draft-*，就强制创建新的 draft。
        const shouldCreateDraftForStart = parseKind(activeIdForStart) !== 'draft';
        if (!shouldCreateDraftForStart) return false;
        const bloom = this.ensureBloomSettings();
        const draftId = `draft-${Date.now()}`;
        ses.activeLocalLightRegionId = draftId;
        if (!Array.isArray(bloom.localLightRegions)) {
            bloom.localLightRegions = [];
        }
        this.ctx.global.events.fire('bloomLocalLightRegion:listChanged');
        return true;
    }

    private switchBrushToolState(erasing: boolean): void {
        this.ctx.setIsDrawing(false);
        this.ctx.setIsErasing(erasing);
        this.ctx.worldSpaceData.setEraseMode(erasing);
    }

    private handleBrushStart(createdDraftForToolStart: boolean): void {
        const bloom = this.ensureBloomSettings();
        const ses = this.ensureBloomSes();
        ses.bloomBrush = true;
        if (typeof bloom.bloomBrushBrightness !== 'number') bloom.bloomBrushBrightness = 1;
        if (bloom.enabled === false) bloom.enabled = true;
        this.switchBrushToolState(false);
        if (createdDraftForToolStart) {
            this.ctx.global.events.fire('bloomBrush:reset');
        }
        this.ctx.global.events.fire('postEffect:changed');
        (this.ctx.global.app as any).renderNextFrame = true;
    }

    private handleEraserStart(): void {
        this.ensureBloomSettings();
        this.ensureBloomSes().bloomBrush = true;
        this.switchBrushToolState(true);
        this.ctx.global.events.fire('postEffect:changed');
        (this.ctx.global.app as any).renderNextFrame = true;
    }

    private handleBrushClear(): void {
        this.ensureBloomSettings();
        const ses = this.ensureBloomSes();
        this.ctx.global.events.fire('bloomBrush:reset');
        ses.bloomBrush = false;
        this.switchBrushToolState(false);
        const activeId = ses.activeLocalLightRegionId as string | null | undefined;
        if (parseKind(activeId) === 'draft') {
            ses.activeLocalLightRegionId = null;
        }
        this.ctx.global.events.fire('bloomLocalLightRegion:listChanged');
        this.ctx.global.events.fire('postEffect:changed');
        (this.ctx.global.app as any).renderNextFrame = true;
    }

    private handleBrushColorUpdate(payload: { id?: string; value?: unknown; tintColor?: number[]; tintBlend?: number }): void {
        const bloom = this.ensureBloomSettings();
        const regions = (bloom as any).localLightRegions as any[] | undefined;
        const activeId = this.ensureBloomSes().activeLocalLightRegionId as string | null | undefined;
        const targetId = typeof payload.id === 'string' && payload.id.length > 0
            ? payload.id
            : (activeId ?? null);
        if (!targetId) return;

        const v = (payload.value as any) ?? {};
        const tintColorArr =
            Array.isArray(v?.tintColor) ? v.tintColor :
                (Array.isArray((payload as any).color) ? (payload as any).color : (Array.isArray(payload.tintColor) ? payload.tintColor : null));
        const tintBlendVal =
            typeof v?.tintBlend === 'number' ? v.tintBlend :
                (typeof (payload as any).tintBlend === 'number' ? (payload as any).tintBlend : null);

        if (!Array.isArray(regions)) return;
        const region = regions.find((r) => r && r.id === targetId);
        if (!region) return;

        if (Array.isArray(tintColorArr) && tintColorArr.length >= 3) {
            const r = Math.max(0, Math.min(1, Number(tintColorArr[0]) || 0));
            const g = Math.max(0, Math.min(1, Number(tintColorArr[1]) || 0));
            const b = Math.max(0, Math.min(1, Number(tintColorArr[2]) || 0));
            region.tintColor = [r, g, b];
        }
        if (typeof tintBlendVal === 'number') {
            region.tintBlend = Math.max(0, Math.min(1, tintBlendVal));
        }
        const linkedId = (region as any).linkedLightId as string | null | undefined;
        if (linkedId && Array.isArray(region.tintColor) && region.tintColor.length >= 3) {
            try {
                const settingsAny = this.ctx.global.settings as any;
                const lighting = settingsAny.lighting;
                if (lighting && Array.isArray(lighting.lights)) {
                    const lightsAny = lighting.lights as any[];
                    const light = lightsAny.find((l) => l && (l as any).id === linkedId);
                    if (light) {
                        const [lr, lg, lb] = region.tintColor as [number, number, number];
                        (light as any).color = [
                            Math.max(0, Math.min(1, lr)),
                            Math.max(0, Math.min(1, lg)),
                            Math.max(0, Math.min(1, lb))
                        ];
                        updatePointLightsFromSettings(this.ctx.global);
                    }
                }
            } catch {
                // 忽略联动失败，保证 Bloom 协议本身正常
            }
        }

        this.ctx.global.events.fire('postEffect:changed');
        (this.ctx.global.app as any).renderNextFrame = true;
    }

    private handleBrushFinish(payload: { id?: string; skipAutoLinkedLight?: boolean }): void {
        this.ctx.worldSpaceData.commit();
        const bloom = this.ensureBloomSettings();
        const ses = this.ensureBloomSes();
        const brightness = typeof bloom.bloomBrushBrightness === 'number'
            ? Math.max(-1, Math.min(1, bloom.bloomBrushBrightness))
            : 1;
        this.ctx.worldSpaceData.setCommittedBrightness(brightness);
        ses.bloomBrush = false;
        this.switchBrushToolState(false);
        this.ctx.saveWorldSpaceConfig();
        const hasExistingRegionsFinish = Array.isArray(bloom.localLightRegions) &&
            bloom.localLightRegions.some((r: any) => r?.worldSpace?.committed?.length > 0);
        if (hasExistingRegionsFinish) {
            this.ctx.invalidateBrushCaches();
        } else {
            this.ctx.syncCommittedToNightMode();
        }
        const activeId = this.getActiveRegionId();
        const isDraftActive = parseKind(activeId) === 'draft';
        const { worldSpaceJSON, committedBrightness } = this.ctx.exportRegion();
        const committed = worldSpaceJSON?.committed ?? [];
        if (isDraftActive) {
            const center = this.ctx.getCurrentRegionCenter();
            if (committed.length > 0) {
                if (!Array.isArray((bloom as any).localLightRegions)) {
                    (bloom as any).localLightRegions = [];
                }
                const regions = (bloom as any).localLightRegions as any[];
                const nextIndex = regions.length + 1;
                const incomingRegionId = typeof payload.id === 'string' && payload.id.trim().length > 0
                    ? payload.id.trim()
                    : `region-${Date.now()}`;
                const existingIndex = regions.findIndex((r: any) => r && r.id === incomingRegionId);
                const prevLinked =
                    existingIndex >= 0 ? ((regions[existingIndex] as any)?.linkedLightId as string | null | undefined) : undefined;
                const inheritedLinkedId =
                    typeof prevLinked === 'string' && prevLinked.trim().length > 0 ? prevLinked.trim() : null;
                const newRegion = {
                    id: incomingRegionId,
                    name: `亮灯区域${String(nextIndex).padStart(2, '0')}`,
                    worldSpace: worldSpaceJSON,
                    localBrightness: Math.max(-1, Math.min(1, committedBrightness ?? brightness)),
                    tintColor: [1, 1, 1] as [number, number, number],
                    tintBlend: 0,
                    linkedLightId: inheritedLinkedId
                };
                if (existingIndex >= 0) {
                    regions[existingIndex] = newRegion as any;
                } else {
                    regions.push(newRegion as any);
                }
                ses.activeLocalLightRegionId = newRegion.id;
                // 与自动绑灯时 `applyLightAdd(..., pos)` 一致的位置优先级，供父级随后 `LIGHT_ADD(id)`（无 position 时读 `draftLightRegionCenter`）及本机自动绑灯共用
                const cen = committedCentroid(committed as Array<{ position?: [number, number, number] }>);
                const pos: [number, number, number] | null = cen
                    ? cen
                    : center
                        ? [center.x, center.y, center.z]
                        : ses.draftLightRegionCenter
                            ? [
                                ses.draftLightRegionCenter[0],
                                ses.draftLightRegionCenter[1],
                                ses.draftLightRegionCenter[2]
                            ]
                            : null;
                if (pos) {
                    ses.draftLightRegionCenter = [pos[0], pos[1], pos[2]];
                } else {
                    ses.draftLightRegionCenter = null;
                }
                // 未传 / true：FINISH 仅落区域，不自动建灯（与父级一致；本机 UI 在 internal 下于 FINISH 后再调 `applyLightAdd`）；仅显式 `skipAutoLinkedLight: false` 时单步自动点光并绑定
                const skipAutoLinkedLight = payload.skipAutoLinkedLight !== false;
                // 新正式区域若无绑灯：仅当 `skipAutoLinkedLight === false`（强制单步）时在此 `applyLightAdd`；否则依赖后续 `LIGHT_ADD` 或宿主 UI 第二步
                if (!inheritedLinkedId && committed.length > 0 && pos && !skipAutoLinkedLight) {
                    const lid = allocateNextUserLightId(this.ctx.global.settings as ExperienceSettings);
                    applyLightAdd(this.ctx.global, lid, true, pos);
                } else if (!inheritedLinkedId && committed.length > 0 && skipAutoLinkedLight) {
                    this.ctx.global.events.fire('postEffect:changed');
                }
                this.ctx.global.events.fire('bloomLocalLightRegion:listChanged');
            } else {
                ses.activeLocalLightRegionId = null;
                ses.draftLightRegionCenter = null;
            }
        }
        (this.ctx.global.app as any).renderNextFrame = true;
    }

    private handleBrushBloomUpdate(payload: { id?: string; value?: unknown }): void {
        const bloom = this.ensureBloomSettings();
        const ses = this.ensureBloomSes();
        if (typeof payload.value === 'number') {
            const v = Math.max(-1, Math.min(1, payload.value));
            const targetId = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null;
            if (targetId && Array.isArray((bloom as any).localLightRegions)) {
                const regions = (bloom as any).localLightRegions as any[];
                const target = regions.find((r) => r && r.id === targetId);
                if (target) {
                    target.localBrightness = v;
                    const activeId = ses.activeLocalLightRegionId as string | null | undefined;
                    if (activeId === targetId && parseKind(activeId) === 'saved') {
                        // 当前区域正在编辑时，同步工作区亮度，避免体积与工作区状态短暂不一致。
                        this.ctx.worldSpaceData.setCommittedBrightness(v);
                    }
                } else {
                    bloom.bloomBrushBrightness = v;
                }
            } else {
                // 无指定区域 id 时，沿用原语义：更新当前绘制会话亮度（草稿态）。
                bloom.bloomBrushBrightness = v;
            }
            this.ctx.global.events.fire('postEffect:changed');
            (this.ctx.global.app as any).renderNextFrame = true;
        }
    }

    private hasActiveLocalLightRegion(): boolean {
        return this.ctx.hasActiveLocalLightRegion();
    }

    private isBloomBrushEnabled(): boolean {
        return !!this.ensureBloomSes().bloomBrush && this.hasActiveLocalLightRegion();
    }

    private isInsideCanvas(clientX: number, clientY: number): boolean {
        const canvas = this.ctx.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    private isInteractiveTarget(target: EventTarget | null): boolean {
        if (!target || !(target instanceof Node)) return false;
        const el = target as HTMLElement;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'a') return true;
        if (el.closest?.('input, button, select, textarea, a[href], [role="slider"], [contenteditable="true"]')) return true;
        if (el.closest?.('.postEffectSliderWrap, .postEffectOption')) return true;
        return false;
    }
}
