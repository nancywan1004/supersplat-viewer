import { normalizeAnnotationMediaFields } from '../annotation-toolbar/media-fields';
import type { AnnotationData } from '../annotation-toolbar/types';
import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';
import { setPlacementCursorActive } from '../placement-cursor';
import { applyAnnotationShowHideSet } from '../annotation-toolbar/annotation-visibility';

type AnnotationManagerApi = {
    startPlacementWithId?: (id: string) => void;
    cancelAnnotation?: () => void;
    confirmAnnotation?: (form: Record<string, unknown>) => void;
    updateAnnotation?: (id: string, form: Record<string, unknown>) => void;
    deleteAnnotation?: (id: string) => void;
    selectAnnotation?: (id: string, opts: { showGizmo: boolean; source: SelectionSource }) => void;
    deselectAnnotation?: () => void;
    getPlaceholderAnnotation?: () =>
        | { id: string; updateContent?: (form: Record<string, unknown>) => void }
        | null
        | undefined;
    enableGizmoForSelected?: () => void;
    disableGizmoForSelected?: () => void;
};

function formDataFromPartial(value: Partial<AnnotationData> | undefined, allowEmpty: boolean) {
    if (!value) {
        return allowEmpty
            ? { title: '', text: '', showTitleWhenCollapsed: false }
            : null;
    }
    const media = normalizeAnnotationMediaFields({
        imageUrl: value.imageUrl === null ? '' : value.imageUrl,
        videoUrl: value.videoUrl === null ? '' : value.videoUrl
    });
    return {
        title: value.title ?? '',
        text: value.text ?? '',
        imageUrl: media.imageUrl,
        videoUrl: media.videoUrl,
        showTitleWhenCollapsed: value.showTitleWhenCollapsed ?? false
    };
}

class AnnotationFacade implements ModuleFacade {
    readonly module = 'annotation' as const;

    private manager(ctx: ModuleContext): AnnotationManagerApi | undefined {
        return (ctx.global as { annotationManager?: AnnotationManagerApi }).annotationManager;
    }

    onEnter(ctx: ModuleContext): void {
        ctx.state.annotationTransformMode = 'move';
        ctx.events.fire('annotationFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        const manager = this.manager(ctx);
        // 兜底清理：无论 UI 是否挂载都保证选中与 gizmo 收敛
        setPlacementCursorActive(ctx.global, false);
        // 退出 annotation 模块时，强制结束放置会话并清理占位标注，
        // 避免切模块后仍残留 placement active 状态。
        manager?.cancelAnnotation?.();
        ctx.events.fire('gizmo:detach');
        manager?.deselectAnnotation?.();
        ctx.events.fire('annotationFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this.onExit(ctx);
        ctx.events.fire('annotationFacade:editModeExit');
    }

    onPreviewModeChanged(_ctx: ModuleContext): void {}

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        const { state } = ctx;
        const am = this.manager(ctx);
        const src: SelectionSource = command.source ?? 'host';

        switch (command.type) {
        case 'ANNOTATION_PLACEMENT_START': {
            const id = (command.payload as { id?: string } | undefined)?.id;
            if (typeof id === 'string') {
                setPlacementCursorActive(ctx.global, true);
                am?.startPlacementWithId?.(id);
            }
            break;
        }
        case 'ANNOTATION_PLACEMENT_CANCEL':
            setPlacementCursorActive(ctx.global, false);
            am?.cancelAnnotation?.();
            break;
        case 'ANNOTATION_CONFIRM': {
            const pl = command.payload as { id?: string; value?: Partial<AnnotationData> } | undefined;
            const id = pl?.id;
            if (!id || !am) break;
            const formData = formDataFromPartial(pl?.value, true);
            if (!formData) break;
            const placeholder = am.getPlaceholderAnnotation?.();
            if (placeholder && placeholder.id === id) {
                am.confirmAnnotation?.(formData);
                setPlacementCursorActive(ctx.global, false);
            } else {
                am.updateAnnotation?.(id, formData);
            }
            break;
        }
        case 'ANNOTATION_UPDATE': {
            const pl = command.payload as { id?: string; value?: Partial<AnnotationData> } | undefined;
            const id = pl?.id;
            const value = pl?.value;
            if (!id || !value || !am) break;
            const formData = formDataFromPartial(value, false);
            if (!formData) break;
            const placeholder = am.getPlaceholderAnnotation?.();
            if (placeholder && placeholder.id === id) {
                placeholder.updateContent?.(formData);
            } else {
                am.updateAnnotation?.(id, formData);
            }
            break;
        }
        case 'ANNOTATION_DELETE': {
            const id = (command.payload as { id?: string } | undefined)?.id;
            if (typeof id === 'string') am?.deleteAnnotation?.(id);
            break;
        }
        case 'ANNOTATION_EDIT': {
            const id = (command.payload as { id?: string } | undefined)?.id ?? null;
            if (!id) return;
            this.selectById(ctx, id, src);
            ctx.events.fire('annotationEdit:show');
            break;
        }
        case 'ANNOTATION_TRANSFORM_MODE': {
            if (!am) break;
            const raw = (command.payload as { value?: 'move' | null } | undefined)?.value;
            const mode = raw === 'move' ? 'move' : null;
            state.annotationTransformMode = mode;
            if (mode === 'move') {
                am.enableGizmoForSelected?.();
            } else {
                am.disableGizmoForSelected?.();
            }
            break;
        }
        case 'ANNOTATION_SHOW_HIDE_SET': {
            const pl = command.payload as { id?: string; value?: boolean } | undefined;
            if (typeof pl?.id !== 'string' || typeof pl?.value !== 'boolean') break;
            applyAnnotationShowHideSet(ctx.global, pl.id, pl.value);
            break;
        }
        default:
            break;
        }
    }

    selectById(ctx: ModuleContext, id: string | null, source: SelectionSource): void {
        const manager = this.manager(ctx);
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

    // 标注显隐与 View contentVisibility 的套用/恢复由 SceneContentVisibilityRegistry 统一处理

    return facade;
};

export { AnnotationFacade, initAnnotationFacade };
