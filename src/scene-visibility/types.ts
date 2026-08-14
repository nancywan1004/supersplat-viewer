import type { Global } from '../types';

/** 场景内容显隐大类（容器对外协议 `category`） */
export type SceneContentCategoryId =
    | 'assets'
    | 'annotations'
    | 'lights'
    | 'reveal'
    | 'persistent'
    | 'stylization';

export const SCENE_CONTENT_CATEGORY_IDS: readonly SceneContentCategoryId[] = [
    'assets',
    'annotations',
    'lights',
    'reveal',
    'persistent',
    'stylization'
] as const;

/** Reveal / 导出锁定时参与 runtimeGate 的大类（不含特效/滤镜） */
export const SCENE_CONTENT_DEFER_CATEGORY_IDS: readonly SceneContentCategoryId[] = [
    'assets',
    'annotations',
    'lights'
] as const;

/**
 * ALL_SET 出站 / 遍历顺序（父级契约冻结）。
 * 画面不再依赖 lights 最后 apply：ALL_SET 在 Coordinator batch 结束后一次 reconcile。
 */
export const SCENE_CONTENT_ALL_SET_HIDE_ORDER: readonly SceneContentCategoryId[] = [
    'assets',
    'annotations',
    'persistent',
    'stylization',
    'reveal',
    'lights'
];

export const SCENE_CONTENT_ALL_SET_SHOW_ORDER: readonly SceneContentCategoryId[] = [
    'assets',
    'annotations',
    'reveal',
    'persistent',
    'stylization',
    'lights'
];

export type SceneContentVisibilityMap = Partial<Record<SceneContentCategoryId, boolean>>;

/**
 * 大类适配器（intent 来自 `viewSettings.contentVisibility`）。
 * - `applyCategoryIntent`：仅纯 Viewer 套用运行态；特效写 `effectsSession`，不写编辑 settings
 * - `applyRuntimeGate`：reveal/导出门控；编辑态忽略 contentVisibility intent
 * - `setInstanceVisible`：lights 会话 overlay（Viewer `LIGHT_TOGGLE`）
 */
export interface SceneContentVisibilityAdapter {
    readonly id: SceneContentCategoryId;
    applyCategoryIntent(global: Global, intentVisible: boolean): void;
    applyRuntimeGate?(global: Global, gateOpen: boolean, intentVisible: boolean): void;
    setInstanceVisible?(global: Global, instanceId: string, visible: boolean): void;
}

export function isSceneContentCategoryId(value: unknown): value is SceneContentCategoryId {
    return typeof value === 'string' && (SCENE_CONTENT_CATEGORY_IDS as readonly string[]).includes(value);
}

export function categoryParticipatesInRuntimeGate(category: SceneContentCategoryId): boolean {
    return (SCENE_CONTENT_DEFER_CATEGORY_IDS as readonly string[]).includes(category);
}
