/**
 * AnnotationEntity - 扩展的标注实体类
 * 
 * 扩展现有的 Annotation 类，添加编辑模式所需的功能：
 * - 内容更新（标题、正文、图片）
 * - 展开/收起状态控制
 * - Transform Gizmo 集成
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

    /** 是否处于收起状态 */
    private _collapsed: boolean = false;

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

        // 初始化收起状态
        this._collapsed = this.data?.collapsed ?? false;

        // 收起时显示的标题：挂到 parentDom（hotspot 有 opacity:0 会隐藏子元素）
        this.collapsedTitleSpan = document.createElement('span');
        this.collapsedTitleSpan.className = 'pc-annotation-collapsed-title';
        this.collapsedTitleSpan.style.cssText = 'position:absolute;white-space:nowrap;font-size:12px;color:white;text-shadow:0 1px 2px rgba(0,0,0,0.8);pointer-events:none;display:none;transform:translateY(-50%);';
        Annotation.parentDom.appendChild(this.collapsedTitleSpan);

        this.on('destroy', () => {
            this.collapsedTitleSpan?.remove();
            this.collapsedTitleSpan = null;
        });

        // 编辑模式 + 标注模块下，点击热点时仅选中该标注（不显示 Gizmo；Gizmo 需点击底部「移动」后显示）
        const hotspotDom = (this as any).hotspotDom as HTMLDivElement | null;
        if (hotspotDom && this.global?.state && this.global?.events) {
            hotspotDom.addEventListener('click', () => {
                const s = this.global!.state;
                if (s?.editMode && s?.editLeftModule === 'annotation') {
                    this.global!.events.fire('annotation:selectFromHotspot', { id: this.id });
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
        const show = this._collapsed && this.data?.showTitleWhenCollapsed && !!this.title;
        if (show) {
            const offset = (Annotation.hotspotSize + 5) / 2 + 6;
            this.collapsedTitleSpan.style.left = `${screenPos.x + offset}px`;
            this.collapsedTitleSpan.style.top = `${screenPos.y}px`;
            this.collapsedTitleSpan.style.display = 'block';
        } else {
            this.collapsedTitleSpan.style.display = 'none';
        }
    }

    /** 重写：标注在相机背后时隐藏收起标题 */
    _hideElements(): void {
        super._hideElements();
        if (this.collapsedTitleSpan) {
            this.collapsedTitleSpan.style.display = 'none';
        }
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

        // 更新显示
        this._updateVisibility();

        // 触发更新事件
        if (this.global?.events) {
            this.global.events.fire('annotation:updated', { id: this.id });
        }
    }

    /**
     * 重写：点击热点时切换展开/收起，而非直接显示 tooltip
     *
     * @param skipToggle - 为 true 时仅显示 tooltip，不切换收起状态（用于占位标注放置后自动展示）
     */
    showTooltip(skipToggle?: boolean): void {
        if (!skipToggle) {
            this.toggleCollapsed();
            if (this._collapsed) {
                return; // 已收起，_updateVisibility 会隐藏 tooltip
            }
        }
        // 展开状态：显示完整 tooltip（标题、正文、图片）
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
                Annotation.imageDom.style.display = 'none';
            }
        }
        this._update();
        this.fire('show', this);
    }

    /**
     * 设置展开/收起状态
     * 
     * @param collapsed - true 为收起，false 为展开
     */
    setCollapsed(collapsed: boolean): void {
        if (this._collapsed === collapsed) {
            return;
        }

        this._collapsed = collapsed;
        this.data.collapsed = collapsed;
        this._updateVisibility();

        // 触发更新事件
        if (this.global?.events) {
            this.global.events.fire('annotation:updated', { id: this.id });
        }
    }

    /**
     * 切换展开/收起状态
     */
    toggleCollapsed(): void {
        this.setCollapsed(!this._collapsed);
    }

    /**
     * 重写：隐藏时自动收起，避免弹窗消失但 title 不显示
     */
    hideTooltip(): void {
        if (!this._collapsed) {
            this.setCollapsed(true);
        }
        super.hideTooltip();
    }

    /**
     * 获取当前是否处于收起状态
     * 
     * @returns true 为收起，false 为展开
     */
    isCollapsed(): boolean {
        return this._collapsed;
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

        // 触发 Gizmo 启用事件
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

        // 触发 Gizmo 禁用事件
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
            collapsed: this._collapsed,
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
        annotationEntity._collapsed = data.collapsed ?? false;

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
        if (this._collapsed) {
            if (Annotation.activeAnnotation === this) this.hideTooltip();
            if (this.collapsedTitleSpan) {
                if (this.data?.showTitleWhenCollapsed && this.title) {
                    this.collapsedTitleSpan.textContent = this.title;
                    // display 由 _updatePositions 在设置位置时一并设置
                } else {
                    this.collapsedTitleSpan.style.display = 'none';
                }
            }
        } else {
            if (this.collapsedTitleSpan) this.collapsedTitleSpan.style.display = 'none';
            // 展开状态：自动显示 tooltip，否则只显示热点无内容
            this.showTooltip(true);
        }

        if (this.app) this.app.renderNextFrame = true;
    }
}

