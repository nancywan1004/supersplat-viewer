import type { Global, LightingContentVisibility, ViewSettings } from './types';
import type { ExperienceSettings } from './schemas/v2';
import { type SceneContentCategoryId } from './scene-visibility/types';

/** 观看态 Bloom 用户灯总闸默认开启 */
export const DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED = true;

/** 观看态场景 video/audio 热区默认不静音 */
export const DEFAULT_VIEW_MEDIA_MUTED = false;

/** 观看态标注 / 各大类默认可见 */
export const DEFAULT_VIEW_ANNOTATIONS_VISIBLE = true;

/** 全局手电筒默认关闭（仅会话态，不入库；TORCH_TOGGLE 控制，与 TORCH_ADD 解耦） */
export const DEFAULT_VIEW_TORCH_ACTIVE = false;

/** 观看态光照子项显隐默认开启 */
export const DEFAULT_VIEW_LIGHTING_VISIBILITY = {
    brightness: true,
    bloom: true,
    shadow: true
} as const;

export type LightingVisibilityKey = keyof typeof DEFAULT_VIEW_LIGHTING_VISIBILITY;

const BOOLEAN_CONTENT_CATEGORY_IDS: readonly Exclude<SceneContentCategoryId, 'lights'>[] = [
    'assets',
    'annotations',
    'reveal',
    'persistent',
    'stylization'
];

/** 默认 `contentVisibility.lights` 从属节点（无 instances） */
export function createDefaultLightsContent(): LightingContentVisibility {
    return {
        visible: true,
        brightness: DEFAULT_VIEW_LIGHTING_VISIBILITY.brightness,
        bloom: DEFAULT_VIEW_LIGHTING_VISIBILITY.bloom,
        shadow: DEFAULT_VIEW_LIGHTING_VISIBILITY.shadow
    };
}

/**
 * 纯解读：boolean `lights` / 不完整节点 → 从属节点。不写 viewSettings。
 *
 * @param {unknown} lights - `contentVisibility.lights`
 * @returns {LightingContentVisibility} 解读后的节点
 */
export function interpretLightingContentVisibility(lights: unknown): LightingContentVisibility {
    const out = createDefaultLightsContent();

    if (typeof lights === 'boolean') {
        out.visible = lights;
        return out;
    }
    if (!lights || typeof lights !== 'object' || Array.isArray(lights)) {
        return out;
    }

    const node = lights as Record<string, unknown>;
    if (typeof node.visible === 'boolean') {
        out.visible = node.visible;
    }
    if (typeof node.brightness === 'boolean') {
        out.brightness = node.brightness;
    }
    if (typeof node.bloom === 'boolean') {
        out.bloom = node.bloom;
    }
    if (typeof node.shadow === 'boolean') {
        out.shadow = node.shadow;
    }
    if (node.instances && typeof node.instances === 'object' && !Array.isArray(node.instances)) {
        const instances: Record<string, boolean> = {};
        for (const [id, value] of Object.entries(node.instances as Record<string, unknown>)) {
            if (value === true || value === false) {
                instances[id] = value;
            }
        }
        if (Object.keys(instances).length > 0) {
            out.instances = instances;
        }
    }
    return out;
}

function categoryLightsVisible(node: LightingContentVisibility): boolean {
    return node.visible !== false;
}

function sessionOverlayShows(node: LightingContentVisibility, lightId: string): boolean {
    if (categoryLightsVisible(node)) {
        return node.instances?.[lightId] !== false;
    }
    return node.instances?.[lightId] === true;
}

function deleteLightInstanceKey(node: LightingContentVisibility, lightId: string): boolean {
    if (!node.instances || !(lightId in node.instances)) {
        return false;
    }
    delete node.instances[lightId];
    if (Object.keys(node.instances).length === 0) {
        delete node.instances;
    }
    return true;
}

/** 大类开时 `true` 是缺省，清掉以免下次关大类被当成强制开 */
function pruneDefaultLightInstanceKeys(node: LightingContentVisibility): void {
    if (!node.instances || !categoryLightsVisible(node)) {
        return;
    }
    for (const id of Object.keys(node.instances)) {
        if (node.instances[id] === true) {
            delete node.instances[id];
        }
    }
    if (Object.keys(node.instances).length === 0) {
        delete node.instances;
    }
}

