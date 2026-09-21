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

export type EditToastHandle = {
    /**
     * 更新文案。
     * @param message - 新文案（空串忽略）
     * @param ratio - 0–1，传了就显示进度条
     */
    update: (message: string, ratio?: number) => void;
    close: () => void;
};

export type EditToastPersistentOptions = {
    /** 传了就显示「取消」按钮；点击后按钮变「取消中…」并回调一次 */
    onCancel?: () => void;
};

/**
 * 常驻提示：不自动消失，用于进度类反馈（保存 / 上传）。
 * 有 `onCancel` 时点正文不再关闭（避免误关进度），改用取消按钮；否则点正文关闭。
 * @param message - 初始文案
 * @param kind - 样式
 * @param options - 取消按钮回调
 * @returns 更新 / 关闭句柄
 */
export function showEditToastPersistent(
    message: string,
    kind: EditToastKind = 'info',
    options?: EditToastPersistentOptions
): EditToastHandle {
    const root = ensureToastRoot();
    const el = document.createElement('div');
    el.className = `edit-toast edit-toast--${kind} edit-toast--persistent`;

    const row = document.createElement('div');
    row.className = 'edit-toast__row';
    const text = document.createElement('div');
    text.className = 'edit-toast__text';
    text.textContent = message;
    row.appendChild(text);

    const bar = document.createElement('div');
    bar.className = 'edit-toast__bar';
    const fill = document.createElement('div');
    fill.className = 'edit-toast__bar-fill';
    bar.appendChild(fill);

    el.appendChild(row);
    el.appendChild(bar);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        el.classList.remove('edit-toast--visible');
        window.setTimeout(() => el.remove(), 280);
    };

    const onCancel = options?.onCancel;
    if (onCancel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'edit-toast__cancel';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelBtn.disabled = true;
            cancelBtn.textContent = '取消中…';
            onCancel();
        });
        row.appendChild(cancelBtn);
    } else {
        el.addEventListener('click', close);
    }

    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('edit-toast--visible'));

    return {
        update: (next: string, ratio?: number) => {
            if (closed) return;
            const trimmed = next.trim();
            if (trimmed) text.textContent = trimmed;
            if (typeof ratio === 'number' && Number.isFinite(ratio)) {
                el.classList.add('edit-toast--has-bar');
                fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
            }
        },
        close
    };
}
