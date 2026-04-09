import { setLightsVisualVisible } from '../light';
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

type Payload = Record<string, unknown>;

class EnvironmentFacade implements ModuleFacade {
    readonly module = 'environment' as const;

    private getVisualToggle(global: Global): boolean {
        const v = (global.app as any).__lightsVisualToggle;
        return typeof v === 'boolean' ? v : true;
    }

    onEnter(ctx: ModuleContext): void {
        setLightsVisualVisible(ctx.global, this.getVisualToggle(ctx.global));
        ctx.events.fire('environmentFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        ctx.state.selectedLightId = null;
        ctx.state.lightTransformMode = null;
        ctx.events.fire('sceneLight:selected', { id: null, source: 'host' as SelectionSource });
        ctx.events.fire('lightTransformMode:changed', null);
        setLightsVisualVisible(ctx.global, this.getVisualToggle(ctx.global));
        ctx.events.fire('environmentFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this.onExit(ctx);
        ctx.events.fire('environmentFacade:editModeExit');
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
                applyLightAdd(g, pl.id, typeof t === 'boolean' ? t : undefined);
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
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__environmentFacade = facade;
    (global as any).__commandRegistry?.register?.('environment', facade);
    return facade;
};

/**
 * `showEditUI=false`（父级托管、无内置 Lighting 面板）时，在编辑态/左侧模块变化后强制显示光源线框，
 * 避免无人驱动 `__lightsVisualToggle` 时残留错误显隐。与 `onEnter/onExit` 内按 toggle 刷新互补。
 */
function syncLightVisualsForNoEditUi(global: Global): void {
    if (global.config.showEditUI !== false) return;
    setLightsVisualVisible(global, true);
}

export { EnvironmentFacade, initEnvironmentFacade, syncLightVisualsForNoEditUi };
