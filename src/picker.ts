import { type AppBase, type Entity, Picker as PcPicker, Vec3 } from 'playcanvas';
import type { Global } from './types';

/**
 * 标注放置 / 深度拾取专用 Picker。
 * 使用 PlayCanvas 内置 Picker(depth=true)，走 DEPTH_PICK pass：colorBuffer 出 ID，depthBuffer 出深度，
 * 通过 getWorldPointAsync 读深度并反投影到世界坐标。不覆盖全局 pickPS，与资产选中用的 pc.Picker(depth=false) 无冲突。
 */
class Picker {
    private app: AppBase;
    private camera: Entity;
    private pcPicker: InstanceType<typeof PcPicker> | null = null;

    constructor(app: AppBase, camera: Entity) {
        this.app = app;
        this.camera = camera;
    }

    /**
     * 从归一化坐标 [0,1] 拾取世界坐标。
     * @param x 归一化 X（0=左，1=右）
     * @param y 归一化 Y（0=上，1=下）
     */
    async pick(x: number, y: number): Promise<Vec3 | null> {
        const canvas = this.app.graphicsDevice?.canvas as HTMLCanvasElement | undefined;
        if (!canvas) return null;

        const width = canvas.clientWidth || this.app.graphicsDevice.width;
        const height = canvas.clientHeight || this.app.graphicsDevice.height;
        if (width <= 0 || height <= 0) return null;

        if (!this.pcPicker) {
            this.pcPicker = new PcPicker(this.app, width, height, true);
        }
        this.pcPicker.resize(width, height);

        const worldLayer = this.app.scene.layers.getLayerByName('World');
        this.pcPicker.prepare(this.camera.camera, this.app.scene, worldLayer ? [worldLayer] : undefined);

        const px = Math.max(0, Math.min(width - 1, Math.floor(x * width)));
        const py = Math.max(0, Math.min(height - 1, Math.floor(y * height)));

        const worldPoint = await this.pcPicker.getWorldPointAsync(px, py);
        return worldPoint;
    }

    release(): void {
        if (this.pcPicker) {
            this.pcPicker.destroy();
            this.pcPicker = null;
        }
    }
}
/**
 * 根据浏览器事件的 clientX/clientY，将屏幕坐标转换为世界坐标。
 * - 统一使用 canvas.getBoundingClientRect() 做归一化，保证与 depth buffer / Picker 一致；
 * - 所有需要「点击 → 世界坐标」的模块应优先通过此方法获取坐标，再根据各自业务解释（选光源、放注释、画 bloom 等）。
 */
async function pickWorldFromClientXY(global: Global, clientX: number, clientY: number): Promise<Vec3 | null> {
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const rw = rect.width;
    const rh = rect.height;
    if (rw <= 0 || rh <= 0) return null;

    const nx = (clientX - rect.left) / rw;
    const ny = (clientY - rect.top) / rh;

    const pickerHolder = global as unknown as { __picker?: Picker };
    if (!pickerHolder.__picker) {
        pickerHolder.__picker = new Picker(global.app, global.camera);
    }
    return pickerHolder.__picker.pick(nx, ny);
}

export { Picker, pickWorldFromClientXY };
