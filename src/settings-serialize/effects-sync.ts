/**
 * `settings.effects`、legacy `revealEffect` 与运行态 `effectsRuntimeState` 的同步（M16）。
 * **scene reveal 写入口真源**：`settings.effects.reveal`（`patchRevealSettingsFromParams` 等）；持久化 JSON 不写出 `revealEffect`。
 * **`revealEffect`**：旧 JSON 导入与读兼容；内存中由 `syncLegacyRevealEffectShadow` 与 `readRevealParams` 对齐。
 * **导出**：`flushRevealIntoEffectsForExport` 将遗留 `revealEffect` 刷入 `effects` 后，快照剔除 `revealEffect` 键。
 */
import type { ExperienceSettings } from '../schemas/v2';
import type { LegacyRevealEffect } from '../schemas/v2-custom';
import { DEFAULT_VFX_TOTAL_DURATION } from '../schemas/v2-custom';
import type { RevealEffectRuntimeStatus, PersistentEffectRuntimeStatus } from '../vfx/effects-runtime/effect-types';
import type { EffectsRuntimeState, PersistentEffectType, RevealEffectType, State } from '../types';
import {
    ASSET_EFFECT_TYPES,
    ASSET_GSPLAT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID,
    SCENE_GSPLAT_REVEAL_EFFECT_ID,
    defaultAssetEffectType,
    persistentEffectBucketForType,
    persistentEffectIdForBucket,
    type AssetEffectType
} from '../vfx/effects-runtime/effect-types';
import type { EffectsAssetInstance } from '../schemas/v2-custom';
import { hasRevealEffectFromSettings, isPersistentVfx } from '../vfx/effects-runtime/reveal/reveal-policy';
import { filterAssetEffectParams } from '../vfx/effects-runtime/asset/asset-effect-params';
import { DEFAULT_EFFECTS } from './settings-serialize-configs';
import { ensureRevealEffect } from './settings-serialize-helper';

function cloneDefaultEffects(): NonNullable<ExperienceSettings['effects']> {
    return JSON.parse(JSON.stringify(DEFAULT_EFFECTS)) as NonNullable<ExperienceSettings['effects']>;
}

type PersistentSubTrackName = 'camera' | 'stylization';

const PERSISTENT_SUBTRACK_IDS: Record<PersistentSubTrackName, string> = {
    camera: SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    stylization: SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID
};

function ensurePersistentSubTrack(
    persistent: NonNullable<ExperienceSettings['effects']>['persistent'],
    name: PersistentSubTrackName
): NonNullable<NonNullable<ExperienceSettings['effects']>['persistent'][PersistentSubTrackName]> {
    const id = PERSISTENT_SUBTRACK_IDS[name];
    if (!persistent[name] || typeof persistent[name] !== 'object') {
        persistent[name] = { activeEffectId: id, paramsById: {} };
    }
    const track = persistent[name]!;
    track.activeEffectId = id;
    if (!track.paramsById || typeof track.paramsById !== 'object') {
        track.paramsById = {};
    }
    return track;
}

function normalizePersistentPackShape(pack: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!pack) {
        return undefined;
    }
    if (typeof pack.type === 'string' && isPersistentVfx(pack.type)) {
        return pack;
    }
    for (const [effectType, rawParams] of Object.entries(pack)) {
        if (!isPersistentVfx(effectType) || !rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
            continue;
        }
        const params = { ...(rawParams as Record<string, unknown>) };
        const enabled = typeof params.enabled === 'boolean' ? params.enabled : true;
        const autoStart = typeof params.autoStart === 'boolean' ? params.autoStart : true;
        delete params.enabled;
        delete params.autoStart;
        return {
            type: effectType,
            enabled,
            autoStart,
            ...(Object.keys(params).length > 0 ? { effectParams: params } : {})
        };
    }
    return undefined;
}

function firstPersistentPackInMap(map: Record<string, Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
    if (!map || typeof map !== 'object') {
        return undefined;
    }
    for (const value of Object.values(map)) {
        const pack = normalizePersistentPackShape(value as Record<string, unknown> | undefined);
        if (pack) {
            return pack;
        }
    }
    return undefined;
}

function getPersistentPackForSubTrack(
    persistent: NonNullable<ExperienceSettings['effects']>['persistent'],
    name: PersistentSubTrackName
): Record<string, unknown> | undefined {
    const track = ensurePersistentSubTrack(persistent, name);
    const id = PERSISTENT_SUBTRACK_IDS[name];
    const byFixedId = normalizePersistentPackShape(track.paramsById[id] as Record<string, unknown> | undefined);
    if (byFixedId) {
        return byFixedId;
    }
    return firstPersistentPackInMap(track.paramsById);
}

function getLegacyPersistentPack(
    persistent: NonNullable<ExperienceSettings['effects']>['persistent']
): Record<string, unknown> | undefined {
    const id = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    const byFixedId = normalizePersistentPackShape(persistent.paramsById[id] as Record<string, unknown> | undefined);
    if (byFixedId) {
        return byFixedId;
    }
    return firstPersistentPackInMap(persistent.paramsById);
}

