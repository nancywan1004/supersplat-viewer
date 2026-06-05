import type { Global } from '../types';
import type { EditLeftModule } from '../types';
import { getEditUiTransport, sendEditProtocolMessage } from './edit-ui-transport';

const MODULES: { id: EditLeftModule; label: string }[] = [
    { id: 'gs', label: 'GS模型编辑' },
    { id: 'asset', label: '资产放置' },
    { id: 'annotation', label: '场景标注' },
    { id: 'environment', label: '环境设置' },
    { id: 'skybox', label: '天空盒' },
    { id: 'camera', label: '相机设置' },
    { id: 'effects', label: '场景特效' },
    { id: 'assetEffects', label: '物体特效' }
];

// 左侧工具栏整体隶属于「编辑工具箱」之下，可折叠（collapse 时只显示标题栏，展开时显示工具列表）
const EDIT_LEFT_TOOLBAR_HTML = `
<div class="edit-left-toolbar-nav">
    <div class="edit-left-toolbar-nav-header expanded" id="editLeftToolbarNavHeader" role="button" tabindex="0" aria-expanded="true" aria-controls="editLeftToolbarNavBody">
        <span>编辑工具箱</span>
    </div>
    <div class="edit-left-toolbar-nav-body" id="editLeftToolbarNavBody">
        <ul class="edit-left-toolbar-list" role="tablist" aria-label="编辑工具箱">
${MODULES.map(
    (m) =>
        `<li class="edit-left-toolbar-item" data-module="${m.id}" role="tab" tabindex="0">${m.label}</li>`
).join('\n')}
        </ul>
    </div>
</div>
`.trim();

/**
 * 初始化左侧编辑工具箱 UI（模块列表：GS模型编辑、资产放置、场景标注、环境设置、天空盒、相机设置、场景特效、物体特效）。
 * 挂载到 #editLeftSidebarMount；若无该容器则在 #ui 下创建根节点并插入。
 * 点击某项时设置 state.editLeftModule 并触发 editLeftModule:changed。
 * @returns 清理函数
 */
export function initEditLeftToolbarUI(global: Global): () => void {
    const { state, events } = global;
    const editUiTransport = getEditUiTransport(global);

    let container = document.getElementById('editLeftSidebarMount');
    let root: HTMLElement | null = null;
    if (!container) {
        const ui = document.getElementById('ui');
        if (!ui) return () => {};
        root = document.createElement('div');
        root.id = 'editLeftSidebarMount';
        root.className = 'edit-left-sidebar';
        ui.insertBefore(root, ui.querySelector('#rightToolBar') || null);
        container = root;
    } else {
        container.classList.add('edit-left-sidebar');
    }

    container.innerHTML = EDIT_LEFT_TOOLBAR_HTML;
    const list = container.querySelector('.edit-left-toolbar-list') as HTMLElement | null;
    const navBody = container.querySelector('#editLeftToolbarNavBody') as HTMLElement | null;
    const navHeader = container.querySelector('#editLeftToolbarNavHeader') as HTMLElement | null;
    if (!list) return () => {};

    // 编辑工具箱折叠（箭头由 CSS ::before 根据 .expanded 绘制，与 submenuHeader / postEffectSectionLabel 一致）
    let navExpanded = true;
    const toggleNav = () => {
        navExpanded = !navExpanded;
        navBody?.classList.toggle('collapsed', !navExpanded);
        navHeader?.classList.toggle('expanded', navExpanded);
        navHeader?.setAttribute('aria-expanded', String(navExpanded));
    };
    const onNavKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleNav();
        }
    };
    navHeader?.addEventListener('click', toggleNav);
    navHeader?.addEventListener('keydown', onNavKey);

    const items = Array.from(container.querySelectorAll<HTMLElement>('.edit-left-toolbar-item'));

    const current = (): EditLeftModule | null => (state.editLeftModule ?? null);

    const syncActiveClasses = (id: EditLeftModule | null) => {
        items.forEach((el) => {
            const active = id != null && el.getAttribute('data-module') === id;
            el.classList.toggle('active', active);
            el.setAttribute('aria-selected', String(active));
        });
    };

    const setActive = (id: EditLeftModule | null) => {
        if (editUiTransport === 'message-bridge') {
            if (id == null) {
                // 不带 value：表示清空模块选择
                sendEditProtocolMessage({ type: 'EDIT_MODULE_SET' });
            } else {
                sendEditProtocolMessage({ type: 'EDIT_MODULE_SET', value: id });
            }
        } else {
            state.editLeftModule = id;
            events.fire('editLeftModule:changed', id);
        }
        syncActiveClasses(id);
    };

    items.forEach((el) => {
        const id = el.getAttribute('data-module') as EditLeftModule;
        const isActive = id === current();
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-selected', String(isActive));

        const handleClick = () => {
            const c = current();
            setActive(c === id ? null : id);
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const c = current();
                setActive(c === id ? null : id);
            }
        };

        el.addEventListener('click', handleClick);
        el.addEventListener('keydown', handleKey);
    });

    const onEditLeftModuleChanged = () => {
        syncActiveClasses(current());
    };
    events.on('editLeftModule:changed', onEditLeftModuleChanged);

    syncActiveClasses(current());

    return () => {
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        navHeader?.removeEventListener('click', toggleNav);
        navHeader?.removeEventListener('keydown', onNavKey);
        if (root && root.parentNode) {
            root.parentNode.removeChild(root);
        } else if (container) {
            container.innerHTML = '';
            container.classList.remove('edit-left-sidebar');
        }
    };
}
