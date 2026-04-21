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
import type { InputArbiter } from '../input-arbiter';

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

    /** 输入仲裁器中 pointer click claim handler 的解绑函数 */
    private detachPointerClickClaimHandler: (() => void) | null = null;

    /**
     * 构造函数
     * 
     * @param global - Global 引用
     */
    constructor(global: Global) {
        this.global = global;
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

        this.state = PlacementState.Following;
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

        this.detachPointerClickClaimHandler?.();
        this.detachPointerClickClaimHandler = null;

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

        const inputArbiter = (this.global as Global & { __inputArbiter?: InputArbiter }).__inputArbiter;
        if (inputArbiter) {
            this.detachPointerClickClaimHandler = inputArbiter.registerPointerClickHandler({
                id: 'annotation.placement',
                priority: 150,
                handle: ({ worldPosition }) => this.onPointerClickClaim(worldPosition)
            });
        }
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
     * 处理场景点击 claim 事件
     * 
     * 在点击位置放置标注。未命中世界时保持放置态并消费本次点击。
     * 
     * @param worldPosition - 仲裁器提供的世界坐标，未命中时为 null
     * @private
     */
    private onPointerClickClaim(worldPosition: Vec3 | null): boolean {
        // 只在跟随状态下处理点击
        if (this.state !== PlacementState.Following) {
            return false;
        }

        if (!worldPosition) {
            return true;
        }

        // 触发标注放置事件（由 AnnotationManager 监听并创建或更新占位标注）
        if (this.global.events) {
            this.global.events.fire('annotation:place', worldPosition);
        }
        return true;
    }
}
