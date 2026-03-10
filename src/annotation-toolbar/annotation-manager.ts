/**
 * AnnotationManager - 标注管理器
 * 
 * 核心管理类，负责标注的生命周期管理和状态协调：
 * - 管理所有标注实例
 * - 协调标注创建、编辑、删除流程
 * - 与 Settings 和 EditHistory 同步
 * - 管理标注选择状态
 * 
 * 编辑历史集成 (需求 6.1, 6.2, 6.3, 6.4, 6.5, 8.6):
 * 本系统使用快照方式集成编辑历史，而非命令模式。每次标注操作后，
 * 通过 pushEditHistory() 保存整个设置状态的快照。撤销/重做时，
 * EditHistory 系统会调用 restoreAnnotationsFromSettings() 从快照恢复标注。
 * 
 * 支持的可撤销操作：
 * - 创建标注: confirmAnnotation() 后记录，撤销时删除标注
 * - 删除标注: deleteAnnotation() 后记录，撤销时恢复标注
 * - 移动标注: onAnnotationMoveComplete() 后记录，撤销时恢复原位置
 * 
 * 标注选择状态也会被 EditHistory 自动跟踪和恢复。
 */

import { Vec3 } from 'playcanvas';
import { PlacementMode } from './placement-mode';
import { AnnotationEntity } from './annotation-entity';
import type { AnnotationData, AnnotationFormData } from './types';
import type { Global } from '../types';
import { pushEditHistory } from '../edit-history';

/**
 * AnnotationManager 类
 * 
 * 管理标注的完整生命周期
 */
export class AnnotationManager {
    /** 所有标注实例的映射表（id -> AnnotationEntity） */
    private annotations: Map<string, AnnotationEntity> = new Map();

    /** 放置模式控制器 */
    private placementMode: PlacementMode;

    /** Global 引用 */
    private global: Global;

    /** 当前选中的标注 ID */
    private selectedAnnotationId: string | null = null;

    /** 当前正在创建的占位标注 */
    private currentPlaceholder: AnnotationEntity | null = null;

    /** 由父级协议 ANNOTATION_PLACEMENT_START 传入的 id，在首次点击放置时使用 */
    private pendingPlacementId: string | null = null;

    /** 由 UI / 父级在放置前收集的表单数据（按 id 存储），用于占位标注创建后立即带上内容 */
    private pendingFormData: Map<string, AnnotationFormData> = new Map();

    /**
     * 构造函数
     * 
     * @param global - Global 引用
     */
    constructor(global: Global) {
        this.global = global;
        this.placementMode = new PlacementMode(global);

        // 监听标注放置事件
        if (this.global.events) {
            this.global.events.on('annotation:place', this.onAnnotationPlace, this);
            this.global.events.on('annotation:moveComplete', this.onAnnotationMoveComplete, this);
            this.global.events.on('annotation:updated', this.onAnnotationUpdated, this);
        }

        // 从设置中加载现有标注
        this.loadFromSettings();
    }

    /**
     * 供 UI 生成新的标注 id（与放置流程解耦，支持先填表单再放置）
     */
    generateNewAnnotationId(): string {
        return this.generateAnnotationId();
    }

    /**
     * 由父级协议 ANNOTATION_PLACEMENT_START 调用：使用指定 id 进入放置模式，场景点击时创建占位标注并上报 ANNOTATION_PLACEMENT_UPDATE。
     */
    startPlacementWithId(id: string): void {
        if (this.placementMode.isActive()) {
            return;
        }
        this.pendingPlacementId = id;
        this.placementMode.activate();
        if (this.global.state) {
            this.global.state.annotationPlacementActive = true;
        }

        // 更新状态
        if (this.global.state) {
            this.global.state.annotationPlacementActive = true;
        }
    }

    /**
     * 在放置开始前预存表单数据，待首次点击放置时应用到占位标注上
     */
    setPendingFormDataForPlacement(id: string, data: AnnotationFormData): void {
        this.pendingFormData.set(id, data);
    }

