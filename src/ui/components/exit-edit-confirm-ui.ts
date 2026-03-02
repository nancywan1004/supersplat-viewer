/**
 * 退出编辑模式时的保存确认弹窗组件。
 * 居中显示，提供「取消」「不保存并退出」「保存并退出」三个操作。
 */

export interface ExitEditConfirmCallbacks {
    /** 用户点击「保存并退出」时调用 */
    onSave: () => void;
    /** 用户点击「不保存并退出」时调用，可返回 Promise，弹窗会在 resolve 后关闭 */
    onDiscard: () => void | Promise<void>;
    /** 用户点击「取消」或点击遮罩时调用（可选） */
    onCancel?: () => void;
}

const TITLE_ID = 'exit-edit-confirm-title';

/**
 * 在屏幕中心显示退出编辑确认弹窗，根据用户选择调用对应回调后关闭弹窗。
 * @param callbacks 三个按钮的回调；onSave/onDiscard 会在调用后自动关闭弹窗，onCancel 仅关闭弹窗
 * @returns 关闭弹窗的函数，可在外部主动调用以关闭
 */
export function showExitEditConfirmModal(callbacks: ExitEditConfirmCallbacks): () => void {
    const overlay = document.createElement('div');
    overlay.className = 'exit-edit-confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', TITLE_ID);

    const dialog = document.createElement('div');
    dialog.className = 'exit-edit-confirm-dialog';
    dialog.innerHTML = `
        <h3 id="${TITLE_ID}">是否保存当前设置后再退出？</h3>
        <div class="exit-edit-confirm-buttons">
            <button type="button" class="exit-edit-confirm-cancel">取消</button>
            <button type="button" class="exit-edit-confirm-discard">不保存并退出</button>
            <button type="button" class="exit-edit-confirm-save">保存并退出</button>
        </div>
    `;

    const close = () => {
        overlay.remove();
    };

    const cancelBtn = dialog.querySelector<HTMLButtonElement>('.exit-edit-confirm-cancel')!;
    const discardBtn = dialog.querySelector<HTMLButtonElement>('.exit-edit-confirm-discard')!;
    const saveBtn = dialog.querySelector<HTMLButtonElement>('.exit-edit-confirm-save')!;

    cancelBtn.addEventListener('click', () => {
        callbacks.onCancel?.();
        close();
    });
    discardBtn.addEventListener('click', () => {
        const result = callbacks.onDiscard();
        if (result && typeof (result as Promise<void>).then === 'function') {
            (result as Promise<void>).then(close);
        } else {
            close();
        }
    });
    saveBtn.addEventListener('click', () => {
        callbacks.onSave();
        close();
    });

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            callbacks.onCancel?.();
            close();
        }
    });

    document.body.appendChild(overlay);
    return close;
}