function categoryAssetsVisible(vs: ViewSettings): boolean {
    return vs.contentVisibility?.assets !== false;
}

function sessionAssetOverlayShows(vs: ViewSettings, assetId: string): boolean {
    if (categoryAssetsVisible(vs)) {
        return vs.assetInstances?.[assetId] !== false;
    }
    return vs.assetInstances?.[assetId] === true;
}

function deleteAssetInstanceKey(vs: ViewSettings, assetId: string): boolean {
    if (!vs.assetInstances || !(assetId in vs.assetInstances)) {
        return false;
    }
    delete vs.assetInstances[assetId];
    if (Object.keys(vs.assetInstances).length === 0) {
        delete vs.assetInstances;
    }
    return true;
}

function pruneDefaultAssetInstanceKeys(vs: ViewSettings): void {
    if (!vs.assetInstances || !categoryAssetsVisible(vs)) {
        return;
    }
    for (const id of Object.keys(vs.assetInstances)) {
        if (vs.assetInstances[id] === true) {
            delete vs.assetInstances[id];
        }
    }
    if (Object.keys(vs.assetInstances).length === 0) {
        delete vs.assetInstances;
    }
}

function categoryAnnotationsVisible(vs: ViewSettings): boolean {
    return vs.contentVisibility?.annotations !== false;
}

function sessionAnnotationOverlayShows(vs: ViewSettings, annotationId: string): boolean {
    if (categoryAnnotationsVisible(vs)) {
        return vs.annotationInstances?.[annotationId] !== false;
    }
    return vs.annotationInstances?.[annotationId] === true;
}

function deleteAnnotationInstanceKey(vs: ViewSettings, annotationId: string): boolean {
    if (!vs.annotationInstances || !(annotationId in vs.annotationInstances)) {
        return false;
    }
    delete vs.annotationInstances[annotationId];
    if (Object.keys(vs.annotationInstances).length === 0) {
        delete vs.annotationInstances;
    }
    return true;
}

function pruneDefaultAnnotationInstanceKeys(vs: ViewSettings): void {
    if (!vs.annotationInstances || !categoryAnnotationsVisible(vs)) {
        return;
    }
    for (const id of Object.keys(vs.annotationInstances)) {
        if (vs.annotationInstances[id] === true) {
            delete vs.annotationInstances[id];
        }
    }
    if (Object.keys(vs.annotationInstances).length === 0) {
        delete vs.annotationInstances;
    }
}

function createDefaultContentVisibility(): NonNullable<ViewSettings['contentVisibility']> {
    return {
        assets: true,
        annotations: DEFAULT_VIEW_ANNOTATIONS_VISIBLE,
        lights: createDefaultLightsContent(),
        reveal: true,
        persistent: true,
        stylization: true
    };
}

function isLightsContentNode(value: unknown): value is LightingContentVisibility {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const node = value as LightingContentVisibility;
    return typeof node.visible === 'boolean'
        && typeof node.brightness === 'boolean'
        && typeof node.bloom === 'boolean'
        && typeof node.shadow === 'boolean';
}

function ensureLightsContentNode(vs: ViewSettings): LightingContentVisibility {
    if (!vs.contentVisibility || typeof vs.contentVisibility !== 'object') {
        vs.contentVisibility = createDefaultContentVisibility();
        return vs.contentVisibility.lights as LightingContentVisibility;
    }
    const current = vs.contentVisibility.lights;
    if (isLightsContentNode(current)) {
        return current;
    }
    const node = interpretLightingContentVisibility(current);
    vs.contentVisibility.lights = node;
    return node;
}

export function createDefaultViewSettings(): ViewSettings {
    return {
        bloom: { localLightsEnabled: DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED },
        mediaMuted: DEFAULT_VIEW_MEDIA_MUTED,
        contentVisibility: createDefaultContentVisibility(),
        torch: { active: DEFAULT_VIEW_TORCH_ACTIVE }
    };
}

/**
 * 确保 `global.viewSettings` 存在并完成缺省字段补齐（不入库；Viewer 进入编辑时继承同一会话对象）。
 */