    /**
     * 确认标注
     * 
     * 确认并固化当前的占位标注
     * 
     * @param data - 标注表单数据
     */
    confirmAnnotation(data: AnnotationFormData): void {
        const placeholder = this.currentPlaceholder;
        
        if (!placeholder) {
            console.warn('No placeholder annotation to confirm');
            return;
        }

        // 更新占位标注的内容
        placeholder.updateContent(data);

        // 确认后默认收起，使 collapsedTitleSpan 在 showTitleWhenCollapsed 时立即显示
        placeholder.setCollapsed(true);

        // 将占位标注添加到标注列表
        this.annotations.set(placeholder.id, placeholder);

        // 同步到设置
        this.syncToSettings();

        // 触发标注创建事件
        if (this.global.events) {
            this.global.events.fire('annotation:created', { id: placeholder.id });
        }

        // 记录到编辑历史 (需求 6.1)
        // 使用快照方式记录整个设置状态，撤销时会恢复到创建前的状态（删除标注）
        pushEditHistory(this.global, 'annotation:created');

        // 清空占位标注引用
        this.currentPlaceholder = null;

        // 取消激活放置模式
        this.placementMode.deactivate();

        // 更新状态
        if (this.global.state) {
            this.global.state.annotationPlacementActive = false;
        }
    }

    /**
     * 更新已有标注的内容
     *
     * @param id - 标注 ID
     * @param data - 新的表单数据
     */
    updateAnnotation(id: string, data: AnnotationFormData): void {
        const annotation = this.annotations.get(id);

        if (!annotation) {
            console.warn(`Annotation with id ${id} not found`);
            return;
        }

        annotation.updateContent(data);
        this.syncToSettings();

        if (this.global.events) {
            this.global.events.fire('annotation:updated', { id });
        }
    }

    /**
     * 取消标注创建
     * 
     * 取消当前的标注创建流程，移除占位标注
     */
    cancelAnnotation(): void {
        const placeholder = this.currentPlaceholder;

        if (placeholder) {
            // 移除占位标注实体
            placeholder.entity.destroy();
            this.currentPlaceholder = null;
        }

        // 取消激活放置模式
        this.placementMode.cancelPlacement();

        // 更新状态
        if (this.global.state) {
            this.global.state.annotationPlacementActive = false;
        }
    }

    /**
     * 删除标注
     * 
     * 从场景和标注列表中删除指定标注
     * 
     * @param id - 标注 ID
     */
    deleteAnnotation(id: string): void {
        const annotation = this.annotations.get(id);

        if (!annotation) {
            console.warn(`Annotation with id ${id} not found`);
            return;
        }

        // 如果是当前选中的标注，先取消选择
        if (this.selectedAnnotationId === id) {
            this.deselectAnnotation();
        }

        // 从映射表中移除
        this.annotations.delete(id);

        // 销毁实体
        annotation.entity.destroy();

        // 同步到设置
        this.syncToSettings();

        // 触发标注删除事件
        if (this.global.events) {
            this.global.events.fire('annotation:deleted', { id });
        }

        // 记录到编辑历史 (需求 6.2)
        // 使用快照方式记录整个设置状态，撤销时会恢复到删除前的状态（恢复标注）
        pushEditHistory(this.global, 'annotation:deleted');
    }

    /**
     * 选中标注
     * 
     * @param id - 标注 ID
     * @param options - showGizmo: 是否同时显示 Transform Gizmo，默认 false（仅点击底部「移动」时显示 Gizmo）
     */
    selectAnnotation(id: string, options?: { showGizmo?: boolean }): void {
        const annotation = this.annotations.get(id);

        if (!annotation) {
            console.warn(`Annotation with id ${id} not found`);
            return;
        }

        const showGizmo = options?.showGizmo ?? false;

        // 如果已经选中其他标注，先取消选择
        if (this.selectedAnnotationId && this.selectedAnnotationId !== id) {
            this.deselectAnnotation();
        }

        // 更新选中状态
        this.selectedAnnotationId = id;

        // 仅当显式请求时启用 Transform Gizmo（符合「先点击热点、再点击移动按钮」才显示 Gizmo）
        if (showGizmo) {
            annotation.enableGizmo();
        }

        // 更新全局状态
        if (this.global.state) {
            this.global.state.selectedAnnotationId = id;
        }

        // 触发标注选中事件
        if (this.global.events) {
            this.global.events.fire('annotation:selected', { id });
        }
    }

