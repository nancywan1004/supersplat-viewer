/**
 * 场景 settings 重置确认（本地弹层，非浏览器 confirm）。
 */

export interface ResetConfirmCallbacks {
    onConfirm: () => void | Promise<void>;
    onCancel?: () => void;
}

const TITLE_ID = 'settings-reset-confirm-title';

export function confirmSceneReset(callbacks: ResetConfirmCallbacks): () => void {
    const overlay = document.createElement('div');
    overlay.className = 'exit-edit-confirm-overlay settings-reset-confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', TITLE_ID);

    const dialog = document.createElement('div');
    dialog.className = 'exit-edit-confirm-dialog settings-reset-confirm-dialog';
    dialog.innerHTML = `
        <h3 id="${TITLE_ID}">重置场景设置？</h3>
        <p class="settings-reset-confirm-desc">
            将清除当前未保存的编辑内容（资产、标注、光照与后处理等）；天空盒不变。
            相机路径优先使用云端初始 transform.json，若无则保留当前动画路径与默认视角。
        </p>
        <div class="exit-edit-confirm-buttons">
            <button type="button" class="exit-edit-confirm-cancel">取消</button>
            <button type="button" class="settings-reset-confirm-ok">确认重置</button>
        </div>
    `;

    const close = () => {
        overlay.remove();
    };

    const cancelBtn = dialog.querySelector<HTMLButtonElement>('.exit-edit-confirm-cancel')!;
    const okBtn = dialog.querySelector<HTMLButtonElement>('.settings-reset-confirm-ok')!;

    cancelBtn.addEventListener('click', () => {
        callbacks.onCancel?.();
        close();
    });
    okBtn.addEventListener('click', () => {
        const result = callbacks.onConfirm();
        if (result && typeof (result as Promise<void>).then === 'function') {
            (result as Promise<void>).then(close);
        } else {
            close();
        }
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
