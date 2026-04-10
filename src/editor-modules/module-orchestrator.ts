import type { Global, ModuleContext, ModuleFacade } from '../types';

class ModuleOrchestrator {
    private readonly global: Global;

    private readonly facades = new Map<string, ModuleFacade>();

    private readonly offHandlers: Array<() => void> = [];
    private activeModule: string | null = null;

    constructor(global: Global) {
        this.global = global;
    }

    registerFacade(facade: ModuleFacade) {
        this.facades.set(facade.module, facade);
    }

    unregisterFacade(module: string) {
        this.facades.delete(module);
    }

    start() {
        const { events } = this.global;
        this.activeModule = this.global.state.editLeftModule ?? null;

        const onEditLeftModuleChanged = (nextModule: string | null) => {
            const ctx = this.buildContext();
            if (!ctx.editMode) return;
            const prevModule = this.activeModule;
            const normalizedNext = nextModule ?? null;
            if (normalizedNext === prevModule) return;

            if (prevModule && this.facades.has(prevModule)) {
                this.facades.get(prevModule)?.onExit(ctx, 'editModuleChange');
            }
            if (normalizedNext && this.facades.has(normalizedNext)) {
                this.facades.get(normalizedNext)?.onEnter(ctx);
            }
            this.activeModule = normalizedNext;
        };

        const onEditModeChanged = (editMode: boolean) => {
            const ctx = this.buildContext();
            if (!editMode) {
                this.facades.forEach((facade) => facade.onEditModeExit(ctx));
                this.activeModule = null;
                return;
            }
            const active = ctx.activeModule;
            if (active && this.facades.has(active)) {
                this.facades.get(active)?.onEnter(ctx);
            }
            this.activeModule = active ?? null;
        };

        events.on('editLeftModule:changed', onEditLeftModuleChanged);
        events.on('editMode:changed', onEditModeChanged);

        this.offHandlers.push(() => events.off('editLeftModule:changed', onEditLeftModuleChanged));
        this.offHandlers.push(() => events.off('editMode:changed', onEditModeChanged));
    }

    dispose() {
        const ctx = this.buildContext();
        this.offHandlers.splice(0).forEach((off) => off());
        this.facades.forEach((facade) => facade.dispose?.(ctx));
        this.facades.clear();
    }

    private buildContext(): ModuleContext {
        const { state, events } = this.global;
        return {
            global: this.global,
            state,
            events,
            activeModule: state.editLeftModule ?? null,
            editMode: !!state.editMode
        };
    }
}

const initModuleOrchestrator = (global: Global) => {
    const orchestrator = new ModuleOrchestrator(global);
    orchestrator.start();
    return orchestrator;
};

export { ModuleOrchestrator, initModuleOrchestrator };