    /**
     * 为当前选中的标注显示 Transform Gizmo（底部「移动」按钮点击时调用）
     */
    enableGizmoForSelected(): void {
        if (!this.selectedAnnotationId) return;
        const annotation = this.annotations.get(this.selectedAnnotationId);
        if (annotation) {
            annotation.enableGizmo();
        }
    }

    /**
     * 取消选中标注
     * 
     * 取消当前选中的标注并隐藏 Transform Gizmo
     */
    deselectAnnotation(): void {
        if (!this.selectedAnnotationId) {
            return;
        }

        const annotation = this.annotations.get(this.selectedAnnotationId);

        if (annotation) {
            annotation.disableGizmo();
            annotation.hideTooltip();
        }

        // 清空选中状态
        this.selectedAnnotationId = null;

        // 更新全局状态
        if (this.global.state) {
            this.global.state.selectedAnnotationId = null;
        }

        // 触发标注取消选中事件
        if (this.global.events) {
            this.global.events.fire('annotation:deselected');
        }
    }

    /**
     * 获取当前占位标注（放置模式中尚未确认的标注）
     *
     * @returns 当前占位标注，如果没有则返回 null
     */
    getPlaceholderAnnotation(): AnnotationEntity | null {
        return this.currentPlaceholder;
    }

    /**
     * 获取当前选中的标注
     * 
     * @returns 当前选中的标注实体，如果没有则返回 null
     */
    getSelectedAnnotation(): AnnotationEntity | null {
        if (!this.selectedAnnotationId) {
            return null;
        }

        return this.annotations.get(this.selectedAnnotationId) || null;
    }

    /**
     * 获取所有标注
     * 
     * @returns 所有标注实体的数组
     */
    getAllAnnotations(): AnnotationEntity[] {
        return Array.from(this.annotations.values());
    }

    /**
     * 设置所有标注的可见性（与 UI 可见性同步）
     * 
     * 当 UI 隐藏时（如 controlsHidden）调用以隐藏所有标注；
     * 当 UI 显示时调用以显示所有标注。
     * 使用独立的 entity.enabled 控制，不与视锥剔除冲突（视锥剔除可在此基础上进一步过滤）。
     * 
     * @param visible - true 显示，false 隐藏
     */
    setAllAnnotationsVisible(visible: boolean): void {
        this.annotations.forEach((annotation) => {
            annotation.entity.enabled = visible;
        });
        // 占位标注也需要同步
        if (this.currentPlaceholder) {
            this.currentPlaceholder.entity.enabled = visible;
        }
    }

    /**
     * 获取标注数据
     * 
     * @param id - 标注 ID
     * @returns 标注数据，如果不存在则返回 null
     */
    getAnnotationData(id: string): AnnotationData | null {
        const annotation = this.annotations.get(id);
        return annotation ? annotation.serialize() : null;
    }

    /**
     * 同步到设置
     * 
     * 将当前所有标注数据同步到全局设置对象
     */
    syncToSettings(): void {
        if (!this.global.settings) {
            return;
        }

        // 序列化所有标注
        const annotationsData: AnnotationData[] = Array.from(this.annotations.values())
            .map(annotation => annotation.serialize());

        // 更新设置对象
        this.global.settings.annotations = annotationsData;
    }

