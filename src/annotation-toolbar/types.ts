/**
 * 标注工具栏相关的类型定义
 */

import type { Vec3 } from 'playcanvas';
import type { Annotation } from '../schemas/v2';

/**
 * 标注表单数据（用户输入的数据）
 */
export interface AnnotationFormData {
    /** 标题（最大 20 字符） */
    title: string;
    /** 正文（最大 50 字符） */
    text: string;
    /** 可选图片 URL */
    imageUrl?: string;
    /** 收起时是否显示标题 */
    showTitleWhenCollapsed: boolean;
}

/**
 * 标注数据（完整的标注信息，包含位置）
 */
export interface AnnotationData extends Annotation {
    id: string;
    position: [number, number, number];
    title: string;
    text: string;
    imageUrl?: string;
    showTitleWhenCollapsed: boolean;
    collapsed: boolean;
}

/**
 * 放置模式状态
 */
export enum PlacementState {
    /** 未激活 */
    Inactive = 'inactive',
    /** 跟随光标 */
    Following = 'following',
    /** 已放置 */
    Placed = 'placed'
}

/**
 * 标注工具栏事件类型
 */
export interface AnnotationToolbarEvents {
    /** 标注创建模式开始 */
    'annotationPlacement:started': void;
    /** 标注放置模式结束 */
    'annotationPlacement:ended': void;
    /** 标注已创建 */
    'annotation:created': { id: string };
    /** 标注已删除 */
    'annotation:deleted': { id: string };
    /** 标注已选中 */
    'annotation:selected': { id: string };
    /** 标注已取消选中 */
    'annotation:deselected': void;
    /** 标注位置已更新 */
    'annotation:moved': { id: string; position: Vec3 };
    /** 标注内容已更新 */
    'annotation:updated': { id: string };
}