export function readPersistentSettingsPack(settings: ExperienceSettings): Record<string, unknown> | undefined {
    const e = ensureEffectsSettings(settings);
    const pe = e.persistent;
    const packs = [
        getPersistentPackForSubTrack(pe, 'camera'),
        getPersistentPackForSubTrack(pe, 'stylization'),
        getLegacyPersistentPack(pe)
    ];
    return packs.find(pack => parsePersistentPack(pack) !== null) ?? packs.find(pack => pack !== undefined);
}

/** 保证 `settings.effects` 三轨对象存在且字段形状合法 */
export function ensureEffectsSettings(settings: ExperienceSettings): NonNullable<ExperienceSettings['effects']> {
    if (!settings.effects || typeof settings.effects !== 'object') {
        (settings as Record<string, unknown>).effects = cloneDefaultEffects();
    }
    const e = settings.effects!;
    if (!e.reveal || typeof e.reveal !== 'object') {
        e.reveal = { activeEffectId: SCENE_GSPLAT_REVEAL_EFFECT_ID, paramsById: {} };
    }
    e.reveal.activeEffectId = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    if (!e.reveal.paramsById || typeof e.reveal.paramsById !== 'object') {
        e.reveal.paramsById = {};
    }
    if (!e.persistent || typeof e.persistent !== 'object') {
        e.persistent = { activeEffectId: SCENE_GSPLAT_PERSISTENT_EFFECT_ID, enabled: false, paramsById: {} };
    }
    e.persistent.activeEffectId = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    if (!e.persistent.paramsById || typeof e.persistent.paramsById !== 'object') {
        e.persistent.paramsById = {};
    }
    const cameraTrack = ensurePersistentSubTrack(e.persistent, 'camera');
    const stylizationTrack = ensurePersistentSubTrack(e.persistent, 'stylization');
    const legacyPack = getLegacyPersistentPack(e.persistent);
    if (legacyPack && typeof legacyPack.type === 'string') {
        const bucket = persistentEffectBucketForType(legacyPack.type);
        const track = bucket === 'camera' ? cameraTrack : stylizationTrack;
        const id = persistentEffectIdForBucket(bucket);
        if (!getPersistentPackForSubTrack(e.persistent, bucket)) {
            const parsedLegacy = parsePersistentPack(legacyPack);
            if (parsedLegacy) {
                track.paramsById[id] = persistentToParamRecord(parsedLegacy, legacyPack.enabled !== false);
            }
        }
    }
    // `enabled` 缺省时：若 scene 包已写可持续类型，默认视为开（与 editUI `enabled ?? true` 一致）；否则为关。
    // 须在 paramsById 归一化之后推断，否则导入仅写 `paramsById` 的 JSON 会在 mirror 时被误判为关并清空 persistent。
    if (typeof e.persistent.enabled !== 'boolean') {
        const p =
            getPersistentPackForSubTrack(e.persistent, 'camera') ??
            getPersistentPackForSubTrack(e.persistent, 'stylization') ??
            getLegacyPersistentPack(e.persistent);
        const parsed = parsePersistentPack(p);
        e.persistent.enabled = !!(parsed?.type && isPersistentVfx(parsed.type));
    }
    if (!e.asset || typeof e.asset !== 'object') {
        e.asset = { activeEffectId: ASSET_GSPLAT_EFFECT_ID, instancesByTargetId: {} };
    }
    e.asset.activeEffectId = ASSET_GSPLAT_EFFECT_ID;
    if (!e.asset.instancesByTargetId || typeof e.asset.instancesByTargetId !== 'object') {
        e.asset.instancesByTargetId = {};
    }
    return e;
}

function parseAssetInstanceType(raw: Record<string, unknown>): AssetEffectType | null {
    const t = typeof raw.type === 'string' ? raw.type : typeof raw.effectId === 'string' ? raw.effectId : null;
    if (t && ASSET_EFFECT_TYPES.has(t)) {
        return t as AssetEffectType;
    }
    return null;
}

function readMorphKeyframeIdsFromParams(params: Record<string, unknown> | undefined): string[] | null {
    const ids = params?.keyframeEntityIds ?? params?.keyframeTargetIds;
    if (!Array.isArray(ids) || ids.length < 2 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
        return null;
    }
    return ids as string[];
}

export function resolveAssetInstanceStorageTargetId(
    targetId: string,
    instance: Pick<EffectsAssetInstance, 'type' | 'effectParams'> | null | undefined
): string {
    if (instance?.type !== 'gsplat-morph') {
        return targetId;
    }
    const ids = readMorphKeyframeIdsFromParams(instance.effectParams as Record<string, unknown> | undefined);
    return ids?.[0] ?? targetId;
}

export function findAssetMorphOwnerTargetId(settings: ExperienceSettings, targetId: string): string | null {
    const map = ensureEffectsSettings(settings).asset.instancesByTargetId ?? {};
    for (const [ownerId, inst] of Object.entries(map)) {
        if (inst.type !== 'gsplat-morph') {
            continue;
        }
        const ids = readMorphKeyframeIdsFromParams(inst.effectParams as Record<string, unknown> | undefined);
        if (ids?.includes(targetId)) {
            return ownerId;
        }
    }
    return null;
}

function sameMorphKeyframeSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const set = new Set(a);
    if (set.size !== a.length) {
        return false;
    }
    return b.every((id) => set.has(id));
}

function pruneDuplicateMorphAssetInstances(
    map: Record<string, EffectsAssetInstance>,
    ownerTargetId: string,
    ownerKeyframeIds: string[]
): void {
    for (const [targetId, inst] of Object.entries(map)) {
        if (targetId === ownerTargetId || inst.type !== 'gsplat-morph') {
            continue;
        }
        const ids = readMorphKeyframeIdsFromParams(inst.effectParams as Record<string, unknown> | undefined);
        if (ids && sameMorphKeyframeSet(ids, ownerKeyframeIds)) {
            delete map[targetId];
        }
    }
}

function parseAssetDefaultPack(pack: Record<string, unknown> | undefined): EffectsAssetInstance | null {
    if (!pack) {
        return null;
    }
    const type = parseAssetInstanceType(pack);
    if (!type) {
        return null;
    }
    const out: EffectsAssetInstance = {
        type,
        autoStart: typeof pack.autoStart === 'boolean' ? pack.autoStart : false
    };
    if (typeof pack.enabled === 'boolean') {
        out.enabled = pack.enabled;
    }
    if (pack.effectParams && typeof pack.effectParams === 'object' && !Array.isArray(pack.effectParams)) {
        const ep = { ...(pack.effectParams as Record<string, unknown>) };
        if (Object.keys(ep).length > 0) {
            out.effectParams = ep;
        }
    }
    return out;
}

/** 读取物体轨包默认参（`defaultParamsById[asset.gsplat-effects]`） */
export function readAssetDefaultParams(settings: ExperienceSettings): EffectsAssetInstance | null {
    const e = ensureEffectsSettings(settings);
    const pack = e.asset.defaultParamsById?.[ASSET_GSPLAT_EFFECT_ID] as Record<string, unknown> | undefined;
    return parseAssetDefaultPack(pack);
}

/** 读取某 `sceneAsset.id` 上的物体特效实例配置 */
export function readAssetInstanceParams(
    settings: ExperienceSettings,
    targetId: string
): EffectsAssetInstance | null {
    const e = ensureEffectsSettings(settings);
    const inst = e.asset.instancesByTargetId![targetId];
    if (!inst || typeof inst !== 'object') {
        return null;
    }
    const raw = inst as Record<string, unknown>;
    const resolvedType = parseAssetInstanceType(raw) ?? defaultAssetEffectType();
    const out: EffectsAssetInstance = { type: resolvedType };
    if (typeof inst.enabled === 'boolean') {
        out.enabled = inst.enabled;
    }
    if (typeof inst.autoStart === 'boolean') {
        out.autoStart = inst.autoStart;
    }
    if (inst.effectParams !== undefined && typeof inst.effectParams === 'object' && !Array.isArray(inst.effectParams)) {
        out.effectParams = { ...(inst.effectParams as Record<string, unknown>) };
    }
    return out;
}

/** 写入 `settings.effects.asset.instancesByTargetId[targetId]` */
export function patchAssetInstanceFromParams(
    settings: ExperienceSettings,
    targetId: string,
    patch: {
        type?: string;
        /** @deprecated 导入兼容 */
        effectId?: string;
        enabled?: boolean;
        autoStart?: boolean;
        effectParams?: Record<string, unknown> | null;
    }
): EffectsAssetInstance {
    const e = ensureEffectsSettings(settings);
    const map = e.asset.instancesByTargetId!;
    const current = readAssetInstanceParams(settings, targetId);
    const patchTypeRaw = patch.type ?? patch.effectId;
    const oldType = current?.type ?? defaultAssetEffectType();
    const nextType = (
        typeof patchTypeRaw === 'string' && ASSET_EFFECT_TYPES.has(patchTypeRaw) ?
            (patchTypeRaw as AssetEffectType) :
            oldType
    ) as AssetEffectType;
    const typeIsChanging = typeof patchTypeRaw === 'string' && patchTypeRaw !== oldType;

    let nextEffectParams: Record<string, unknown> =
        current?.effectParams && typeof current.effectParams === 'object' && !Array.isArray(current.effectParams)
            ? { ...(current.effectParams as Record<string, unknown>) }
            : {};

    if (typeIsChanging && patch.effectParams === undefined) {
        nextEffectParams = {};
    }

    const defaults = readAssetDefaultParams(settings);
    const defaultEp =
        defaults?.type === nextType &&
        defaults.effectParams &&
        typeof defaults.effectParams === 'object' &&
        !Array.isArray(defaults.effectParams) ?
            (defaults.effectParams as Record<string, unknown>) :
            {};
    if (!current && Object.keys(nextEffectParams).length === 0 && Object.keys(defaultEp).length > 0) {
        nextEffectParams = { ...defaultEp };
    }

    if (patch.effectParams !== undefined) {
        if (patch.effectParams === null) {
            nextEffectParams = {};
        } else if (typeof patch.effectParams === 'object' && !Array.isArray(patch.effectParams)) {
            const incoming = filterAssetEffectParams(nextType, patch.effectParams as Record<string, unknown>);
            if (typeIsChanging) {
                nextEffectParams = { ...incoming };
            } else {
                nextEffectParams = { ...nextEffectParams, ...incoming };
            }
        }
    }
    nextEffectParams = filterAssetEffectParams(nextType, nextEffectParams);

    const next: EffectsAssetInstance = {
        type: nextType,
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : (current?.enabled ?? true),
        autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : (current?.autoStart ?? false),
        ...(Object.keys(nextEffectParams).length > 0 ? { effectParams: nextEffectParams } : {})
    };
    const morphKeyframeIds = nextType === 'gsplat-morph' ? readMorphKeyframeIdsFromParams(nextEffectParams) : null;
    const ownerTargetId = morphKeyframeIds?.[0] ?? targetId;
    if (ownerTargetId !== targetId) {
        delete map[targetId];
    }
    map[ownerTargetId] = next;
    if (morphKeyframeIds) {
        pruneDuplicateMorphAssetInstances(map, ownerTargetId, morphKeyframeIds);
    }
    return next;
}

