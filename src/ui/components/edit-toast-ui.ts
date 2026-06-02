/**
 * 编辑模式内轻量提示（非浏览器 alert/confirm）。
 */

export type EditToastKind = 'info' | 'success' | 'error';

const TOAST_ROOT_ID = 'edit-toast-root';

const ensureToastRoot = (): HTMLElement => {
    let root = document.getElementById(TOAST_ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = TOAST_ROOT_ID;
        root.className = 'edit-toast-root';
        root.setAttribute('aria-live', 'polite');
        document.body.appendChild(root);
    }
    return root;
};

/**
 * 在顶栏下方显示一条自动消失的提示。
 */
export function showEditToast(message: string, kind: EditToastKind = 'info', durationMs = 4200): void {
    const text = message.trim();
    if (!text) return;

    const root = ensureToastRoot();
    const el = document.createElement('div');
    el.className = `edit-toast edit-toast--${kind}`;
    el.textContent = text;
    root.appendChild(el);

    requestAnimationFrame(() => {
        el.classList.add('edit-toast--visible');
    });

    const dismiss = () => {
        el.classList.remove('edit-toast--visible');
        window.setTimeout(() => el.remove(), 280);
    };

    const timer = window.setTimeout(dismiss, durationMs);
    el.addEventListener('click', () => {
        window.clearTimeout(timer);
        dismiss();
    });
}
