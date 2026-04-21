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
    applyLightDelete,
    applyLightDetail,
    applyLightGlobalSet,
    applyLightSelect,
    applyLightToggle,
    applyLightToggleAll,
    applyLightTransformMode,
    applyShadowDirectionSet,
    applyShadowIntensityUpdate,
    applyShadowSet
} from './protocol-adapters/environment-protocol-adapter';
import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';
import { isEnvironmentDebugVisualEnabled } from '../state-selectors';

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
    private pendingLightPlacement: { id: string; isThreeSixty: boolean } | null = null;
    private detachScenePointerListener: (() => void) | null = null;

    setScenePointerListenerCleanup(cleanup: () => void): void {
        this.detachScenePointerListener = cleanup;
    }

    private clearPendingLightPlacement(ctx: ModuleContext): void {
        this.pendingLightPlacement = null;
        ctx.state.lightPlacementActive = false;
    }

    private startLightPlacement(ctx: ModuleContext, id: string, isThreeSixty: boolean): void {
        this.pendingLightPlacement = { id, isThreeSixty };
        ctx.state.lightPlacementActive = true;
    }

    handleScenePointerWorldClick(global: Global, payload: { position?: { x: number; y: number; z: number } } | { x: number; y: number; z: number }): void {
        const pending = this.pendingLightPlacement;
        if (!pending) return;
        if (!global.state.editMode || global.state.editLeftModule !== 'environment') return;
        const position = (payload as { position?: { x: number; y: number; z: number } })?.position ?? payload;
        if (!position) return;
        const x = Number((position as { x?: number }).x);
        const y = Number((position as { y?: number }).y);
        const z = Number((position as { z?: number }).z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

        this.pendingLightPlacement = null;
        global.state.lightPlacementActive = false;
        applyLightAdd(global, pending.id, pending.isThreeSixty, [x, y, z]);
        global.events.fire('sceneLight:placed', { id: pending.id, source: 'scene' as SelectionSource });
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
        this.detachScenePointerListener?.();
        this.detachScenePointerListener = null;
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
                this.startLightPlacement(ctx, pl.id, typeof t === 'boolean' ? t : true);
            }
            break;
        }
        case 'LIGHT_DELETE': {
            if (typeof pl.id === 'string') applyLightDelete(g, pl.id);
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
    const onScenePointerWorldClick = (payload: { position?: { x: number; y: number; z: number } } | { x: number; y: number; z: number }) => {
        facade.handleScenePointerWorldClick(global, payload);
    };
    global.events.on('scenePointerWorldClick', onScenePointerWorldClick);
    facade.setScenePointerListenerCleanup(() => {
        global.events.off('scenePointerWorldClick', onScenePointerWorldClick);
    });
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__environmentFacade = facade;
    (global as any).__commandRegistry?.register?.('environment', facade);
    return facade;
};

export { EnvironmentFacade, initEnvironmentFacade };
export { applyEnvironmentPreviewVisualPolicy };