/** 更新 `state.effectsRuntimeState.asset.instances[targetId]` */
export function patchAssetRuntimeMirror(
    state: State,
    targetId: string,
    patch: Partial<{
        activeType: AssetEffectType;
        status: import('../vfx/effects-runtime/effect-types').AssetEffectRuntimeStatus;
    }>
): void {
    if (!state.effectsRuntimeState) {
        state.effectsRuntimeState = createDefaultEffectsRuntimeState();
    }
    const asset = state.effectsRuntimeState.asset;
    const prev = asset.instances[targetId];
    asset.instances[targetId] = {
        activeType: patch.activeType ?? prev?.activeType ?? defaultAssetEffectType(),
        status: patch.status ?? prev?.status ?? 'inactive'
    };
}

/** 从 settings 实例表同步 asset 运行态（不触发播放） */
export function syncAssetInstancesRuntimeFromSettings(state: State, settings: ExperienceSettings): void {
    if (!state.effectsRuntimeState) {
        state.effectsRuntimeState = createDefaultEffectsRuntimeState();
    }
    const map = ensureEffectsSettings(settings).asset.instancesByTargetId ?? {};
    const runtime = state.effectsRuntimeState.asset.instances;
    for (const targetId of Object.keys(runtime)) {
        if (!map[targetId]) {
            delete runtime[targetId];
        }
    }
    for (const [targetId, inst] of Object.entries(map)) {
        const enabled = inst.enabled !== false;
        const prev = runtime[targetId];
        const raw = inst as Record<string, unknown>;
        const activeType = parseAssetInstanceType(raw) ?? defaultAssetEffectType();
        runtime[targetId] = {
            activeType,
            status: enabled ? (prev?.status === 'playing' ? 'playing' : 'inactive') : 'inactive'
        };
    }
}

function revealToParamRecord(rev: LegacyRevealEffect): Record<string, unknown> {
    const out: Record<string, unknown> = {
        type: rev.type,
        autoStart: rev.autoStart,
        totalDuration: rev.totalDuration
    };
    if (rev.effectParams && typeof rev.effectParams === 'object' && !Array.isArray(rev.effectParams)) {
        const ep = { ...rev.effectParams };
        if (Object.keys(ep).length > 0) {
            out.effectParams = ep;
        }
    }
    return out;
}

/** persistent 子槽存盘包：固定包 id 下按 effect type 分组，参数扁平写入具体 effect 节点。 */
function persistentToParamRecord(rev: LegacyRevealEffect, enabled = true): Record<string, unknown> {
    const type = rev.type;
    if (!type || !isPersistentVfx(type)) {
        return {};
    }
    const params: Record<string, unknown> = { enabled };
    if (rev.autoStart === false) {
        params.autoStart = false;
    }
    if (rev.effectParams && typeof rev.effectParams === 'object' && !Array.isArray(rev.effectParams)) {
        const ep = { ...rev.effectParams };
        if (Object.keys(ep).length > 0) {
            Object.assign(params, ep);
        }
    }
    return { [type]: params };
}

function parseRevealPack(pack: Record<string, unknown> | undefined): LegacyRevealEffect | null {
    if (!pack || typeof pack.type !== 'string') {
        return null;
    }
    const base: LegacyRevealEffect = {
        type: pack.type as LegacyRevealEffect['type'],
        autoStart: typeof pack.autoStart === 'boolean' ? pack.autoStart : true,
        totalDuration: typeof pack.totalDuration === 'number' ? pack.totalDuration : DEFAULT_VFX_TOTAL_DURATION
    };
    if (pack.effectParams && typeof pack.effectParams === 'object' && !Array.isArray(pack.effectParams)) {
        const ep = { ...(pack.effectParams as Record<string, unknown>) };
        if (Object.keys(ep).length > 0) {
            base.effectParams = ep;
        }
    }
    return base;
}

