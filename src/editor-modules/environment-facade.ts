import { setLightsVisualVisible } from '../light';
import { ensureBloomEditorSession } from '../settings-serialize/settings-serialize-helper';
import {
    applyBloomBlurSet,
    applyBloomIntensityUpdate,
    applyBloomIsLocalSet,
    applyBloomLocalLightRegionDelete,
    applyBloomLocalLightRegionInnerAngleSet,
    applyBloomLocalLightRegionIntensityUpdate,
    applyBloomLocalLightRegionOuterAngleSet,
    applyBloomLocalLightRegionRangeSet,
    applyBloomThresholdUpdate,
    applyLightAdd,
    applyLightCopy,
    applyLightDelete,
    applyLightDetail,
    applyLightGlobalSet,
    applyLightSelect,
    applyLightRegionUpdate,
    applyLightToggle,
    applyLightToggleAll,
    applyLightTransformMode,
    applyLightUpdate,
    applyShadowDirectionSet,
    applyShadowIntensityUpdate,
    applyShadowSet,
    applyTorchParamsSet,
    applyTorchToggle
} from './protocol-adapters/environment-protocol-adapter';
import type { TorchLightSettings } from '../schemas/v2-custom';
import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';
import type { InputArbiter } from '../input-arbiter';
import { isEnvironmentDebugVisualEnabled } from '../state-selectors';
import { setPlacementCursorActive } from '../placement-cursor';

type Payload = Record<string, unknown>;

const getEnvironmentVisualToggle = (global: Global): boolean => {
    const v = (global.app as any).__lightsVisualToggle;
    return typeof v === 'boolean' ? v : true;
};

function applyEnvironmentPreviewVisualPolicy(global: Global): void {
    const { state } = global;
    const gizmoVisible = isEnvironmentDebugVisualEnabled(state);
    const lightWireframeVisible = getEnvironmentVisualToggle(global) && gizmoVisible;
    setLightsVisualVisible(global, lightWireframeVisible);
}

class EnvironmentFacade implements ModuleFacade {
    readonly module = 'environment' as const;
    private pendingLightPlacement: { id: string; isThreeSixty: boolean; name?: string } | null = null;
    private detachPointerClickClaimHandler: (() => void) | null = null;

    setPointerClickClaimHandlerCleanup(cleanup: () => void): void {
        this.detachPointerClickClaimHandler = cleanup;
    }

    private clearPendingLightPlacement(ctx: ModuleContext): void {
        this.pendingLightPlacement = null;
        setPlacementCursorActive(ctx.global, false);
    }

    private startLightPlacement(ctx: ModuleContext, id: string, isThreeSixty: boolean, name?: string): void {
        this.pendingLightPlacement = { id, isThreeSixty, name };
        setPlacementCursorActive(ctx.global, true);
    }

    private hasDraftLightRegionCenter(global: Global): boolean {
        const bloomSes = ensureBloomEditorSession(global.settings as any);
        const center = bloomSes.draftLightRegionCenter;
        return Array.isArray(center)
            && center.length >= 3
            && Number.isFinite(center[0])
            && Number.isFinite(center[1])
            && Number.isFinite(center[2]);
    }

