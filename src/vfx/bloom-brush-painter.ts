import {
    Texture,
    PIXELFORMAT_R8,
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

const MASK_SIZE = 512;

export interface BloomBrushPainterOptions {
    device: GraphicsDevice;
    /** 应用 canvas，用于 pointer 事件与坐标映射 */
    appCanvas: HTMLCanvasElement;
    maskWidth?: number;
    maskHeight?: number;
}

/**
 * 2D 画笔：在离屏 canvas 上涂抹，上传为 mask 纹理供 BloomBrushFilter 采样。
 * 坐标：pointer 相对 appCanvas 的 (px,py) 归一化后映射到 mask，Y 轴翻转。
 */
export class BloomBrushPainter {
    private device: GraphicsDevice;
    private appCanvas: HTMLCanvasElement;
    private maskWidth: number;
    private maskHeight: number;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private texture: Texture;
    private brushSize: number = 30;
    private enabled: boolean = false;
    private isDrawing: boolean = false;
    private boundPointerDown: (e: PointerEvent) => void;
    private boundPointerMove: (e: PointerEvent) => void;
    private boundPointerUp: (e: PointerEvent) => void;
    private boundPointerLeave: (e: PointerEvent) => void;
    private uploadThrottle: number = 0;

    constructor(options: BloomBrushPainterOptions) {
        this.device = options.device;
        this.appCanvas = options.appCanvas;
        this.maskWidth = options.maskWidth ?? MASK_SIZE;
        this.maskHeight = options.maskHeight ?? MASK_SIZE;

        this.canvas = document.createElement('canvas');
        this.canvas.width = this.maskWidth;
        this.canvas.height = this.maskHeight;
        const ctx = this.canvas.getContext('2d');
        if (!ctx) throw new Error('BloomBrushPainter: 2D context not available');
        this.ctx = ctx;
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.maskWidth, this.maskHeight);

        this.texture = new Texture(this.device, {
            name: 'bloomBrushMask',
            width: this.maskWidth,
            height: this.maskHeight,
            format: PIXELFORMAT_R8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            mipmaps: false
        });
        this.texture.setSource(this.canvas);

        this.boundPointerDown = this.onPointerDown.bind(this);
        this.boundPointerMove = this.onPointerMove.bind(this);
        this.boundPointerUp = this.onPointerUp.bind(this);
        this.boundPointerLeave = this.onPointerLeave.bind(this);

    }

    getTexture(): Texture {
        return this.texture;
    }

    setBrushSize(pixels: number) {
        this.brushSize = Math.max(1, Math.min(200, pixels));
    }

    getBrushSize(): number {
        return this.brushSize;
    }

    clear() {
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.maskWidth, this.maskHeight);
        this.texture.setSource(this.canvas);
        this.texture.upload();
    }

    /** 判断指针是否在 appCanvas 的边界内（用于 document 上的全局监听） */
    private isInsideCanvas(clientX: number, clientY: number): boolean {
        const rect = this.appCanvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    /** 事件是否发生在可交互 UI 上（input/button/链接等），若是则不应被笔刷拦截 */
    private isInteractiveTarget(target: EventTarget | null): boolean {
        if (!target || !(target instanceof Node)) return false;
        const el = target as HTMLElement;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'a') return true;
        if (el.closest?.('input, button, select, textarea, a[href], [role="slider"], [contenteditable="true"]')) return true;
        if (el.closest?.('.postEffectSliderWrap, .postEffectOption')) return true;
        return false;
    }

    /** 开启/关闭画笔：在 document 上注册 pointer 监听（capture），仅当指针在画布内时处理。开启时先清空 mask，保证初始无 bloom。 */
    setEnabled(on: boolean) {
        if (this.enabled === on) return;
        this.enabled = on;
        const opts: AddEventListenerOptions = { capture: true };
        if (on) {
            this.clear();
            document.addEventListener('pointerdown', this.boundPointerDown, opts);
            document.addEventListener('pointermove', this.boundPointerMove, opts);
            document.addEventListener('pointerup', this.boundPointerUp, opts);
            document.addEventListener('pointerleave', this.boundPointerLeave, opts);
        } else {
            document.removeEventListener('pointerdown', this.boundPointerDown, opts);
            document.removeEventListener('pointermove', this.boundPointerMove, opts);
            document.removeEventListener('pointerup', this.boundPointerUp, opts);
            document.removeEventListener('pointerleave', this.boundPointerLeave, opts);
            this.isDrawing = false;
        }
    }

    private clientToMask(clientX: number, clientY: number): { x: number; y: number; radius: number } {
        const rect = this.appCanvas.getBoundingClientRect();
        const px = (clientX - rect.left) / rect.width;
        const py = (clientY - rect.top) / rect.height;
        const mx = px * this.maskWidth;
        const my = (1 - py) * this.maskHeight;
        const scale = this.maskWidth / rect.width;
        const radius = this.brushSize * scale;
        return { x: mx, y: my, radius };
    }

    private strokeAt(clientX: number, clientY: number) {
        const { x, y, radius } = this.clientToMask(clientX, clientY);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.beginPath();
        this.ctx.arc(x, y, radius, 0, Math.PI * 2);
        this.ctx.fill();
        this.uploadThrottle++;
        if (this.uploadThrottle >= 3) {
            this.uploadThrottle = 0;
            this.texture.setSource(this.canvas);
            this.texture.upload();
        }
    }

    private onPointerDown(e: PointerEvent) {
        if (this.isInteractiveTarget(e.target)) return;
        const inside = this.isInsideCanvas(e.clientX, e.clientY);
        if (!this.enabled || e.button !== 0) return;
        if (!inside) return;
        this.isDrawing = true;
        e.preventDefault();
        e.stopPropagation();
        this.strokeAt(e.clientX, e.clientY);
    }

    private onPointerMove(e: PointerEvent) {
        if (!this.isDrawing) return;
        if (this.isInteractiveTarget(e.target)) {
            this.isDrawing = false;
            this.texture.setSource(this.canvas);
            this.texture.upload();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.strokeAt(e.clientX, e.clientY);
    }

    private onPointerUp(e: PointerEvent) {
        if (e.button !== 0) return;
        if (this.isDrawing) {
            this.isDrawing = false;
            e.preventDefault();
            e.stopPropagation();
            this.texture.setSource(this.canvas);
            this.texture.upload();
        }
    }

    private onPointerLeave(e: PointerEvent) {
        if (this.isDrawing) {
            this.isDrawing = false;
            e.preventDefault();
            e.stopPropagation();
            this.texture.setSource(this.canvas);
            this.texture.upload();
        }
    }

    /** 每帧结束时若正在绘制可调用一次上传（可选） */
    flushUpload() {
        if (this.uploadThrottle > 0) {
            this.uploadThrottle = 0;
            this.texture.setSource(this.canvas);
            this.texture.upload();
        }
    }

    destroy() {
        this.setEnabled(false);
        this.texture.destroy();
    }
}