/** 解析 persistent 轨存盘包；兼容新 nested 包与旧 `{ type, effectParams }` 包，忽略 `totalDuration`。 */
function parsePersistentPack(pack: Record<string, unknown> | undefined): LegacyRevealEffect | null {
    const normalized = normalizePersistentPackShape(pack);
    if (!normalized || typeof normalized.type !== 'string') {
        return null;
    }
    if (normalized.enabled === false) {
        return null;
    }
    const base: LegacyRevealEffect = {
        type: normalized.type as LegacyRevealEffect['type'],
        autoStart: typeof normalized.autoStart === 'boolean' ? normalized.autoStart : true
    };
    if (normalized.effectParams && typeof normalized.effectParams === 'object' && !Array.isArray(normalized.effectParams)) {
        const ep = { ...(normalized.effectParams as Record<string, unknown>) };
        if (Object.keys(ep).length > 0) {
            base.effectParams = ep;
        }
    }
    return base;
}

export function setPersistentSettingsEnabled(settings: ExperienceSettings, enabled: boolean): void {
    const e = ensureEffectsSettings(settings);
    e.persistent.enabled = enabled;
    const current = readPersistentSettingsPack(settings);
    if (!current || typeof current.type !== 'string' || !isPersistentVfx(current.type)) {
        return;
    }
    const bucket = persistentEffectBucketForType(current.type);
    const id = persistentEffectIdForBucket(bucket);
    const currentParams =
        current.effectParams && typeof current.effectParams === 'object' && !Array.isArray(current.effectParams)
            ? { ...(current.effectParams as Record<string, unknown>) }
            : {};
    ensurePersistentSubTrack(e.persistent, bucket).paramsById[id] = persistentToParamRecord(
        {
            type: current.type as LegacyRevealEffect['type'],
            autoStart: typeof current.autoStart === 'boolean' ? current.autoStart : true,
            ...(Object.keys(currentParams).length > 0 ? { effectParams: currentParams } : {})
        },
        enabled
    );
    e.persistent.paramsById[SCENE_GSPLAT_PERSISTENT_EFFECT_ID] = {};
}

/** scene reveal 参数：优先读 `settings.effects.reveal`，其次读 legacy `revealEffect`。 */
export function readRevealParams(settings: ExperienceSettings): LegacyRevealEffect | null {
    ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    const pack = settings.effects!.reveal.paramsById[id] as Record<string, unknown> | undefined;
    const fromEffects = parseRevealPack(pack);
    if (fromEffects) {
        return fromEffects;
    }
    return settings.revealEffect ?? null;
}

/** scene reveal 总时长：优先 effects.reveal，回退 legacy revealEffect，再回退默认值。 */
export function getRevealTotalDuration(settings: ExperienceSettings): number {
    const reveal = readRevealParams(settings);
    return typeof reveal?.totalDuration === 'number' ? reveal.totalDuration : DEFAULT_VFX_TOTAL_DURATION;
}

/** `effects.persistent` 视为开（`enabled !== false`）且含合法可持续 `type` */
function persistentRevealInEffects(settings: ExperienceSettings): boolean {
    ensureEffectsSettings(settings);
    const pe = settings.effects!.persistent;
    if (pe.enabled === false) return false;
    const pack = readPersistentSettingsPack(settings);
    const parsed = parsePersistentPack(pack);
    return !!(parsed?.type && isPersistentVfx(parsed.type));
}

/** `revealEffect` 或 persistent 轨任一表示存在 scene reveal 配置 */
export function hasRevealInSettings(settings: ExperienceSettings): boolean {
    return hasRevealEffectFromSettings(readRevealParams(settings)) || persistentRevealInEffects(settings);
}

/** 可持续 scene GSplat 参数：优先读 `effects.persistent`，再回退 legacy 单轨 `revealEffect`。 */
export function readPersistentRevealParams(settings: ExperienceSettings): LegacyRevealEffect | null {
    ensureEffectsSettings(settings);
    const pe = settings.effects!.persistent;
    if (pe.enabled !== false) {
        const pack = readPersistentSettingsPack(settings);
        const parsed = parsePersistentPack(pack);
        if (parsed && typeof parsed.type === 'string' && isPersistentVfx(parsed.type)) {
            return parsed;
        }
    }

    const rev = settings.revealEffect;
    const rt = rev?.type ?? 'none';
    if (rev && isPersistentVfx(rt)) {
        const base: LegacyRevealEffect = {
            type: rev.type as LegacyRevealEffect['type'],
            autoStart: typeof rev.autoStart === 'boolean' ? rev.autoStart : true
        };
        if (rev.effectParams && typeof rev.effectParams === 'object' && !Array.isArray(rev.effectParams)) {
            const ep = { ...(rev.effectParams as Record<string, unknown>) };
            if (Object.keys(ep).length > 0) {
                base.effectParams = ep;
            }
        }
        return base;
    }
    return null;
}

/**
 * 将 `readRevealParams(settings)`（effects 优先）写回 legacy `revealEffect`，供仍读该字段的路径与旧逻辑对齐（M16）。
 * 不替代 `settings.effects` 真源；在每次写入 `effects.reveal` 或 `mirrorEffectsSettingsFromReveal` 后调用。
 */
