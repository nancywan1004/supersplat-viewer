import type { AppBase } from 'playcanvas';

/**
 * PlayCanvas 在 tick 开头把 `_gsplatCount` 拷进 `stats.frame.gsplats`，
 * 而 unified director 在 render 里才更新 `_gsplatCount`。
 * 本 viewer `autoRender=false` 时，控制台/`app.stats.frame.gsplats` 常读到 0。
 * 在 frameend（render 之后）把 live 计数写回，供观测与 HUD 使用。
 */
export function installFrameGsplatsSync(app: AppBase): () => void {
    const onFrameEnd = () => {
        const live = (app.renderer as { _gsplatCount?: number } | undefined)?._gsplatCount;
        if (!Number.isFinite(live)) {
            return;
        }
        const frame = (app.stats as { frame?: { gsplats?: number } })?.frame;
        if (frame) {
            frame.gsplats = live as number;
        }
    };
    app.on('frameend', onFrameEnd);
    return () => {
        app.off('frameend', onFrameEnd);
    };
}