    /**
     * 从设置加载
     * 
     * 从全局设置对象中加载标注数据。
     * 
     * 此方法在以下场景被调用：
     * 1. AnnotationManager 初始化时，加载已保存的标注
     * 2. EditHistory 撤销/重做时，通过 restoreAnnotationsFromSettings() 调用
     * 
     * 该方法会清空所有现有标注并从设置中重新创建，确保标注状态
     * 与设置快照完全一致 (需求 6.4, 6.5)。
     */
    loadFromSettings(): void {
        if (!this.global.settings || !this.global.settings.annotations) {
            return;
        }

        // 清空现有标注
        this.annotations.forEach(annotation => {
            annotation.entity.destroy();
        });
        this.annotations.clear();

        // 从设置中反序列化标注
        this.global.settings.annotations.forEach(data => {
            try {
                const annotation = AnnotationEntity.deserialize(data, this.global);
                this.annotations.set(annotation.id, annotation);
            } catch (error) {
                console.error(`Failed to load annotation ${data.id}:`, error);
            }
        });
    }

    /**
     * 处理标注放置事件
     * 
     * 当用户在场景中点击时，创建占位标注
     * 
     * @param position - 3D 位置
     * @private
     */
    private onAnnotationPlace(position: Vec3): void {
        const id = this.pendingPlacementId ?? this.generateAnnotationId();
        this.pendingPlacementId = null;

        const preset = this.pendingFormData.get(id);
        this.pendingFormData.delete(id);

        // 创建占位标注数据：位置由点击确定，内容优先使用预填表单数据
        const data: AnnotationData = {
            id,
            position: [position.x, position.y, position.z],
            title: preset?.title ?? 'Untitled',
            text: preset?.text ?? 'Description...',
            imageUrl: preset?.imageUrl,
            showTitleWhenCollapsed: preset?.showTitleWhenCollapsed ?? false,
            // collapsed 在新语义下仅用于兼容老数据，这里始终以默认收起为准
            collapsed: true,
            extras: {},
            camera: {
                initial: {
                    position: [0, 0, 0],
                    target: [0, 0, 0],
                    fov: 60
                }
            }
        };

        // 创建占位标注实体
        const annotation = AnnotationEntity.deserialize(data, this.global);

        // 保存为当前占位标注
        this.currentPlaceholder = annotation;

        // 设置到 PlacementMode
        this.placementMode.setPlaceholderAnnotation(annotation);

        // 放置后自动显示完整 tooltip 窗口（不切换收起状态）
        annotation.showTooltip(true);

        // 供 message-bridge 上报 ANNOTATION_PLACEMENT_UPDATE
        if (this.global.events) {
            this.global.events.fire('annotationPlacement:update', { id: annotation.id, value: annotation.serialize() });
        }
    }

    /**
     * 处理标注更新事件（如展开/收起状态变化）
     * 
     * 同步到设置以持久化状态
     * 
     * @private
     */
    private onAnnotationUpdated(): void {
        this.syncToSettings();
    }

    /**
     * 处理标注移动完成事件
     * 
     * 当标注通过 Transform Gizmo 移动完成时，同步到设置并记录历史
     * 
     * @param data - 事件数据，包含 entity 和 position
     * @private
     */
    private onAnnotationMoveComplete(data: { entity: any; position: Vec3 }): void {
        // 同步到设置
        this.syncToSettings();

        // 记录到编辑历史 (需求 6.3)
        // 使用快照方式记录整个设置状态，撤销时会恢复到移动前的位置
        pushEditHistory(this.global, 'annotation:moved');
    }

    /**
     * 生成唯一的标注 ID
     * 
     * @returns 唯一的标注 ID
     * @private
     */
    private generateAnnotationId(): string {
        // 使用时间戳和随机数生成唯一 ID
        return `annotation-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    /**
     * 销毁管理器
     * 
     * 清理所有资源和事件监听器
     */
    destroy(): void {
        // 移除事件监听器
        if (this.global.events) {
            this.global.events.off('annotation:place', this.onAnnotationPlace, this);
            this.global.events.off('annotation:moveComplete', this.onAnnotationMoveComplete, this);
            this.global.events.off('annotation:updated', this.onAnnotationUpdated, this);
        }

        // 销毁所有标注
        this.annotations.forEach(annotation => {
            annotation.entity.destroy();
        });
        this.annotations.clear();

        // 清理占位标注
        if (this.currentPlaceholder) {
            this.currentPlaceholder.entity.destroy();
            this.currentPlaceholder = null;
        }
    }
}