export function syncLegacyRevealEffectShadow(settings: ExperienceSettings): void {
    const merged = readRevealParams(settings);
    if (!merged) {
        return;
    }
    const rev = ensureRevealEffect(settings);
    rev.type = merged.type;
    delete (rev as Record<string, unknown>).radius;
    rev.autoStart = merged.autoStart;
    rev.totalDuration = merged.totalDuration;
    const r = rev as Record<string, unknown>;
    if (merged.effectParams && typeof merged.effectParams === 'object' && !Array.isArray(merged.effectParams)) {
        r.effectParams = { ...merged.effectParams };
    } else {
        delete r.effectParams;
    }
}

/** 写入 `settings.effects.reveal`（scene reveal 唯一写源）；随后 `syncLegacyRevealEffectShadow` 对齐 legacy 字段。 */
export function patchRevealSettingsFromParams(
    settings: ExperienceSettings,
    patch: Partial<LegacyRevealEffect>
): LegacyRevealEffect {
    const e = ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    const current = readRevealParams(settings);
    const oldType = (current?.type ?? 'none') as string;
    const nextType = (typeof patch.type === 'string' ? patch.type : oldType) as LegacyRevealEffect['type'];
    const typeIsChanging = typeof patch.type === 'string' && patch.type !== oldType;

    let nextEffectParams: Record<string, unknown> =
        current?.effectParams && typeof current.effectParams === 'object' && !Array.isArray(current.effectParams)
            ? { ...(current.effectParams as Record<string, unknown>) }
            : {};

    if (typeIsChanging && patch.effectParams === undefined) {
        nextEffectParams = {};
    }
    if (patch.effectParams !== undefined) {
        if (patch.effectParams === null) {
            nextEffectParams = {};
        } else if (typeof patch.effectParams === 'object' && !Array.isArray(patch.effectParams)) {
            const incoming = patch.effectParams as Record<string, unknown>;
            if (Object.keys(incoming).length === 0) {
                nextEffectParams = {};
            } else if (typeIsChanging && typeof patch.type === 'string') {
                nextEffectParams = { ...incoming };
            } else {
                nextEffectParams = { ...nextEffectParams, ...incoming };
            }
        }
    }

    const next: LegacyRevealEffect = {
        type: nextType,
        autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : (current?.autoStart ?? true),
        totalDuration:
            typeof patch.totalDuration === 'number' &&
            !Number.isNaN(patch.totalDuration) &&
            patch.totalDuration > 0
                ? patch.totalDuration
                : (current?.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION),
        ...(Object.keys(nextEffectParams).length > 0 ? { effectParams: nextEffectParams } : {})
    };
    e.reveal.paramsById[id] = { ...revealToParamRecord(next) };
    syncLegacyRevealEffectShadow(settings);

    return next;
}

/**
 * 写入 `settings.effects.persistent.paramsById['scene.gsplat-persistent']`（**仅** `type` / `autoStart` / `effectParams`，**无** `totalDuration`）。
 * **`effectParams` 合并语义**与 {@link patchRevealSettingsFromParams} 一致（切 `type` 未带 `effectParams` 时清空专参等）。
 */
export function patchPersistentSettingsFromParams(
    settings: ExperienceSettings,
    patch: Partial<LegacyRevealEffect>
): LegacyRevealEffect {
    const e = ensureEffectsSettings(settings);
    const rawPack = readPersistentSettingsPack(settings);
    const parsedCurrent = parsePersistentPack(rawPack);
    const current: LegacyRevealEffect =
        parsedCurrent ??
        ({
            type: 'none',
            autoStart: true
        } as LegacyRevealEffect);

    const oldType = (current.type ?? 'none') as string;
    const nextType = (typeof patch.type === 'string' ? patch.type : oldType) as LegacyRevealEffect['type'];
    const typeIsChanging = typeof patch.type === 'string' && patch.type !== oldType;

    let nextEffectParams: Record<string, unknown> =
        current.effectParams && typeof current.effectParams === 'object' && !Array.isArray(current.effectParams)
            ? { ...(current.effectParams as Record<string, unknown>) }
            : {};

    if (typeIsChanging && patch.effectParams === undefined) {
        nextEffectParams = {};
    }
    if (patch.effectParams !== undefined) {
        if (patch.effectParams === null) {
            nextEffectParams = {};
        } else if (typeof patch.effectParams === 'object' && !Array.isArray(patch.effectParams)) {
            const incoming = patch.effectParams as Record<string, unknown>;
            if (Object.keys(incoming).length === 0) {
                nextEffectParams = {};
            } else if (typeIsChanging && typeof patch.type === 'string') {
                nextEffectParams = { ...incoming };
            } else {
                nextEffectParams = { ...nextEffectParams, ...incoming };
            }
        }
    }

    const next: LegacyRevealEffect = {
        type: nextType,
        autoStart: typeof patch.autoStart === 'boolean' ? patch.autoStart : (current.autoStart ?? true),
        ...(Object.keys(nextEffectParams).length > 0 ? { effectParams: nextEffectParams } : {})
    };
    const oldBucket = persistentEffectBucketForType(oldType);
    const nextBucket = persistentEffectBucketForType(nextType as string);
    const nextId = persistentEffectIdForBucket(nextBucket);
    if (oldBucket !== nextBucket) {
        const oldId = persistentEffectIdForBucket(oldBucket);
        ensurePersistentSubTrack(e.persistent, oldBucket).paramsById[oldId] = {};
    }
    ensurePersistentSubTrack(e.persistent, nextBucket).paramsById[nextId] = { ...persistentToParamRecord(next) };
    e.persistent.paramsById[SCENE_GSPLAT_PERSISTENT_EFFECT_ID] = {};
    return next;
}

