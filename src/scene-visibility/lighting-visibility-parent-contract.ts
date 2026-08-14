/**
 * Phase 0 父级回包金标准。
 * 与 `message-bridge.ts` 当前出站序列对齐；后续 Facade 必须逐条匹配。
 * 不改变生产 apply；不作为画面真源。
 */
import type { LightingVisibilityKey } from '../view-settings';
import {
    SCENE_CONTENT_ALL_SET_HIDE_ORDER,
    SCENE_CONTENT_ALL_SET_SHOW_ORDER,
    type SceneContentCategoryId
} from './types';

export type ParentOutboundMessage = {
    type: string;
    category?: SceneContentCategoryId;
    value?: boolean;
    categories?: readonly SceneContentCategoryId[];
};

/** 必须与 `message-bridge.ts` `LIGHTING_SHOW_HIDE_CHANGED_BY_KEY` 一致 */
export const LIGHTING_SHOW_HIDE_CHANGED_BY_KEY: Record<LightingVisibilityKey, string> = {
    brightness: 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED',
    bloom: 'LIGHTING_BLOOM_SHOW_HIDE_CHANGED',
    shadow: 'LIGHTING_SHADOW_SHOW_HIDE_CHANGED'
};

export const PARENT_LIGHTING_SUB_KEYS_WITHOUT_SHADOW: readonly LightingVisibilityKey[] = [
    'brightness',
    'bloom'
];

export const PARENT_LIGHTING_SUB_KEYS_WITH_SHADOW: readonly LightingVisibilityKey[] = [
    'brightness',
    'bloom',
    'shadow'
];

/**
 * 无 sceneMesh 时父级不同步 shadow 子项 CHANGED。
 *
 * @param {boolean} shadowCapability - 是否已配置 GLB sceneMesh
 * @returns {readonly LightingVisibilityKey[]} 实际回包的子项 key
 */
export function lightingSubKeysForParent(shadowCapability: boolean): readonly LightingVisibilityKey[] {
    return shadowCapability ? PARENT_LIGHTING_SUB_KEYS_WITH_SHADOW : PARENT_LIGHTING_SUB_KEYS_WITHOUT_SHADOW;
}

function lightingSubsChanged(keys: readonly LightingVisibilityKey[], value: boolean): ParentOutboundMessage[] {
    return keys.map(key => ({
        type: LIGHTING_SHOW_HIDE_CHANGED_BY_KEY[key],
        value
    }));
}

/**
 * `SCENE_CONTENT_CATEGORY_SET` 成功变更 intent 后的出站序列。
 * intent 未变（`setCategoryVisible` 返回 false）时为空。
 *
 * @param {object} opts - 入站结果
 * @param {SceneContentCategoryId} opts.category - 大类
 * @param {boolean} opts.value - 目标显隐
 * @param {boolean} opts.intentChanged - Registry 是否发生 intent 变更
 * @param {boolean} opts.shadowCapability - 是否已配置 GLB sceneMesh
 * @returns {ParentOutboundMessage[]} 父级出站序列
 */
export function expectedOutboundForCategorySet(opts: {
    category: SceneContentCategoryId;
    value: boolean;
    intentChanged: boolean;
    shadowCapability: boolean;
}): ParentOutboundMessage[] {
    if (!opts.intentChanged) {
        return [];
    }
    const out: ParentOutboundMessage[] = [
        { type: 'SCENE_CONTENT_CATEGORY_CHANGED', category: opts.category, value: opts.value }
    ];
    if (opts.category === 'lights') {
        out.push(...lightingSubsChanged(lightingSubKeysForParent(opts.shadowCapability), opts.value));
    }
    return out;
}

/**
 * `SCENE_CONTENT_ALL_SET` 出站序列。
 * Registry 即使 intent 已是目标值仍返回完整 category 列表并 reapply；
 * `categories` 顺序与出站契约一致（冻结），不作为画面必须 lights 最后 apply 的约束。
 *
 * @param {object} opts - 入站
 * @param {boolean} opts.value - 全部大类目标显隐
 * @param {boolean} opts.shadowCapability - 是否已配置 GLB sceneMesh
 * @returns {ParentOutboundMessage[]} 父级出站序列
 */
export function expectedOutboundForAllSet(opts: {
    value: boolean;
    shadowCapability: boolean;
}): ParentOutboundMessage[] {
    const categories = opts.value ? SCENE_CONTENT_ALL_SET_SHOW_ORDER : SCENE_CONTENT_ALL_SET_HIDE_ORDER;
    const out: ParentOutboundMessage[] = [
        { type: 'SCENE_CONTENT_ALL_CHANGED', value: opts.value, categories }
    ];
    for (const category of categories) {
        out.push({ type: 'SCENE_CONTENT_CATEGORY_CHANGED', category, value: opts.value });
    }
    if (categories.includes('lights')) {
        out.push(...lightingSubsChanged(lightingSubKeysForParent(opts.shadowCapability), opts.value));
    }
    return out;
}

/**
 * `LIGHTING_*_SHOW_HIDE_SET` 出站。
 * 无 sceneMesh 时 shadow 恒 no-op；intent 未变也不出站。
 *
 * @param {object} opts - 入站结果
 * @param {LightingVisibilityKey} opts.key - brightness / bloom / shadow
 * @param {boolean} opts.value - 目标显隐
 * @param {boolean} opts.intentChanged - 子项 intent 是否变更
 * @param {boolean} opts.shadowCapability - 是否已配置 GLB sceneMesh
 * @returns {ParentOutboundMessage[]} 父级出站序列
 */
export function expectedOutboundForLightingAspectSet(opts: {
    key: LightingVisibilityKey;
    value: boolean;
    intentChanged: boolean;
    shadowCapability: boolean;
}): ParentOutboundMessage[] {
    if (opts.key === 'shadow' && !opts.shadowCapability) {
        return [];
    }
    if (!opts.intentChanged) {
        return [];
    }
    return [{ type: LIGHTING_SHOW_HIDE_CHANGED_BY_KEY[opts.key], value: opts.value }];
}

/** `LIGHT_TOGGLE` / `LIGHT_TOGGLE_ALL` 不得向父级发 Scene Content / Lighting 显隐 CHANGED */
export const EXPECTED_OUTBOUND_FOR_LIGHT_TOGGLE: readonly ParentOutboundMessage[] = [];