export function ensureViewSettings(global: Global): ViewSettings {
    if (!global.viewSettings) {
        global.viewSettings = createDefaultViewSettings();
        return global.viewSettings;
    }
    const vs = global.viewSettings;
    if (!vs.bloom) {
        vs.bloom = { localLightsEnabled: DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED };
    } else if (typeof vs.bloom.localLightsEnabled !== 'boolean') {
        vs.bloom.localLightsEnabled = DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED;
    }
    if (typeof vs.mediaMuted !== 'boolean') {
        vs.mediaMuted = DEFAULT_VIEW_MEDIA_MUTED;
    }
    if (!vs.contentVisibility || typeof vs.contentVisibility !== 'object') {
        vs.contentVisibility = createDefaultContentVisibility();
    } else {
        for (const id of BOOLEAN_CONTENT_CATEGORY_IDS) {
            if (typeof vs.contentVisibility[id] !== 'boolean') {
                vs.contentVisibility[id] = true;
            }
        }
    }
    ensureLightsContentNode(vs);
    if (!vs.torch || typeof vs.torch !== 'object') {
        vs.torch = { active: DEFAULT_VIEW_TORCH_ACTIVE };
    } else if (typeof vs.torch.active !== 'boolean') {
        vs.torch.active = DEFAULT_VIEW_TORCH_ACTIVE;
    }
    return vs;
}

/** `LIGHT_TOGGLE_ALL`（local）→ 观看态局部亮灯总闸镜像 */
export function applyViewBloomLocalLightsEnabled(global: Global, enabled: boolean): void {
    ensureViewSettings(global).bloom.localLightsEnabled = enabled;
}

function ensureLightsContent(global: Global): LightingContentVisibility {
    return ensureLightsContentNode(ensureViewSettings(global));
}

/** 读 View 会话大类显隐（`viewSettings.contentVisibility`，缺省 true） */
export function readContentCategoryVisible(global: Global, category: SceneContentCategoryId): boolean {
    const vs = ensureViewSettings(global);
    if (category === 'lights') {
        return ensureLightsContent(global).visible !== false;
    }
    return vs.contentVisibility?.[category] !== false;
}

/**
 * 写 View 会话大类显隐（仅 viewSettings，不入库）。
 * 画面套用由 `SceneContentVisibilityRegistry` 负责；编辑态（含预览）不套用。
 * `lights` 只写从属节点的 `visible`，不改 brightness/bloom/shadow。
 * 大类重新显示时清掉已成缺省的强制开（`instances[id]=true`），避免下次再关大类时误开灯。
 * @returns 是否变更
 */
export function writeContentCategoryVisible(
    global: Global,
    category: SceneContentCategoryId,
    visible: boolean
): boolean {
    const vs = ensureViewSettings(global);
    if (!vs.contentVisibility) {
        vs.contentVisibility = createDefaultContentVisibility();
    }
    const next = !!visible;
    if (category === 'lights') {
        const node = ensureLightsContent(global);
        if (node.visible === next) {
            return false;
        }
        node.visible = next;
        if (next) {
            pruneDefaultLightInstanceKeys(node);
        }
        return true;
    }
    if (vs.contentVisibility[category] === next) {
        return false;
    }
    vs.contentVisibility[category] = next;
    if (category === 'assets' && next) {
        pruneDefaultAssetInstanceKeys(vs);
    }
    if (category === 'annotations' && next) {
        pruneDefaultAnnotationInstanceKeys(vs);
    }
    return true;
}

/**
 * 标注全局 overlay（收敛到 `contentVisibility.annotations`）。
 * @returns 是否发生变更
 */
export function applyViewAnnotationsVisible(global: Global, visible: boolean): boolean {
    return writeContentCategoryVisible(global, 'annotations', visible);
}

/**
 * `VIEW_MEDIA_MUTE_SET`：场景 video/audio 全局静音（`viewSettings.mediaMuted`，不入库）。
 * Viewer 与编辑模式共用同一会话值；进入编辑继承，编辑内可调，退出 View 仍保留。
 * @returns 是否发生变更
 */