/** reveal 播完后再挂 persistent（双轨配置） */
export function shouldDeferPersistentMount(settings: ExperienceSettings): boolean {
    const revealType = (readRevealParams(settings)?.type ?? 'none') as string;
    if (revealType === 'none' || isPersistentVfx(revealType)) {
        return false;
    }
    return readPersistentRevealParams(settings) !== null;
}

/** 从单轨 persistent 切到 reveal 等时，清空 `effects.persistent` 中 scene 包，避免 mirror 误判双轨并存 */
export function clearPersistentRevealTrack(settings: ExperienceSettings): void {
    const e = ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    e.persistent.enabled = false;
    e.persistent.paramsById[id] = {};
    e.persistent.camera!.paramsById[SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID] = {};
    e.persistent.stylization!.paramsById[SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID] = {};
}

/**
 * 导出前调用：若仍存在内存里的 `revealEffect`，先镜像进 `effects`，保证 JSON 以 **`effects` 为唯一 scene reveal 真源**。
 * 调用方随后应从快照对象上 **删除 `revealEffect` 键**（不再写入 settings.json）。
 */
export function flushRevealIntoEffectsForExport(settings: ExperienceSettings): void {
    if (settings.revealEffect != null) {
        mirrorEffectsSettingsFromReveal(settings);
    }
    const effects = ensureEffectsSettings(settings);
    delete effects.persistent.activeEffectId;
    delete effects.persistent.enabled;
    delete effects.persistent.paramsById;
}

/**
 * 以 `settings.revealEffect` 为 **reveal** 真源写入 `effects.reveal`；`effects.persistent` 在以下情况保留/写入：
 * - 旧单轨：`revealEffect.type` 为 persistent → 仅写 persistent；
 * - 双轨：`revealEffect` 为 reveal 且 `effects.persistent` 已启用且 `paramsById` 为可持续类型 → **不清除** persistent，实现「播完 reveal 再挂 persistent」的存盘结构。
 */
export function mirrorEffectsSettingsFromReveal(settings: ExperienceSettings): void {
    const rev = ensureRevealEffect(settings);
    const e = ensureEffectsSettings(settings);
    const revealId = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    const persistentId = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    const t = rev.type ?? 'none';

    if (!isPersistentVfx(t)) {
        e.reveal.paramsById[revealId] = { ...revealToParamRecord(rev) };
    } else {
        e.reveal.paramsById[revealId] = {
            type: 'none',
            autoStart: typeof rev.autoStart === 'boolean' ? rev.autoStart : true,
            totalDuration: typeof rev.totalDuration === 'number' ? rev.totalDuration : DEFAULT_VFX_TOTAL_DURATION
        };
    }

    if (isPersistentVfx(t)) {
        const bucket = persistentEffectBucketForType(t);
        const id = persistentEffectIdForBucket(bucket);
        e.persistent.enabled = true;
        ensurePersistentSubTrack(e.persistent, bucket).paramsById[id] = { ...persistentToParamRecord(rev) };
        e.persistent.paramsById[persistentId] = {};
        syncLegacyRevealEffectShadow(settings);
        return;
    }

    const pe = e.persistent;
    const existingPersistentPack = readPersistentSettingsPack(settings);
    const existingPersistentType = parsePersistentPack(existingPersistentPack)?.type as string | undefined;
    const preservePersistentWithReveal =
        pe.enabled !== false &&
        existingPersistentType !== undefined &&
        isPersistentVfx(existingPersistentType) &&
        !isPersistentVfx(t);

    if (preservePersistentWithReveal) {
        syncLegacyRevealEffectShadow(settings);
        return;
    }

    pe.enabled = false;
    pe.paramsById[persistentId] = {};
    pe.camera!.paramsById[SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID] = {};
    pe.stylization!.paramsById[SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID] = {};
    syncLegacyRevealEffectShadow(settings);
}

function applyRevealParams(settings: ExperienceSettings): void {
    syncLegacyRevealEffectShadow(settings);
}

/**
 * 导入/恢复快照后：在 `revealEffect` 与 `effects` 之间做一次归一化。
 * - 若 reveal 包与 revealEffect 的 `type` 冲突，以 **effects.reveal** 为准（新真源）。
 * - 否则以 `revealEffect` 为准并回写 reveal/persistent 镜像（**导入读兼容**；导出仅写 `effects`，见 `flushRevealIntoEffectsForExport`）。
 */
