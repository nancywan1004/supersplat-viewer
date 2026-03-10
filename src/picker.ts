import { type AppBase, type Entity, Picker as PcPicker, Vec3 } from 'playcanvas';

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

export { Picker };
