import type { Global } from '../types';
import type { AssetTransformMode, EditLeftModule, LightTransformMode, AnnotationTransformMode } from '../types';
import { getEditUiTransport, sendEditProtocolMessage } from './edit-ui-transport';

const TRANSFORM_MODES: { id: AssetTransformMode; label: string }[] = [
    { id: 'move', label: '移动' },
    { id: 'rotate', label: '旋转' },
    { id: 'scale', label: '缩放' }
];

const ASSET_HTML = `
<div class="edit-bottom-toolbar-inner">
    <div class="edit-bottom-toolbar-group" role="group" aria-label="变换模式">
        ${TRANSFORM_MODES.map(
            (m) =>
                `<button type="button" class="edit-bottom-toolbar-btn" data-mode="${m.id}" aria-pressed="false">${m.label}</button>`
        ).join('\n        ')}
    </div>
    <div class="edit-bottom-toolbar-divider"></div>
    <div class="edit-bottom-toolbar-group" role="group" aria-label="资产操作">
        <button type="button" class="edit-bottom-toolbar-btn" id="assetEditCopy" data-action="copy">复制</button>
        <button type="button" class="edit-bottom-toolbar-btn edit-bottom-toolbar-btn-danger" id="assetEditDelete" data-action="delete">删除</button>
    </div>
</div>
`.trim();

const ANNOTATION_HTML = `
<div class="edit-bottom-toolbar-inner">
    <div class="edit-bottom-toolbar-group" role="group" aria-label="标注变换">
        <button type="button" class="edit-bottom-toolbar-btn" data-mode="move" aria-pressed="false">移动</button>
    </div>
    <div class="edit-bottom-toolbar-divider"></div>
    <div class="edit-bottom-toolbar-group" role="group" aria-label="标注操作">
        <button type="button" class="edit-bottom-toolbar-btn" id="annotationEditBtn" data-action="edit">编辑</button>
        <button type="button" class="edit-bottom-toolbar-btn edit-bottom-toolbar-btn-danger" id="annotationDeleteBtn" data-action="delete">删除</button>
    </div>
</div>
`.trim();

const ENV_LIGHTING_HTML = `
<div class="edit-bottom-toolbar-inner">
    <div class="edit-bottom-toolbar-group" role="group" aria-label="光源变换">
        <button type="button" class="edit-bottom-toolbar-btn" data-light-mode="move" aria-pressed="false">移动</button>
        <button type="button" class="edit-bottom-toolbar-btn" data-light-mode="rotate" aria-pressed="false">旋转</button>
    </div>
    <div class="edit-bottom-toolbar-divider"></div>
    <div class="edit-bottom-toolbar-group" role="group" aria-label="光源操作">
        <button type="button" class="edit-bottom-toolbar-btn" id="lightEditFocus" data-action="focus">编辑</button>
        <button type="button" class="edit-bottom-toolbar-btn edit-bottom-toolbar-btn-danger" id="lightEditDelete" data-action="delete">删除</button>
    </div>
</div>
`.trim();

function getToolbarHTML(module: EditLeftModule): string {
    if (module === 'annotation') return ANNOTATION_HTML;
    if (module === 'environment') return ENV_LIGHTING_HTML;
    return ASSET_HTML;
}

/**
 * 初始化底部编辑栏 UI。
 * - asset 模块：移动、旋转、缩放；复制、删除
 * - annotation 模块：移动、编辑、删除
 * 显隐由 ui 根据 state.editMode 与 state.editLeftModule 控制挂载点。
 * @returns 清理函数
 */