export function normalizeEffectsOnImport(settings: ExperienceSettings): void {
    ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    const pack = settings.effects!.reveal.paramsById[id] as Record<string, unknown> | undefined;
    const hasEffectsType = !!(pack && typeof pack.type === 'string');
    ensureRevealEffect(settings);
    const rev = settings.revealEffect!;
    const hasRevealType = typeof rev.type === 'string';

    if (hasEffectsType && hasRevealType && String(pack!.type) !== String(rev.type)) {
        applyRevealParams(settings);
    } else if (hasEffectsType && !hasRevealType) {
        applyRevealParams(settings);
    }
    mirrorEffectsSettingsFromReveal(settings);
}

/**
 * 写入 reveal 运行态真源。
 * reveal **不支持** pause；暂停仅见 `patchPersistentRuntimeMirror`。
 */
export function patchRevealRuntimeMirror(
    state: State,
    patch: Partial<{
        activeType: RevealEffectType;
        status: RevealEffectRuntimeStatus;
    }>
): void {
    const ers = state.effectsRuntimeState;
    if (!ers) {
        return;
    }
    const reveal = ers.reveal;
    if (patch.activeType !== undefined) {
        reveal.activeType = patch.activeType;
    }
    if (patch.status !== undefined) {
        reveal.status = patch.status;
    }
}

/**
 * 更新 persistent 轨 `status`（仅 `playing` / `paused`），
 * 作为可持续轨暂停唯一真源。
 */
export function patchPersistentRuntimeMirror(state: State, patch: { status?: PersistentEffectRuntimeStatus }): void {
    const ers = state.effectsRuntimeState;
    if (!ers || patch.status === undefined) {
        return;
    }
    ers.persistent.status = patch.status;
}

export function getRevealActiveType(state: State): RevealEffectType {
    const t = state.effectsRuntimeState?.reveal?.activeType;
    if (t !== undefined && t !== null) {
        return t;
    }
    return 'none';
}

export function getRevealStatus(state: State): RevealEffectRuntimeStatus {
    const reveal = state.effectsRuntimeState?.reveal;
    if (reveal && typeof reveal.status === 'string') {
        return reveal.status;
    }
    return 'inactive';
}

/** persistent 且 `status === 'paused'` */
export function getPersistentEffectPaused(state: State): boolean {
    const p = state.effectsRuntimeState?.persistent;
    return p?.status === 'paused';
}

export function createDefaultEffectsRuntimeState(): EffectsRuntimeState {
    return {
        reveal: {
            activeEffectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
            status: 'inactive',
            activeType: 'none'
        },
        persistent: { activeEffectId: SCENE_GSPLAT_PERSISTENT_EFFECT_ID, status: 'inactive' },
        asset: { activeEffectId: ASSET_GSPLAT_EFFECT_ID, instances: {} }
    };
}

/**
 * 从持久化 settings 推导运行态 `effectsRuntimeState`。
 * `reveal.activeType` 始终由 `readRevealParams(settings)` 推导；`reveal.status` 在 `playing`/`completed` 等与播放生命周期相关的语义上保留与 `patchRevealRuntimeMirror` 的配合（见 RevealController / 协议停播）。
 * 对经 `observe()` 代理的 `state`（`core/observe.ts`）：`effectsRuntimeState` 必须已在初始 target 的 key 集合内（见 `index.ts`），否则无法新增顶层属性。
 */
export function syncEffectsRuntimeStateFromSettings(state: State, settings: ExperienceSettings): void {
    if (!state.effectsRuntimeState) {
        state.effectsRuntimeState = createDefaultEffectsRuntimeState();
    }
    const revealType = (readRevealParams(settings)?.type ?? 'none') as RevealEffectType;
    const persistentReveal = readPersistentRevealParams(settings);
    const persistentActive =
        persistentReveal != null &&
        (isPersistentVfx(revealType) || settings.effects!.persistent.enabled !== false);
    const reveal = state.effectsRuntimeState.reveal;
    const prevRevealStatus = reveal.status;
    reveal.activeEffectId = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    reveal.activeType = revealType;
    if (prevRevealStatus === 'playing') {
        reveal.status = 'playing';
    } else if (revealType === 'none') {
        reveal.status = 'inactive';
    } else if (prevRevealStatus === 'completed') {
        // 已由本轮 reveal 播完写镜；不要用「仅配置存在」误标为 completed（冷导入会漏挂 deferred persistent）
        reveal.status = 'completed';
    } else {
        reveal.status = 'inactive';
    }

    const persistent = state.effectsRuntimeState.persistent;
    persistent.activeEffectId = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    if (!persistentActive) {
        persistent.activeType = undefined;
        persistent.status = 'inactive';
    } else {
        persistent.activeType = persistentReveal?.type as PersistentEffectType;
        persistent.status = 'playing';
    }

    state.effectsRuntimeState.asset.activeEffectId = ASSET_GSPLAT_EFFECT_ID;
    syncAssetInstancesRuntimeFromSettings(state, settings);
}
