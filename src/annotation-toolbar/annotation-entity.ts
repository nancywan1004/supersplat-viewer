/**
 * AnnotationEntity - 扩展的标注实体类
 * 
 * 扩展现有的 Annotation 类，添加编辑模式所需的功能：
 * - 内容更新（标题、正文、图片）
 * - 展开/收起状态控制
 * - 数据序列化和反序列化
 */

import { Vec3, Entity } from 'playcanvas';
import { Annotation } from '../annotation';
import type { AnnotationData, AnnotationFormData } from './types';
import type { Global } from '../types';

/**
 * AnnotationEntity 类
 * 
 * 扩展 Annotation 脚本类，添加编辑模式功能
 */
export class AnnotationEntity extends Annotation {
    static scriptName = 'annotationEntity';

    /** 唯一标识符 */
    id: string;

    /** 标注数据 */
    data: AnnotationData;

    /** 是否处于锚定展开状态（点击热点切换），hover 不会修改该状态 */
    private anchored: boolean = false;

    /** Global 引用 */
    private global: Global;

    /** 收起时显示的标题 DOM（当 showTitleWhenCollapsed 为 true 时） */
    private collapsedTitleSpan: HTMLSpanElement | null = null;

    /**
     * 初始化标注实体
     */
    initialize() {
        // 仅热点控制展开/收起，点击其他区域不触发
        (this as any).closeOnDocumentClick = false;
        // 热点纹理不绘制 id，标题由 collapsedTitleSpan 根据 showTitleWhenCollapsed 显示
        this.label = '';
        super.initialize();

        // 收起时显示的标题：pill 样式由 .pc-annotation-collapsed-title 控制
        this.collapsedTitleSpan = document.createElement('span');
        this.collapsedTitleSpan.className = 'pc-annotation-collapsed-title';
        this.collapsedTitleSpan.style.cssText = 'position:absolute;pointer-events:none;display:none;transform:translate(-50%,-100%);';
        Annotation.parentDom.appendChild(this.collapsedTitleSpan);

        this.on('destroy', () => {
            this.collapsedTitleSpan?.remove();
            this.collapsedTitleSpan = null;
        });

        // 点击热点时切换锚定展开状态；在编辑模式 + 标注模块下额外触发选中
        const hotspotDom = (this as any).hotspotDom as HTMLDivElement | null;
        if (hotspotDom) {
            hotspotDom.addEventListener('click', () => {
                const g = this.global;
                const s = g?.state;
                if (g && s?.editMode && s?.editLeftModule === 'annotation' && g.events) {
                    g.events.fire('annotation:selectFromHotspot', { id: this.id });
                }
                // 点击切换锚定展开：锚定时不会因为鼠标离开而收起；再次点击取消锚定（编辑模式与非编辑模式一致）
                this.toggleAnchored();
            });
            hotspotDom.addEventListener('pointerenter', () => {
                // 悬停时短期展开（不修改 anchored）；移开时若未锚定则收起
                this.showTooltip(true);
            });
            hotspotDom.addEventListener('pointerleave', () => {
                if (!this.anchored) {
                    this.hideTooltip();
                }
            });
        }

        // 与 UI 的 controlsHidden 联动：tooltip 显示时阻止 4 秒无操作自动隐藏
        this.on('show', () => this.global?.events?.fire('annotation.activate', this));
        this.on('hide', () => this.global?.events?.fire('annotation.deactivate'));

        this._updateVisibility();
    }

    /** 重写：同时定位收起时的标题 */
    _updatePositions(screenPos: Vec3): void {
        super._updatePositions(screenPos);
        if (!this.collapsedTitleSpan) return;
        const show = !this.isTooltipVisible() && !!this.title && !!(this.data?.showTitleWhenCollapsed);
        if (show) {
            const offsetY = (Annotation.hotspotSize + 5) / 2 + 6;
            this.collapsedTitleSpan.textContent = this.title;
            this.collapsedTitleSpan.style.left = `${screenPos.x}px`;
            this.collapsedTitleSpan.style.top = `${screenPos.y - offsetY}px`;
            this.collapsedTitleSpan.style.display = 'block';
        } else {
            this.collapsedTitleSpan.style.display = 'none';
        }
    }

    /** 重写：标注在相机背后时隐藏收起标题 */
    _hideElements(): void {
        super._hideElements();
        if (this.collapsedTitleSpan) this.collapsedTitleSpan.style.display = 'none';
    }

    /**
     * 更新标注内容
     * 
     * @param data - 部分表单数据（标题、正文、图片、收起时显示标题选项）
     */
    updateContent(data: Partial<AnnotationFormData>): void {
        if (data.title !== undefined) {
            this.title = data.title;
            this.data.title = data.title;
        }

        if (data.text !== undefined) {
            this.text = data.text;
            this.data.text = data.text;
        }

        if (data.imageUrl !== undefined) {
            this.data.imageUrl = data.imageUrl;
        }

        if (data.showTitleWhenCollapsed !== undefined) {
            this.data.showTitleWhenCollapsed = data.showTitleWhenCollapsed;
        }

        // 更新显示（包括收起标题）
        this._updateVisibility();

        // 若当前 tooltip 正在显示，需要同步更新 tooltip DOM 的内容
        if (this.isTooltipVisible()) {
            this.showTooltip(false);
        }

        // 触发更新事件
        if (this.global?.events) {
            this.global.events.fire('annotation:updated', { id: this.id });
        }
    }

