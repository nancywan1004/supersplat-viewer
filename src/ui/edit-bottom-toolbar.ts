import type { Global } from '../types';
import type { AssetTransformMode, EditLeftModule } from '../types';

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
        <button type="button" class="edit-bottom-toolbar-btn active" data-mode="move" aria-pressed="true">移动</button>
    </div>
    <div class="edit-bottom-toolbar-divider"></div>
    <div class="edit-bottom-toolbar-group" role="group" aria-label="标注操作">
        <button type="button" class="edit-bottom-toolbar-btn" id="annotationEditBtn" data-action="edit">编辑</button>
        <button type="button" class="edit-bottom-toolbar-btn edit-bottom-toolbar-btn-danger" id="annotationDeleteBtn" data-action="delete">删除</button>
    </div>
</div>
`.trim();

function getToolbarHTML(module: EditLeftModule): string {
    return module === 'annotation' ? ANNOTATION_HTML : ASSET_HTML;
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

    const currentModule = (): EditLeftModule => state.editLeftModule ?? 'asset';
    const currentTransformMode = (): AssetTransformMode => state.assetTransformMode ?? 'move';

    const renderAndBind = () => {
        const module = currentModule();
        container.innerHTML = getToolbarHTML(module);

        if (module === 'asset') {
            bindAssetContent();
        } else if (module === 'annotation') {
            bindAnnotationContent();
        }
    };

    const bindAssetContent = () => {
        const modeButtons = Array.from(
            container.querySelectorAll<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode]')
        );
        const copyBtn = container.querySelector<HTMLButtonElement>('#assetEditCopy');
        const deleteBtn = container.querySelector<HTMLButtonElement>('#assetEditDelete');

        const setTransformActive = (mode: AssetTransformMode) => {
            state.assetTransformMode = mode;
            events.fire('assetTransformMode:changed', mode);
            modeButtons.forEach((btn) => {
                const isActive = btn.getAttribute('data-mode') === mode;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
            });
        };

        modeButtons.forEach((btn) => {
            const mode = btn.getAttribute('data-mode') as AssetTransformMode;
            const isActive = mode === currentTransformMode();
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
            btn.addEventListener('click', () => setTransformActive(mode));
        });

        copyBtn?.addEventListener('click', () => events.fire('assetEdit:copy'));
        deleteBtn?.addEventListener('click', () => events.fire('assetEdit:delete'));

        setTransformActive(currentTransformMode());
    };

    const bindAnnotationContent = () => {
        const moveBtn = container.querySelector<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode="move"]');
        const editBtn = container.querySelector<HTMLButtonElement>('#annotationEditBtn');
        const deleteBtn = container.querySelector<HTMLButtonElement>('#annotationDeleteBtn');

        moveBtn?.addEventListener('click', () => {
            state.assetTransformMode = 'move';
            events.fire('assetTransformMode:changed', 'move');
        });

        editBtn?.addEventListener('click', () => {
            events.fire('annotationEdit:show');
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
    };

    const onEditLeftModuleChanged = () => {
        renderAndBind();
    };

    const onAssetTransformModeChanged = () => {
        if (currentModule() !== 'asset') return;
        const c = currentTransformMode();
        container.querySelectorAll<HTMLButtonElement>('.edit-bottom-toolbar-btn[data-mode]').forEach((btn) => {
            const isActive = btn.getAttribute('data-mode') === c;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
    };

    events.on('editLeftModule:changed', onEditLeftModuleChanged);
    events.on('assetTransformMode:changed', onAssetTransformModeChanged);

    renderAndBind();

    return () => {
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        events.off('assetTransformMode:changed', onAssetTransformModeChanged);
        if (root && root.parentNode) {
            root.parentNode.removeChild(root);
        } else if (container) {
            container.innerHTML = '';
            container.classList.remove('edit-bottom-toolbar');
        }
    };
}
