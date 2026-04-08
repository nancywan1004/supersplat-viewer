import type { Global, ModuleCommand, ModuleContext, ModuleFacade } from '../types';

type ModuleKey = 'asset' | 'annotation' | 'environment' | 'effects';

type RegistryDispatchInput = {
    module: ModuleKey;
    command: ModuleCommand;
};

class CommandRegistry {
    private readonly global: Global;

    private readonly facadeByModule = new Map<ModuleKey, ModuleFacade>();

    constructor(global: Global) {
        this.global = global;
    }

    register(module: ModuleKey, facade: ModuleFacade) {
        this.facadeByModule.set(module, facade);
    }

    unregister(module: ModuleKey) {
        this.facadeByModule.delete(module);
    }

    dispatch(input: RegistryDispatchInput): boolean {
        const facade = this.facadeByModule.get(input.module);
        if (!facade) return false;
        facade.handleCommand(this.buildContext(), input.command);
        return true;
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

const initCommandRegistry = (global: Global) => {
    const registry = new CommandRegistry(global);
    (global as any).__commandRegistry = registry;
    return registry;
};

export { CommandRegistry, initCommandRegistry };
