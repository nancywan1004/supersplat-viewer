import { setLightsVisualVisible } from '../light';
import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';

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
        if (command.type === 'LIGHT_SELECT') {
            const id = (command.payload as any)?.id ?? null;
            this.selectById(ctx, id, command.source ?? 'unknown');
        }
    }

    selectById(ctx: ModuleContext, id: string | null, source: SelectionSource): void {
        ctx.state.selectedLightId = id;
        ctx.events.fire('sceneLight:selected', { id, source });
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

export { EnvironmentFacade, initEnvironmentFacade };
