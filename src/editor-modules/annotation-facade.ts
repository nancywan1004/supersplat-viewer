import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';

class AnnotationFacade implements ModuleFacade {
    readonly module = 'annotation' as const;

    onEnter(ctx: ModuleContext): void {
        ctx.events.fire('annotationFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        const manager = (ctx.global as any).annotationManager;
        // 兜底清理：无论 UI 是否挂载都保证选中与 gizmo 收敛
        ctx.events.fire('gizmo:detach');
        manager?.deselectAnnotation?.();
        ctx.events.fire('annotationFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this.onExit(ctx);
        ctx.events.fire('annotationFacade:editModeExit');
    }

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        if (command.type === 'ANNOTATION_EDIT') {
            const id = (command.payload as any)?.id ?? null;
            this.selectById(ctx, id, command.source ?? 'unknown');
        }
    }

    selectById(ctx: ModuleContext, id: string | null, source: SelectionSource): void {
        const manager = (ctx.global as any).annotationManager;
        if (!id) {
            manager?.deselectAnnotation?.();
            return;
        }
        manager?.selectAnnotation?.(id, { showGizmo: false, source });
    }
}

const initAnnotationFacade = (global: Global): ModuleFacade => {
    const facade = new AnnotationFacade();
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__annotationFacade = facade;
    (global as any).__commandRegistry?.register?.('annotation', facade);
    return facade;
};

export { AnnotationFacade, initAnnotationFacade };
