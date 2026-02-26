import type { Global } from '../types';
import type { AssetTransformMode } from '../types';

const TRANSFORM_MODES: { id: AssetTransformMode; label: string }[] = [
    { id: 'move', label: '移动' },
    { id: 'rotate', label: '旋转' },
    { id: 'scale', label: '缩放' }
];

const EDIT_BOTTOM_TOOLBAR_HTML = `
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

/**
 * 初始化底部资产编辑栏 UI（移动、旋转、缩放、复制、删除）。
 * 挂载到 #editBottomToolbarMount；若无该容器则在 #ui 下创建根节点并插入。
 * 变换模式点击设置 state.assetTransformMode 并触发 assetTransformMode:changed；
 * 复制/删除触发 assetEdit:copy、assetEdit:delete。
 * 显隐由 ui 根据 state.editMode 控制挂载点。
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

    container.innerHTML = EDIT_BOTTOM_TOOLBAR_HTML;

    const current = (): AssetTransformMode => state.assetTransformMode ?? 'move';

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
        const isActive = mode === current();
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));

        const handleClick = () => setTransformActive(mode);
        btn.addEventListener('click', handleClick);
    });

    if (copyBtn) {
        copyBtn.addEventListener('click', () => events.fire('assetEdit:copy'));
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => events.fire('assetEdit:delete'));
    }

    const onAssetTransformModeChanged = () => {
        const c = current();
        modeButtons.forEach((btn) => {
            const isActive = btn.getAttribute('data-mode') === c;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
    };
    events.on('assetTransformMode:changed', onAssetTransformModeChanged);

    setTransformActive(current());

    return () => {
        events.off('assetTransformMode:changed', onAssetTransformModeChanged);
        if (root && root.parentNode) {
            root.parentNode.removeChild(root);
        } else if (container) {
            container.innerHTML = '';
            container.classList.remove('edit-bottom-toolbar');
        }
    };
}