    /**
     * 兼容旧调用：设置「收起 / 展开」状态
     *
     * 新语义：
     * - collapsed === true  → 视为收起：取消锚定并收起 tooltip，仅按照 showTitleWhenCollapsed 显示收起标题
     * - collapsed === false → 视为展开：锚定展开 tooltip，不因鼠标移开而收起
     */
    setCollapsed(collapsed: boolean): void {
        this.data.collapsed = collapsed;
        if (collapsed) {
            this.anchored = false;
            this.hideTooltip();
        } else {
            this.anchored = true;
            this.showTooltip(false);
        }
        this._updateVisibility();
        if (this.global?.events) {
            this.global.events.fire('annotation:updated', { id: this.id });
        }
    }

    /**
     * 展开 tooltip（不负责锚定状态，仅根据当前 anchored / 调用方语义控制）
     *
     * @param _fromHover - 为 true 时表示由 hover 触发，仅短期展开
     */
    showTooltip(_fromHover?: boolean): void {
        Annotation.activeAnnotation = this;
        Annotation.tooltipDom!.style.visibility = 'visible';
        Annotation.tooltipDom!.style.opacity = '1';
        Annotation.titleDom!.textContent = this.title;
        Annotation.textDom!.textContent = this.text;
        if (Annotation.imageDom) {
            if (this.data?.imageUrl) {
                Annotation.imageDom.src = this.data.imageUrl;
                Annotation.imageDom.style.display = 'block';
            } else {
                // 无图片时彻底移除占位：清空 src 并隐藏
                Annotation.imageDom.removeAttribute('src');
                Annotation.imageDom.style.display = 'none';
            }
        }
        this._update();
        this.fire('show', this);
    }

    /** 切换锚定展开状态（点击热点时调用） */
    private toggleAnchored(): void {
        this.anchored = !this.anchored;
        if (this.anchored) {
            this.showTooltip(false);
        } else {
            this.hideTooltip();
        }
    }

    /**
     * 重写：隐藏时仅控制 tooltip，不修改锚定状态
     */
    hideTooltip(): void {
        super.hideTooltip();
    }
    /** 当前 tooltip 是否可见（用于决定是否展示收起标题） */
    private isTooltipVisible(): boolean {
        return Annotation.activeAnnotation === this && Annotation.tooltipDom?.style.opacity === '1';
    }

    /**
     * 设置标注位置
     *
     * @param position - 新的 3D 位置
     */
    setPosition(position: Vec3): void {
        this.entity.setPosition(position);
        this.data.position = [position.x, position.y, position.z];

        // 触发位置更新事件
        if (this.global?.events) {
            this.global.events.fire('annotation:moved', { id: this.id, position });
        }
    }

    /**
     * 获取标注位置
     * 
     * @returns 当前 3D 位置
     */
    getPosition(): Vec3 {
        return this.entity.getPosition().clone();
    }

    /**
     * 启用 Transform Gizmo
     *
     * 激活 Transform Gizmo 并附加到此标注实体
     */
    enableGizmo(): void {
        if (!this.global?.events) {
            return;
        }

        this.global.events.fire('gizmo:attach', {
            entity: this.entity,
            onMove: (position: Vec3) => {
                this.setPosition(position);
            }
        });
    }

    /**
     * 禁用 Transform Gizmo
     *
     * 隐藏并分离 Transform Gizmo
     */
    disableGizmo(): void {
        if (!this.global?.events) {
            return;
        }

        this.global.events.fire('gizmo:detach');
    }

    /**
     * 序列化标注数据
     * 
     * @returns 序列化后的标注数据对象
     */
    serialize(): AnnotationData {
        const position = this.getPosition();
        
        return {
            id: this.id,
            position: [position.x, position.y, position.z],
            title: this.title,
            text: this.text,
            imageUrl: this.data.imageUrl,
            showTitleWhenCollapsed: this.data.showTitleWhenCollapsed,
            // collapsed 字段仅为兼容旧数据，始终视为默认收起
            collapsed: false,
            extras: this.data.extras,
            camera: this.data.camera
        };
    }

    /**
     * 从数据反序列化创建标注实体
     * 
     * @param data - 标注数据对象
     * @param global - Global 引用
     * @returns 创建的标注实体
     */
    static deserialize(data: AnnotationData, global: Global): AnnotationEntity {
        // 创建实体
        const entity = new Entity(`annotation-${data.id}`);
        entity.addComponent('script');
        entity.script.create(AnnotationEntity);

        // 获取脚本实例
        const script = entity.script as any;
        const annotationEntity: AnnotationEntity = script.annotationEntity;

        // 设置数据
        annotationEntity.id = data.id;
        annotationEntity.data = data;
        annotationEntity.label = data.id;
        annotationEntity.title = data.title;
        annotationEntity.text = data.text;
        annotationEntity.global = global;
        annotationEntity.anchored = false;

        // 设置位置
        entity.setPosition(data.position[0], data.position[1], data.position[2]);

        // 添加到场景
        global.app.root.addChild(entity);

        return annotationEntity;
    }

    /**
     * 更新可见性（根据展开/收起状态）
     * 
     * 根据当前的展开/收起状态和配置，更新标注的显示内容
     * @private
     */
    private _updateVisibility(): void {
        // anchored / tooltip 可见性决定是否展示收起标题，逻辑在 _updatePositions 中处理
        if (this.collapsedTitleSpan && !(this.data?.showTitleWhenCollapsed && this.title)) {
            this.collapsedTitleSpan.style.display = 'none';
        }
        if (this.app) this.app.renderNextFrame = true;
    }
}