export function applyViewMediaMuteSet(global: Global, muted: boolean): boolean {
    const vs = ensureViewSettings(global);
    const next = !!muted;
    if (vs.mediaMuted === next) return false;
    vs.mediaMuted = next;
    global.events.fire('viewMediaMuted:changed', { value: next });
    return true;
}

export function readViewMediaMuted(global: Global): boolean {
    return ensureViewSettings(global).mediaMuted === true;
}

export function readViewAnnotationsVisible(global: Global): boolean {
    return readContentCategoryVisible(global, 'annotations');
}

export function readViewBloomLocalLightsEnabled(global: Global): boolean {
    return ensureViewSettings(global).bloom.localLightsEnabled !== false;
}

export function readLightingVisibility(global: Global, key: LightingVisibilityKey): boolean {
    return ensureLightsContent(global)[key] !== false;
}

/**
 * 写光照子项会话显隐（仅 `contentVisibility.lights`，不入库）。
 * @returns 是否变更
 */
export function writeLightingVisibility(
    global: Global,
    key: LightingVisibilityKey,
    visible: boolean
): boolean {
    const node = ensureLightsContent(global);
    const next = !!visible;
    if (node[key] === next) {
        return false;
    }
    node[key] = next;
    return true;
}

/**
 * 将 brightness/bloom/shadow 三个子 flag 写成同一值（大类全局扫描，不作为之后的 override）。
 * @returns 是否有任一子项变更
 */
export function writeAllLightingVisibility(global: Global, visible: boolean): boolean {
    let changed = false;
    for (const key of Object.keys(DEFAULT_VIEW_LIGHTING_VISIBILITY) as LightingVisibilityKey[]) {
        if (writeLightingVisibility(global, key, visible)) {
            changed = true;
        }
    }
    return changed;
}

/**
 * 纯 Viewer 下某光照子项是否应对画面生效。
 * 编辑态（含预览）恒 true；跟子项自身 intent，大类勾选不做 override。
 */
export function isLightingSessionAspectVisible(global: Global, key: LightingVisibilityKey): boolean {
    if (global.state.editMode === true) {
        return true;
    }
    return readLightingVisibility(global, key);
}

/**
 * 会话态单灯 overlay（`contentVisibility.lights.instances`）。
 * 大类开：缺省显示，只记关；大类关：缺省隐藏，只记开。
 * 不套用 editMode：Resolver 在编辑态忽略 overlay。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {string} lightId - 用户点光/聚光 id
 * @returns {boolean} 会话是否允许该灯可见
 */
export function readSessionLightVisible(global: Global, lightId: string): boolean {
    return sessionOverlayShows(ensureLightsContent(global), lightId);
}

/**
 * 写会话态单灯 overlay。相对大类只存非默认：开大类时 `true` 删键，关大类时 `false` 删键。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {string} lightId - 用户点光/聚光 id
 * @param {boolean} visible - 会话可见
 * @returns {boolean} 是否变更
 */
export function writeSessionLightVisible(global: Global, lightId: string, visible: boolean): boolean {
    const node = ensureLightsContent(global);
    const next = !!visible;
    if (sessionOverlayShows(node, lightId) === next) {
        return false;
    }
    const isDefault = categoryLightsVisible(node) ? next : !next;
    if (isDefault) {
        deleteLightInstanceKey(node, lightId);
    } else {
        if (!node.instances) {
            node.instances = {};
        }
        node.instances[lightId] = next;
    }
    return true;
}

/**
 * 删除某灯 overlay 键（回到当前大类缺省），不按可见值改写。
 * 级联撤回用这个：大类已关时 `write(true)` 会变成强制开。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {string} lightId - 用户点光/聚光 id
 * @returns {boolean} 是否删掉了键
 */
export function deleteSessionLightVisible(global: Global, lightId: string): boolean {
    return deleteLightInstanceKey(ensureLightsContent(global), lightId);
}

/**
 * 批量写会话 overlay。相对大类只存非默认。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {string[]} lightIds - 用户灯 id
 * @param {boolean} visible - 会话可见
 * @returns {boolean} 是否有任一变更
 */
