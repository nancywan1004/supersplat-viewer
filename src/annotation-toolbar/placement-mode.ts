/**
 * PlacementMode - 标注放置模式控制器
 *
 * 管理标注放置模式的状态机：
 * - 状态管理：Inactive（未激活）、Following（等待点击）、Placed（已放置）
 * - 点击放置：仅在鼠标单击处创建占位标注，无光标跟随热点
 * - 交互控制：禁用/启用相机和资产放置交互
 */

import { Vec3 } from 'playcanvas';
import { PlacementState } from './types';
import type { AnnotationEntity } from './annotation-entity';
import type { Global } from '../types';
import { Picker } from '../picker';
import { getPositionInFrontOfCamera } from '../asset-placement-handler';

/**
 * PlacementMode 类
 *
 * 控制标注放置模式的状态机
 */
export class PlacementMode {
    /** 当前放置状态 */
    private state: PlacementState = PlacementState.Inactive;

    /** 占位标注实体 */
    private placeholderAnnotation: AnnotationEntity | null = null;

    /** Global 引用 */
    private global: Global;

    /** 场景拾取器 */
    private picker: Picker;

    /** 场景点击事件处理器 */
    private clickHandler: ((event: MouseEvent) => void) | null = null;

    /**
     * 构造函数
     * 
     * @param global - Global 引用
     */
    constructor(global: Global) {
        this.global = global;
        this.picker = new Picker(global.app, global.camera);
    }

    /**
     * 激活放置模式
     *
     * 开始标注放置流程，等待用户在场景中点击放置
     */
    activate(): void {
        if (this.state !== PlacementState.Inactive) {
            return;
        }

        console.log('[Annotation][PlacementMode] activate');
        this.state = PlacementState.Following;
        this.setPlacementCursor(true);
        this.startFollowing();
    }

    /**
     * 取消激活放置模式
     * 
     * 结束标注放置流程，清理资源
     */
    deactivate(): void {
        if (this.state === PlacementState.Inactive) {
            return;
        }

        if (this.clickHandler) {
            const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
            canvas.removeEventListener('click', this.clickHandler);
            this.clickHandler = null;
        }

        this.setPlacementCursor(false);
        this.enableInteractions();
        this.state = PlacementState.Inactive;
        this.placeholderAnnotation = null;

        if (this.global.events) {
            this.global.events.fire('annotationPlacement:ended');
        }
    }

    /**
     * 检查是否处于激活状态
     * 
     * @returns true 表示处于激活状态（Following 或 Placed）
     */
    isActive(): boolean {
        return this.state !== PlacementState.Inactive;
    }

    /**
     * 开始等待点击
     *
     * 禁用交互并监听场景点击，点击时在点击位置创建占位标注
     */
    startFollowing(): void {
        this.disableInteractions();

        if (this.global.events) {
            this.global.events.fire('annotationPlacement:started');
        }

        const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        this.clickHandler = (event: MouseEvent) => {
            console.log('[Annotation][PlacementMode] canvas click', {
                clientX: event.clientX,
                clientY: event.clientY
            });
            this.onSceneClick(event);
        };
        canvas.addEventListener('click', this.clickHandler);
    }

    /**
     * 放置标注
     *
     * 占位标注由 AnnotationManager 在 annotation:place 事件中创建，
     * 此处仅切换状态并移除点击监听
     */
    placeAnnotation(_position: Vec3): void {
        this.state = PlacementState.Placed;

        if (this.clickHandler) {
            const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
            canvas.removeEventListener('click', this.clickHandler);
            this.clickHandler = null;
        }

        this.setPlacementCursor(false);
        this.enableInteractions();
    }

    /**
     * 取消放置
     * 
     * 取消当前的标注放置流程。
     * 注意：占位标注的销毁由 AnnotationManager.cancelAnnotation 负责，此处仅清除引用。
     */
    cancelPlacement(): void {
        this.placeholderAnnotation = null;
        this.deactivate();
    }

    /**
     * 获取占位标注
     * 
     * @returns 当前的占位标注实体，如果没有则返回 null
     */
    getPlaceholderAnnotation(): AnnotationEntity | null {
        return this.placeholderAnnotation;
    }

    /**
     * 设置占位标注
     * 
     * @param annotation - 占位标注实体
     */
    setPlaceholderAnnotation(annotation: AnnotationEntity): void {
        this.placeholderAnnotation = annotation;
    }

    /**
     * 设置放置模式下的光标样式（使用 crosshair 表示十字拾取光标）
     * @private
     */
    private setPlacementCursor(active: boolean): void {
        const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        if (canvas) {
            canvas.style.cursor = active ? 'crosshair' : '';
        }
    }

    /**
     * 禁用相机和资产交互
     * 
     * 在标注放置模式下禁用相机控制和资产放置交互
     * @private
     */
    private disableInteractions(): void {
        // 禁用相机控制
        if (this.global.events) {
            this.global.events.fire('cameraControls:disabled');
        }

        // 更新状态
        if (this.global.state) {
            this.global.state.cameraControlsEnabled = false;
        }
    }

    /**
     * 启用相机和资产交互
     * 
     * 重新启用相机控制和资产放置交互
     * @private
     */
    private enableInteractions(): void {
        // 启用相机控制
        if (this.global.events) {
            this.global.events.fire('cameraControls:enabled');
        }

        // 更新状态
        if (this.global.state) {
            this.global.state.cameraControlsEnabled = true;
        }
    }

    /**
     * 处理场景点击事件
     * 
     * 在点击位置放置标注
     * 
     * @param event - 鼠标点击事件
     * @private
     */
    private async onSceneClick(event: MouseEvent): Promise<void> {
        // 只在跟随状态下处理点击
        if (this.state !== PlacementState.Following) {
            console.log('[Annotation][PlacementMode] onSceneClick ignored, state=', this.state);
            return;
        }

        const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        
        // 转换为画布坐标
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;

        // 归一化坐标 (0-1)
        const normalizedX = canvasX / canvas.clientWidth;
        const normalizedY = canvasY / canvas.clientHeight;

        console.log('[Annotation][PlacementMode] onSceneClick normalized', {
            canvasX,
            canvasY,
            normalizedX,
            normalizedY
        });

        // 使用 Picker 获取 3D 位置
        try {
            const position = await this.picker.pick(normalizedX, normalizedY);
            if (position) {
                console.log('[Annotation][PlacementMode] picker hit position', position);
                // 触发标注放置事件（由 AnnotationManager 监听并创建标注）
                if (this.global.events) {
                    this.global.events.fire('annotation:place', position);
                }

                // 调用 placeAnnotation（状态切换到 Placed）
                this.placeAnnotation(position);
            } else {
                console.log('[Annotation][PlacementMode] picker returned null (no hit), fallback to camera-front');
                // 兜底策略：即便 Picker 没击中几何，也在相机前方放置一个标注，保证交互可用
                const fallbackPos = getPositionInFrontOfCamera(this.global);
                if (this.global.events) {
                    this.global.events.fire('annotation:place', fallbackPos);
                }
                this.placeAnnotation(fallbackPos);
            }
        } catch (error) {
            console.warn('[Annotation][PlacementMode] Failed to pick position for annotation placement:', error);
        }
    }
}