    handlePointerClickClaim(global: Global, worldPosition: { x: number; y: number; z: number } | null): boolean {
        const pending = this.pendingLightPlacement;
        if (!pending) return false;
        if (!global.state.editMode || global.state.editLeftModule !== 'environment') return false;
        if (!worldPosition) return true;
        const position = worldPosition;
        const x = Number((position as { x?: number }).x);
        const y = Number((position as { y?: number }).y);
        const z = Number((position as { z?: number }).z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return true;

        this.pendingLightPlacement = null;
        setPlacementCursorActive(global, false);
        applyLightAdd(global, pending.id, pending.isThreeSixty, [x, y, z], pending.name);
        global.events.fire('sceneLight:placed', { id: pending.id, source: 'scene' as SelectionSource });
        global.events.fire('sceneLight:selected', { id: pending.id, source: 'scene' as SelectionSource });
        return true;
    }

    private syncPreviewVisualPolicy(ctx: ModuleContext): void {
        applyEnvironmentPreviewVisualPolicy(ctx.global);
    }

    onEnter(ctx: ModuleContext): void {
        ctx.state.lightTransformMode = 'move';
        ctx.events.fire('lightTransformMode:changed', 'move');
        this.syncPreviewVisualPolicy(ctx);
        ctx.events.fire('environmentFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        this.clearPendingLightPlacement(ctx);
        // 离开 environment（切到 null 或其他模块）时，若当前是 draft 区域则清理草稿与笔刷会话，
        // 避免笔刷模式残留在非环境模块。
        const bloomSes = ensureBloomEditorSession(ctx.global.settings as any);
        const activeRegionId = bloomSes.activeLocalLightRegionId;
        if (typeof activeRegionId === 'string' && activeRegionId.startsWith('draft-')) {
            ctx.events.fire('messageBridge:lightBrush', { type: 'LIGHT_BRUSH_CLEAR', payload: {} });
        }

        ctx.state.selectedLightId = null;
        ctx.state.lightTransformMode = 'move';
        ctx.events.fire('sceneLight:selected', { id: null, source: 'host' as SelectionSource });
        ctx.events.fire('lightTransformMode:changed', 'move');
        this.syncPreviewVisualPolicy(ctx);
        ctx.events.fire('environmentFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this.clearPendingLightPlacement(ctx);
        this.onExit(ctx);
        ctx.events.fire('environmentFacade:editModeExit');
    }

    onPreviewModeChanged(ctx: ModuleContext): void {
        this.syncPreviewVisualPolicy(ctx);
    }

    dispose(): void {
        this.pendingLightPlacement = null;
        this.detachPointerClickClaimHandler?.();
        this.detachPointerClickClaimHandler = null;
    }

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        const g = ctx.global;
        const src: SelectionSource = command.source ?? 'host';
        const pl = (command.payload ?? {}) as Payload;

        switch (command.type) {
        case 'LIGHT_GLOBAL_SET': {
            const v = pl.value;
            if (typeof v === 'number') applyLightGlobalSet(g, v);
            break;
        }
        case 'LIGHT_TOGGLE_ALL': {
            const v = pl.value;
            if (typeof v === 'boolean') applyLightToggleAll(g, v);
            break;
        }
        case 'LIGHT_TOGGLE': {
            const id = pl.id;
            const v = pl.value;
            if (typeof id === 'string' && typeof v === 'boolean') applyLightToggle(g, id, v);
            break;
        }
        case 'BLOOM_INTENSITY_UPDATE': {
            const v = pl.value;
            if (typeof v === 'number') applyBloomIntensityUpdate(g, v);
            break;
        }
        case 'BLOOM_THRESHOLD_UPDATE': {
            const v = pl.value;
            if (typeof v === 'number') applyBloomThresholdUpdate(g, v);
            break;
        }
        case 'BLOOM_BLUR_SET': {
            const v = pl.value;
            if (typeof v === 'number') applyBloomBlurSet(g, v);
            break;
        }
        case 'BLOOM_IS_LOCAL_SET': {
            const v = pl.value;
            if (typeof v === 'boolean') applyBloomIsLocalSet(g, v);
            break;
        }
        case 'SHADOW_SET': {
            const v = pl.value;
            if (typeof v === 'boolean') applyShadowSet(g, v);
            break;
        }
        case 'SHADOW_INTENSITY_UPDATE': {
            const v = pl.value;
            if (typeof v === 'number') applyShadowIntensityUpdate(g, v);
            break;
        }
        case 'SHADOW_DIRECTION_SET': {
            const v = pl.value;
            if (typeof v === 'number') applyShadowDirectionSet(g, v);
            break;
        }
        case 'LIGHT_ADD': {
            if (typeof pl.id === 'string') {
                const t = pl.isThreeSixty;
                const isThreeSixty = typeof t === 'boolean' ? t : true;
                const name = typeof pl.name === 'string' ? pl.name : undefined;
                // 当 LIGHT_BRUSH_FINISH 已写入区域中心时，沿用原有"中心+绑灯"语义直接建灯，
                // 避免多余的二次场景点击放置；无中心时仍走点击放置。
                if (this.hasDraftLightRegionCenter(g)) {
                    this.clearPendingLightPlacement(ctx);
                    applyLightAdd(g, pl.id, isThreeSixty, undefined, name);
                    // draftRegion 直接建灯触发 placed，source 用 'scene' 与点击放置对齐
                    g.events.fire('sceneLight:placed', { id: pl.id, source: 'scene' as SelectionSource });
                } else {
                    this.startLightPlacement(ctx, pl.id, isThreeSixty, name);
                }
            }
            break;
        }
        case 'LIGHT_DELETE': {
            if (typeof pl.id === 'string') applyLightDelete(g, pl.id);
            break;
        }
        case 'LIGHT_COPY': {
            const sid = pl.id;
            const cid = pl.copyId;
            const cname = pl.copyName;
            if (typeof sid === 'string' && typeof cid === 'string' && cid.trim().length > 0) {
                applyLightCopy(g, sid, cid, typeof cname === 'string' ? cname : undefined);
            }
            break;
        }
        case 'LIGHT_SELECT': {
            const targetId = pl.id !== undefined ? (pl.id as string | null) : null;
            this.selectById(ctx, targetId, src);
            break;
        }
        case 'LIGHT_TRANSFORM_MODE':
            applyLightTransformMode(g, pl.value as 'move' | 'rotate' | null | undefined);
            break;
        case 'LIGHT_INTENSITY_UPDATE':
        case 'LIGHT_COLOR_UPDATE':
        case 'LIGHT_INNER_ANGLE_SET':
        case 'LIGHT_OUTER_ANGLE_SET':
        case 'LIGHT_RANGE_SET':
            applyLightDetail(g, command.type, pl as { id?: string; value?: number | number[] | boolean });
            break;
        case 'LIGHT_UPDATE': {
            const id = pl.id;
            const v = pl.value;
            if (typeof id === 'string' && typeof v === 'object' && v !== null) {
                applyLightUpdate(g, id, v as { name?: string });
            }
            break;
        }
        case 'LIGHT_REGION_UPDATE': {
            const id = pl.id;
            const v = pl.value;
            if (typeof id === 'string' && typeof v === 'object' && v !== null) {
                applyLightRegionUpdate(g, id, v as { name?: string });
            }
            break;
        }
        case 'LIGHT_BRUSH_DELETE':
            applyBloomLocalLightRegionDelete(g, typeof pl.id === 'string' ? pl.id : '');
            break;
        case 'LIGHT_BRUSH_INTENSITY_UPDATE': {
            const id = typeof pl.id === 'string' ? pl.id : '';
            const v = pl.value;
            if (typeof v === 'number') applyBloomLocalLightRegionIntensityUpdate(g, id, v);
            break;
        }
        case 'LIGHT_BRUSH_INNER_ANGLE_SET': {
            const id = typeof pl.id === 'string' ? pl.id : '';
            const v = pl.value;
            if (typeof v === 'number') applyBloomLocalLightRegionInnerAngleSet(g, id, v);
            break;
        }
        case 'LIGHT_BRUSH_OUTER_ANGLE_SET': {
            const id = typeof pl.id === 'string' ? pl.id : '';
            const v = pl.value;
            if (typeof v === 'number') applyBloomLocalLightRegionOuterAngleSet(g, id, v);
            break;
        }
        case 'LIGHT_BRUSH_RANGE_SET': {
            const id = typeof pl.id === 'string' ? pl.id : '';
            const v = pl.value;
            if (typeof v === 'number') applyBloomLocalLightRegionRangeSet(g, id, v);
            break;
        }
        case 'LIGHT_BRUSH_START':
        case 'LIGHT_ERASER_START':
        case 'LIGHT_BRUSH_CLEAR':
        case 'LIGHT_BRUSH_COLOR_UPDATE':
        case 'LIGHT_BRUSH_FINISH':
        case 'LIGHT_BRUSH_BLOOM_UPDATE':
            ctx.events.fire('messageBridge:lightBrush', { type: command.type, payload: pl });
            break;
        case 'TORCH_TOGGLE': {
            const v = pl.value;
            if (typeof v === 'boolean') applyTorchToggle(g, v);
            break;
        }
        case 'TORCH_PARAMS_SET': {
            const v = pl.value;
            if (v && typeof v === 'object') {
                applyTorchParamsSet(g, v as Partial<TorchLightSettings>);
            }
            break;
        }
        default:
            break;
        }
    }

    selectById(ctx: ModuleContext, id: string | null, source: SelectionSource): void {
        applyLightSelect(ctx.global, id, source);
    }
}

const initEnvironmentFacade = (global: Global): ModuleFacade => {
    const facade = new EnvironmentFacade();
    const inputArbiter = (global as any).__inputArbiter as InputArbiter | undefined;
    if (inputArbiter) {
        const unregister = inputArbiter.registerPointerClickHandler({
            id: 'environment.light-placement',
            priority: 200,
            handle: ({ worldPosition }) => facade.handlePointerClickClaim(global, worldPosition as { x: number; y: number; z: number } | null)
        });
        facade.setPointerClickClaimHandlerCleanup(unregister);
    }
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__environmentFacade = facade;
    (global as any).__commandRegistry?.register?.('environment', facade);
    return facade;
};

export { EnvironmentFacade, initEnvironmentFacade };
export { applyEnvironmentPreviewVisualPolicy };