export function writeSessionLightVisibleMany(
    global: Global,
    lightIds: string[],
    visible: boolean
): boolean {
    let changed = false;
    for (const id of lightIds) {
        if (writeSessionLightVisible(global, id, visible)) {
            changed = true;
        }
    }
    return changed;
}

/** 已存储的非默认 overlay。未写过则为 `{}`。 */
export function readSessionLightVisibleOverlay(global: Global): Record<string, boolean> {
    const instances = ensureLightsContent(global).instances;
    return instances ? { ...instances } : {};
}

/**
 * 会话态单资产 overlay。大类开：缺省显示，只记关；大类关：缺省隐藏，只记开。
 */
export function readSessionAssetVisible(global: Global, assetId: string): boolean {
    return sessionAssetOverlayShows(ensureViewSettings(global), assetId);
}

/**
 * 写会话态单资产 overlay。相对大类只存非默认。
 *
 * @returns 是否变更
 */
export function writeSessionAssetVisible(global: Global, assetId: string, visible: boolean): boolean {
    const vs = ensureViewSettings(global);
    const next = !!visible;
    if (sessionAssetOverlayShows(vs, assetId) === next) {
        return false;
    }
    const isDefault = categoryAssetsVisible(vs) ? next : !next;
    if (isDefault) {
        deleteAssetInstanceKey(vs, assetId);
    } else {
        if (!vs.assetInstances) {
            vs.assetInstances = {};
        }
        vs.assetInstances[assetId] = next;
    }
    return true;
}

/**
 * 会话态单标注 overlay。大类开：缺省显示，只记关；大类关：缺省隐藏，只记开。
 */
export function readSessionAnnotationVisible(global: Global, annotationId: string): boolean {
    return sessionAnnotationOverlayShows(ensureViewSettings(global), annotationId);
}

/**
 * 写会话态单标注 overlay。相对大类只存非默认。
 *
 * @returns 是否变更
 */
export function writeSessionAnnotationVisible(global: Global, annotationId: string, visible: boolean): boolean {
    const vs = ensureViewSettings(global);
    const next = !!visible;
    if (sessionAnnotationOverlayShows(vs, annotationId) === next) {
        return false;
    }
    const isDefault = categoryAnnotationsVisible(vs) ? next : !next;
    if (isDefault) {
        deleteAnnotationInstanceKey(vs, annotationId);
    } else {
        if (!vs.annotationInstances) {
            vs.annotationInstances = {};
        }
        vs.annotationInstances[annotationId] = next;
    }
    return true;
}

/**
 * `TORCH_TOGGLE`：全局手电筒运行时开关（仅 viewSettings，不入库；初始恒为关）。
 * 入库需先 `TORCH_ADD` 写入 `settings.lighting.torch`。
 * 与 `applyViewMediaMuteSet` 保持相同返回与事件语义。
 * @returns 是否发生变更
 */
export function applyViewTorchActive(global: Global, active: boolean): boolean {
    const vs = ensureViewSettings(global);
    const next = !!active;
    if (!vs.torch) vs.torch = { active: next };
    if (vs.torch.active === next) return false;
    vs.torch.active = next;
    global.events.fire('torchActive:changed', { value: next });
    return true;
}

export function readViewTorchActive(global: Global): boolean {
    return ensureViewSettings(global).torch?.active === true;
}

/** 进入编辑 / 恢复快照时丢弃观看态特效 session */
export function clearViewEffectsSession(global: Global): void {
    delete global.viewSettings?.effectsSession;
}

/** 编辑写 `global.settings`；观看写 `viewSettings.effectsSession` */
export function getEffectsWriteTarget(global: Global): ExperienceSettings {
    if (global.state.editMode) {
        clearViewEffectsSession(global);
        return global.settings as ExperienceSettings;
    }
    const vs = ensureViewSettings(global);
    if (!vs.effectsSession) {
        vs.effectsSession = JSON.parse(JSON.stringify(global.settings)) as ExperienceSettings;
    }
    return vs.effectsSession;
}

/** 有 session 时读 session，否则读 settings */
export function getEffectsReadSource(global: Global): ExperienceSettings {
    const session = global.viewSettings?.effectsSession;
    if (!global.state.editMode && session) {
        return session;
    }
    return global.settings as ExperienceSettings;
}