export function initEditBottomToolbarUI(global: Global): () => void {
    const { state, events } = global;
    const editUiTransport = getEditUiTransport(global);

    let container = document.getElementById('editBottomToolbarMount');
    let root: HTMLElement | null = null;
    if (!container) {
        const ui = document.getElementById('ui');
        if (!ui) return () => {};
        root = document.createElement('div');
        root.id = 'editBottomToolbarMount';
        root.className = 'edit-bottom-toolbar';
        ui.appendChild(root);
        container = root;
    } else {
        container.classList.add('edit-bottom-toolbar');
    }

    const currentModule = (): EditLeftModule | null => (state.editLeftModule ?? null);
    const currentTransformMode = (): AssetTransformMode | undefined => state.assetTransformMode;

    const renderAndBind = () => {
        const module = currentModule();
        if (module == null) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = getToolbarHTML(module);

        if (module === 'asset') {
            bindAssetContent();
        } else if (module === 'annotation') {
            bindAnnotationContent();
        } else if (module === 'environment') {
            bindEnvironmentLightingContent();
        }
    };

    const bindAssetContent = () => {
        const modeButtons = Array.from(
            container.querySelectorAll<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode]')
        );
        const copyBtn = container.querySelector<HTMLButtonElement>('#assetEditCopy');
        const deleteBtn = container.querySelector<HTMLButtonElement>('#assetEditDelete');

        const syncAssetModeButtons = () => {
            const hasSelection = state.selectedSceneEntityId != null;
            const mode = currentTransformMode();
            modeButtons.forEach((btn) => {
                const isActive = hasSelection && mode !== undefined && btn.getAttribute('data-mode') === mode;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
            });
        };

        const setTransformActiveInternal = (mode: AssetTransformMode | undefined) => {
            state.assetTransformMode = mode;
            events.fire('assetTransformMode:changed', mode as any);
            syncAssetModeButtons();
        };

        modeButtons.forEach((btn) => {
            const mode = btn.getAttribute('data-mode') as AssetTransformMode;
            btn.addEventListener('click', () => {
                const current = currentTransformMode();
                const nextMode: AssetTransformMode | undefined =
                    current === mode ? undefined : mode;

                if (editUiTransport === 'message-bridge') {
                    if (nextMode) {
                        sendEditProtocolMessage({ type: 'ASSET_TRANSFORM_MODE', value: nextMode });
                    } else {
                        // 发送不带 value 的命令以清除模式并关闭 Gizmo
                        sendEditProtocolMessage({ type: 'ASSET_TRANSFORM_MODE' });
                    }
                } else {
                    setTransformActiveInternal(nextMode);
                }
            });
        });
        syncAssetModeButtons();

        copyBtn?.addEventListener('click', () => {
            if (editUiTransport === 'message-bridge') {
                console.warn('[EditBottomToolbar] message-bridge 模式下 copyId 需由父级生成并通过 ASSET_COPY 下发');
                return;
            }
            events.fire('assetEdit:copy');
        });
        deleteBtn?.addEventListener('click', () => {
            if (editUiTransport === 'message-bridge') {
                const id = state.selectedSceneEntityId;
                if (typeof id === 'string') {
                    sendEditProtocolMessage({ type: 'ASSET_DELETE', id });
                }
                return;
            }
            events.fire('assetEdit:delete');
        });
    };

    const syncAnnotationMoveButton = () => {
        if (currentModule() !== 'annotation') return;
        const moveBtn = container.querySelector<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode="move"]');
        if (!moveBtn) return;
        const annotationManager = (global as any).annotationManager;
        const hasSelection = annotationManager?.getSelectedAnnotation() != null;
        const isActive = hasSelection && ((state as any).annotationTransformMode === 'move');
        moveBtn.classList.toggle('active', isActive);
        moveBtn.setAttribute('aria-pressed', String(isActive));
    };

    const bindAnnotationContent = () => {
        const moveBtn = container.querySelector<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode="move"]');
        const editBtn = container.querySelector<HTMLButtonElement>('#annotationEditBtn');
        const deleteBtn = container.querySelector<HTMLButtonElement>('#annotationDeleteBtn');

        moveBtn?.addEventListener('click', () => {
            const annotationManager = (global as any).annotationManager;
            if (!annotationManager) return;

            const selected = annotationManager.getSelectedAnnotation?.();
            if (!selected) return;

            const current = ((state as any).annotationTransformMode as AnnotationTransformMode | null | undefined) ?? null;
            const nextMode: AnnotationTransformMode | null = current === 'move' ? null : 'move';
            (state as any).annotationTransformMode = nextMode;

            if (editUiTransport === 'message-bridge') {
                if (nextMode === 'move') {
                    sendEditProtocolMessage({ type: 'ANNOTATION_TRANSFORM_MODE', value: 'move' });
                } else {
                    sendEditProtocolMessage({ type: 'ANNOTATION_TRANSFORM_MODE', value: null });
                }
            } else {
                if (nextMode === 'move') {
                    annotationManager.enableGizmoForSelected?.();
                } else if (annotationManager.disableGizmoForSelected) {
                    annotationManager.disableGizmoForSelected();
                }
            }

            syncAnnotationMoveButton();
        });

        editBtn?.addEventListener('click', () => {
            const annotationManager = (global as any).annotationManager;
            if (!annotationManager) return;
            const selected = annotationManager.getSelectedAnnotation?.();
            if (!selected) return;

            if (editUiTransport === 'message-bridge') {
                // 由协议驱动：父级/协议层统一通过 ANNOTATION_EDIT 触发选中 + 编辑表单
                sendEditProtocolMessage({ type: 'ANNOTATION_EDIT', id: selected.id });
            } else {
                events.fire('annotationEdit:show');
            }
        });

        deleteBtn?.addEventListener('click', () => {
            const annotationManager = (global as any).annotationManager;
            if (annotationManager) {
                const selected = annotationManager.getSelectedAnnotation();
                if (selected) {
                    annotationManager.deleteAnnotation(selected.id);
                }
            }
        });

        syncAnnotationMoveButton();
    };

    const bindEnvironmentLightingContent = () => {
        const modeButtons = Array.from(
            container.querySelectorAll<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-light-mode]')
        );
        const focusBtn = container.querySelector<HTMLButtonElement>('#lightEditFocus');
        const deleteBtn = container.querySelector<HTMLButtonElement>('#lightEditDelete');

        const syncLightModeButtons = () => {
            const hasSelection = (state as any).selectedLightId != null;
            const mode = (state as any).lightTransformMode as LightTransformMode | undefined | null;
            modeButtons.forEach((btn) => {
                const btnMode = btn.getAttribute('data-light-mode') as LightTransformMode;
                const isActive = hasSelection && mode != null && btnMode === mode;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
                btn.toggleAttribute('disabled', !hasSelection);
            });
            focusBtn?.toggleAttribute('disabled', !hasSelection);
            deleteBtn?.toggleAttribute('disabled', !hasSelection);
        };

        const setLightTransformModeInternal = (mode: LightTransformMode | null) => {
            (state as any).lightTransformMode = mode;
            events.fire('lightTransformMode:changed', mode);
            syncLightModeButtons();
        };

        modeButtons.forEach((btn) => {
            const mode = btn.getAttribute('data-light-mode') as LightTransformMode;
            btn.addEventListener('click', () => {
                const current = (state as any).lightTransformMode as LightTransformMode | null | undefined;
                const nextMode: LightTransformMode | null = current === mode ? null : mode;

                if (editUiTransport === 'message-bridge') {
                    // 暂不透出协议，internal 模式下直接本地状态切换
                    setLightTransformModeInternal(nextMode);
                } else {
                    setLightTransformModeInternal(nextMode);
                }
            });
        });

        focusBtn?.addEventListener('click', () => {
            if (!(state as any).selectedLightId) return;
            events.fire('lighting:focusLightRow', { id: (state as any).selectedLightId });
        });

        deleteBtn?.addEventListener('click', () => {
            if (!(state as any).selectedLightId) return;
            events.fire('lighting:deleteLight', { id: (state as any).selectedLightId });
        });

        syncLightModeButtons();
    };

    const onEditLeftModuleChanged = (newModule?: string | null) => {
        if (newModule !== 'annotation') {
            (state as any).annotationTransformMode = null;
        }
        renderAndBind();
    };

    const onAnnotationDeselected = () => {
        (state as any).annotationTransformMode = null;
        syncAnnotationMoveButton();
    };

    const onAssetTransformModeChanged = () => {
        if (currentModule() !== 'asset') return;
        const modeButtons = container.querySelectorAll<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode]');
        const hasSelection = state.selectedSceneEntityId != null;
        const c = currentTransformMode();
        modeButtons.forEach((btn) => {
            const isActive = hasSelection && c !== undefined && btn.getAttribute('data-mode') === c;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
    };

    const onSceneAssetSelected = () => {
        if (currentModule() !== 'asset') return;
        const modeButtons = container.querySelectorAll<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode]');
        const hasSelection = state.selectedSceneEntityId != null;
        const c = currentTransformMode();
        modeButtons.forEach((btn) => {
            const isActive = hasSelection && c !== undefined && btn.getAttribute('data-mode') === c;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
    };

    events.on('editLeftModule:changed', onEditLeftModuleChanged);
    events.on('assetTransformMode:changed', onAssetTransformModeChanged);
    events.on('sceneAsset:selected', onSceneAssetSelected);
    events.on('annotation:deselected', onAnnotationDeselected);

    renderAndBind();

    return () => {
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        events.off('assetTransformMode:changed', onAssetTransformModeChanged);
        events.off('sceneAsset:selected', onSceneAssetSelected);
        events.off('annotation:deselected', onAnnotationDeselected);
        if (root && root.parentNode) {
            root.parentNode.removeChild(root);
        } else if (container) {
            container.innerHTML = '';
            container.classList.remove('edit-bottom-toolbar');
        }
    };
}
