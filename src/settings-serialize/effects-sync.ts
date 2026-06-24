/**
 * `settings.effects`、legacy `revealEffect` 与运行态 `effectsRuntimeState` 的同步（M16）。
 * **scene reveal 写入口真源**：`settings.effects.reveal`（`patchRevealSettingsFromParams` 等）；持久化 JSON 不写出 `revealEffect`。
 * **`revealEffect`**：旧 JSON 导入与读兼容；内存中由 `syncLegacyRevealEffectShadow` 与 `readRevealParams` 对齐。
 * **导出**：`flushRevealIntoEffectsForExport` 将遗留 `revealEffect` 刷入 `effects` 后，快照剔除 `revealEffect` 键。
 */
import type { ExperienceSettings } from '../schemas/v2';
import type { EffectsAssetInstance, LegacyRevealEffect, PersistentSceneEffectEntry } from '../schemas/v2-custom';
import { DEFAULT_VFX_TOTAL_DURATION } from '../schemas/v2-custom';
import type { RevealEffectRuntimeStatus, PersistentEffectRuntimeStatus } from '../vfx/effects-runtime/effect-types';
import type { EffectsRuntimeState, PersistentEffectType, RevealEffectType, State } from '../types';
import {
    ASSET_EFFECT_TYPES,
    ASSET_GSPLAT_EFFECT_ID,
    PERSISTENT_EFFECT_TYPES,
    REVEAL_EFFECT_TYPES,
    SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID,
    SCENE_GSPLAT_REVEAL_EFFECT_ID,
    defaultAssetEffectType,
    persistentEffectBucketForType,
    persistentEffectIdForBucket,
    type AssetEffectType
} from '../vfx/effects-runtime/effect-types';
import { hasRevealEffectFromSettings, isPersistentVfx, isRevealEffectActiveInScene } from '../vfx/effects-runtime/reveal/reveal-policy';
import { filterAssetEffectParams } from '../vfx/effects-runtime/asset/asset-effect-params';
import { DEFAULT_EFFECTS } from './settings-serialize-configs';
import { ensureRevealEffect } from './settings-serialize-helper';
import { normalizePointillismStippleEffectParams } from '../vfx/effects-runtime/persistent/persistent-effect-params';

function cloneDefaultEffects(): NonNullable<ExperienceSettings['effects']> {
    return JSON.parse(JSON.stringify(DEFAULT_EFFECTS)) as NonNullable<ExperienceSettings['effects']>;
}

function readEffectEnabledFromBlock(block: Record<string, unknown>): boolean {
    return typeof block.enabled === 'boolean' ? block.enabled : true;
}

function writeEffectEnabledToBlock(block: Record<string, unknown>, enabled: boolean): void {
    block.enabled = enabled;
}

const PERSISTENT_TYPE_BLOCK_META_KEYS = new Set(['enabled', 'autoStart', 'effectParams']);

export type PersistentTrackName = 'scene' | 'camera' | 'stylization';

const PERSISTENT_TRACK_IDS: Record<PersistentTrackName, string> = {
    scene: SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    camera: SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    stylization: SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID
};

export function persistentTrackNameForEffectId(effectId: string): PersistentTrackName | null {
    if (effectId === SCENE_GSPLAT_PERSISTENT_EFFECT_ID) return 'scene';
    if (effectId === SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID) return 'camera';
    if (effectId === SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID) return 'stylization';
    return null;
}

export function persistentTrackNameForType(effectType: string): PersistentTrackName {
    return persistentEffectBucketForType(effectType);
}

function persistentTypeAllowedOnTrack(type: string, track: PersistentTrackName): boolean {
    return PERSISTENT_EFFECT_TYPES.has(type) && persistentTrackNameForType(type) === track;
}

function ensurePersistentTrackInEffects(
    e: NonNullable<ExperienceSettings['effects']>,
    name: PersistentTrackName
): NonNullable<ExperienceSettings['effects']>['persistent'][PersistentTrackName] {
    if (!e.persistent || typeof e.persistent !== 'object') {
        e.persistent = cloneDefaultEffects().persistent;
    }
    const id = PERSISTENT_TRACK_IDS[name];
    if (!e.persistent[name] || typeof e.persistent[name] !== 'object') {
        e.persistent[name] = { activeEffectId: id, paramsById: {} };
    }
    const track = e.persistent[name];
    track.activeEffectId = id;
    if (!track.paramsById || typeof track.paramsById !== 'object') {
        track.paramsById = {};
    }
    if (!track.paramsById[id] || typeof track.paramsById[id] !== 'object') {
        track.paramsById[id] = {};
    }
    return track;
}

function ensurePersistentSceneTrackInEffects(
    e: NonNullable<ExperienceSettings['effects']>
): NonNullable<ExperienceSettings['effects']>['persistent']['scene'] {
    return ensurePersistentTrackInEffects(e, 'scene');
}

function readPersistentTrackPack(settings: ExperienceSettings, trackName: PersistentTrackName): Record<string, unknown> {
    const track = ensurePersistentTrackInEffects(ensureEffectsSettings(settings), trackName);
    const id = PERSISTENT_TRACK_IDS[trackName];
    return (track.paramsById[id] as Record<string, unknown>) ?? {};
}

function writePersistentTrackPack(
    settings: ExperienceSettings,
    trackName: PersistentTrackName,
    pack: Record<string, unknown>
): void {
    const track = ensurePersistentTrackInEffects(ensureEffectsSettings(settings), trackName);
    track.paramsById[PERSISTENT_TRACK_IDS[trackName]] = { ...pack };
}

export function readPersistentScenePack(settings: ExperienceSettings): Record<string, unknown> {
    return readPersistentTrackPack(settings, 'scene');
}

function entryFromPersistentTypeBlock(type: string, block: Record<string, unknown>): PersistentSceneEffectEntry {
    const ep: Record<string, unknown> = {};
    if (block.effectParams && typeof block.effectParams === 'object' && !Array.isArray(block.effectParams)) {
        Object.assign(ep, block.effectParams as Record<string, unknown>);
    }
    for (const [k, v] of Object.entries(block)) {
        if (PERSISTENT_TYPE_BLOCK_META_KEYS.has(k)) {
            continue;
        }
        ep[k] = v;
    }
    return {
        type,
        enabled: readEffectEnabledFromBlock(block),
        autoStart: typeof block.autoStart === 'boolean' ? block.autoStart : true,
        ...(Object.keys(ep).length > 0 ? { effectParams: ep } : {})
    };
}

function parsePersistentTrackPack(
    pack: Record<string, unknown> | undefined,
    trackName: PersistentTrackName
): PersistentSceneEffectEntry[] {
    if (!pack) {
        return [];
    }
    const out: PersistentSceneEffectEntry[] = [];
    for (const key of Object.keys(pack)) {
        if (!persistentTypeAllowedOnTrack(key, trackName)) {
            continue;
        }
        const block = pack[key];
        if (block === null || typeof block !== 'object' || Array.isArray(block)) {
            continue;
        }
        out.push(entryFromPersistentTypeBlock(key, block as Record<string, unknown>));
    }
    return out;
}

export function parsePersistentScenePack(pack: Record<string, unknown> | undefined): PersistentSceneEffectEntry[] {
    return parsePersistentTrackPack(pack, 'scene');
}

export function persistentScenePackFromEntries(entries: PersistentSceneEffectEntry[]): Record<string, unknown> {
    const pack: Record<string, unknown> = {};
    for (const entry of entries) {
        const block: Record<string, unknown> = {
            enabled: entry.enabled,
            autoStart: entry.autoStart
        };
        if (entry.effectParams && typeof entry.effectParams === 'object' && !Array.isArray(entry.effectParams)) {
            Object.assign(block, entry.effectParams);
        }
        pack[entry.type] = block;
    }
    return pack;
}

/** 读取 scene persistent 配置；默认仅返回 `enabled !== false` 的项。 */
export function readPersistentSceneEffects(
    settings: ExperienceSettings,
    opts?: { includeDisabled?: boolean }
): PersistentSceneEffectEntry[] {
    const all = readPersistentTrackEffects(settings, 'scene', opts);
    return all;
}

export function readPersistentTrackEffects(
    settings: ExperienceSettings,
    trackName: PersistentTrackName,
    opts?: { includeDisabled?: boolean }
): PersistentSceneEffectEntry[] {
    const pack = readPersistentTrackPack(settings, trackName);
    const all = parsePersistentTrackPack(pack, trackName);
    if (opts?.includeDisabled) {
        return all;
    }
    return all.filter(e => e.enabled);
}

export function readPersistentCameraEffects(
    settings: ExperienceSettings,
    opts?: { includeDisabled?: boolean }
): PersistentSceneEffectEntry[] {
    return readPersistentTrackEffects(settings, 'camera', opts);
}

export function readPersistentStylizationEffects(
    settings: ExperienceSettings,
    opts?: { includeDisabled?: boolean }
): PersistentSceneEffectEntry[] {
    return readPersistentTrackEffects(settings, 'stylization', opts);
}

export function readActivePersistentEffects(settings: ExperienceSettings): PersistentSceneEffectEntry[] {
    return [
        ...readPersistentSceneEffects(settings),
        ...readPersistentCameraEffects(settings),
        ...readPersistentStylizationEffects(settings)
    ];
}

export function hasEnabledPersistentSceneEffects(settings: ExperienceSettings): boolean {
    return readPersistentSceneEffects(settings).length > 0;
}

export function hasEnabledPersistentEffects(settings: ExperienceSettings): boolean {
    return readActivePersistentEffects(settings).length > 0;
}

/** persistent 任一轨是否存在类型块（含 `enabled: false`）。 */
export function hasConfiguredPersistentEffects(settings: ExperienceSettings): boolean {
    return (
        readPersistentTrackEffects(settings, 'scene', { includeDisabled: true }).length > 0 ||
        readPersistentTrackEffects(settings, 'camera', { includeDisabled: true }).length > 0 ||
        readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true }).length > 0
    );
}

export function getPersistentSceneEffect(
    settings: ExperienceSettings,
    type: string
): PersistentSceneEffectEntry | null {
    return getPersistentTrackEffect(settings, 'scene', type);
}

export function getPersistentTrackEffect(
    settings: ExperienceSettings,
    trackName: PersistentTrackName,
    type: string
): PersistentSceneEffectEntry | null {
    return readPersistentTrackEffects(settings, trackName, { includeDisabled: true }).find(e => e.type === type) ?? null;
}

/** 是否已在 persistent scene 包中存在该类型块（含 `enabled: false`） */
export function hasPersistentSceneEffectBlock(settings: ExperienceSettings, type: string): boolean {
    return getPersistentSceneEffect(settings, type) !== null;
}

function writePersistentScenePack(settings: ExperienceSettings, pack: Record<string, unknown>): void {
    writePersistentTrackPack(settings, 'scene', pack);
}

/** 清空 scene persistent 包（`EFFECT_ADD` 且 `effectType === 'none'`） */
export function clearPersistentSceneEffects(settings: ExperienceSettings): void {
    writePersistentScenePack(settings, {});
}

export function clearPersistentTrackEffects(settings: ExperienceSettings, trackName: PersistentTrackName): void {
    writePersistentTrackPack(settings, trackName, {});
}

/** 从 scene persistent 包移除指定类型及其参数（`EFFECT_DELETE`） */
export function removePersistentSceneEffect(
    settings: ExperienceSettings,
    type: string
): PersistentSceneEffectEntry[] {
    return removePersistentTrackEffect(settings, 'scene', type);
}

export function removePersistentTrackEffect(
    settings: ExperienceSettings,
    trackName: PersistentTrackName,
    type: string
): PersistentSceneEffectEntry[] {
    const pack = { ...readPersistentTrackPack(settings, trackName) };
    delete pack[type];
    writePersistentTrackPack(settings, trackName, pack);
    return readPersistentTrackEffects(settings, trackName, { includeDisabled: true });
}

export function patchPersistentSceneEffect(
    settings: ExperienceSettings,
    type: string,
    patch: Partial<Pick<PersistentSceneEffectEntry, 'enabled' | 'autoStart' | 'effectParams'>>
): PersistentSceneEffectEntry[] {
    return patchPersistentTrackEffect(settings, 'scene', type, patch);
}

export function patchPersistentTrackEffect(
    settings: ExperienceSettings,
    trackName: PersistentTrackName,
    type: string,
    patch: Partial<Pick<PersistentSceneEffectEntry, 'enabled' | 'autoStart' | 'effectParams'>>,
    opts?: { replaceTrack?: boolean }
): PersistentSceneEffectEntry[] {
    if ((!persistentTypeAllowedOnTrack(type, trackName) && type !== 'none')) {
        return readPersistentTrackEffects(settings, trackName, { includeDisabled: true });
    }
    const pack = { ...readPersistentTrackPack(settings, trackName) };

    // camera / stylization 同轨互斥：启用新类型时仅停用其它块，保留其 effectParams
    if (opts?.replaceTrack && type !== 'none' && patch.enabled === true) {
        for (const key of Object.keys(pack)) {
            if (key === type || !persistentTypeAllowedOnTrack(key, trackName)) {
                continue;
            }
            const otherBlock = pack[key];
            if (otherBlock === null || typeof otherBlock !== 'object' || Array.isArray(otherBlock)) {
                continue;
            }
            const ob = { ...(otherBlock as Record<string, unknown>) };
            writeEffectEnabledToBlock(ob, false);
            pack[key] = ob;
        }
    }

    const current = getPersistentTrackEffect(settings, trackName, type);
    const block = (pack[type] as Record<string, unknown> | undefined) ?? {};
    const nextBlock: Record<string, unknown> = { ...block };
    if (typeof patch.enabled === 'boolean') {
        writeEffectEnabledToBlock(nextBlock, patch.enabled);
    } else if (!current) {
        writeEffectEnabledToBlock(nextBlock, false);
    }
    if (typeof patch.autoStart === 'boolean') {
        nextBlock.autoStart = patch.autoStart;
    }
    let nextEp: Record<string, unknown> = {};
    if (current?.effectParams) {
        nextEp = { ...current.effectParams };
    }
    if (patch.effectParams !== undefined) {
        if (patch.effectParams === null) {
            nextEp = {};
        } else {
            nextEp = { ...nextEp, ...patch.effectParams };
        }
    }
    if (type === 'pointillism-stipple' && Object.keys(nextEp).length > 0) {
        nextEp = normalizePointillismStippleEffectParams(nextEp, false);
    }
    for (const k of Object.keys(nextBlock)) {
        if (!PERSISTENT_TYPE_BLOCK_META_KEYS.has(k)) {
            delete nextBlock[k];
        }
    }
    Object.assign(nextBlock, nextEp);
    if (type === 'none') {
        delete pack[type];
    } else {
        pack[type] = nextBlock;
    }
    writePersistentTrackPack(settings, trackName, pack);
    return readPersistentTrackEffects(settings, trackName, { includeDisabled: true });
}

/**
 * `EFFECT_PARAMS_PATCH`（persistent scene）包形：与 reveal 相同，`{ [type]: { enabled?, autoStart?, …专参 } }`（与存盘一致）。
 */
export function buildPersistentProtocolParams(
    patchByType: Record<string, Partial<Pick<PersistentSceneEffectEntry, 'enabled' | 'autoStart' | 'effectParams'>>>
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [type, patch] of Object.entries(patchByType)) {
        if (!PERSISTENT_EFFECT_TYPES.has(type)) {
            continue;
        }
        const block: Record<string, unknown> = {};
        if (typeof patch.enabled === 'boolean') {
            block.enabled = patch.enabled;
        }
        if (typeof patch.autoStart === 'boolean') {
            block.autoStart = patch.autoStart;
        }
        if (patch.effectParams && typeof patch.effectParams === 'object' && !Array.isArray(patch.effectParams)) {
            Object.assign(block, patch.effectParams);
        }
        out[type] = block;
    }
    return out;
}

function persistentTypeKeysInProtocolParams(params: Record<string, unknown>): string[] {
    return Object.keys(params).filter(k => PERSISTENT_EFFECT_TYPES.has(k));
}

/**
 * postMessage 入站：与 reveal 相同嵌套包形；每条消息仅允许一个 type 键。
 * 例：`{ "overall-wave": { "noiseType": 1, "waveSpeed": 1.2 } }`
 */
export function coercePersistentProtocolParamsInbound(
    params: Record<string, unknown>
): Record<string, unknown> | null {
    const typeKeys = persistentTypeKeysInProtocolParams(params);
    if (typeKeys.length === 0) {
        return null;
    }
    if (typeKeys.length > 1) {
        console.warn(
            '[effects] persistent EFFECT_PARAMS_PATCH: only one effect type per message; ignored keys:',
            typeKeys
        );
        return null;
    }
    const block = params[typeKeys[0]];
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        return null;
    }
    return { [typeKeys[0]]: block };
}

export function parsePersistentProtocolParamsToPatch(
    params: Record<string, unknown>
): Record<string, Partial<Pick<PersistentSceneEffectEntry, 'enabled' | 'autoStart' | 'effectParams'>>> {
    const out: Record<string, Partial<Pick<PersistentSceneEffectEntry, 'enabled' | 'autoStart' | 'effectParams'>>> = {};
    for (const key of Object.keys(params)) {
        if (!PERSISTENT_EFFECT_TYPES.has(key)) {
            continue;
        }
        const block = params[key];
        if (block === null || typeof block !== 'object' || Array.isArray(block)) {
            continue;
        }
        const b = block as Record<string, unknown>;
        const patch: Partial<Pick<PersistentSceneEffectEntry, 'enabled' | 'autoStart' | 'effectParams'>> = {};
        if (typeof b.enabled === 'boolean') {
            patch.enabled = b.enabled;
        }
        if (typeof b.autoStart === 'boolean') {
            patch.autoStart = b.autoStart;
        }
        const ep: Record<string, unknown> = {};
        if (b.effectParams && typeof b.effectParams === 'object' && !Array.isArray(b.effectParams)) {
            Object.assign(ep, b.effectParams as Record<string, unknown>);
        }
        for (const [k, v] of Object.entries(b)) {
            if (PERSISTENT_TYPE_BLOCK_META_KEYS.has(k)) {
                continue;
            }
            ep[k] = v;
        }
        if (key === 'pointillism-stipple' && Object.keys(ep).length > 0) {
            patch.effectParams = normalizePointillismStippleEffectParams(ep, false);
        } else if (Object.keys(ep).length > 0) {
            patch.effectParams = ep;
        }
        out[key] = patch;
    }
    return out;
}

/** `EFFECT_PARAMS_PATCH`（persistent）是否含且仅含一个嵌套类型块（与 reveal 校验语义一致） */
export function persistentProtocolParamsHasPatchKeys(params: Record<string, unknown>): boolean {
    const typeKeys = persistentTypeKeysInProtocolParams(params);
    if (typeKeys.length !== 1) {
        return false;
    }
    const block = params[typeKeys[0]];
    return block !== null && typeof block === 'object' && !Array.isArray(block);
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
    ensurePersistentTrackInEffects(e, 'scene');
    ensurePersistentTrackInEffects(e, 'camera');
    ensurePersistentTrackInEffects(e, 'stylization');
    if (!e.asset || typeof e.asset !== 'object') {
        e.asset = { activeEffectId: ASSET_GSPLAT_EFFECT_ID, instancesByTargetId: {} };
    }
    e.asset.activeEffectId = ASSET_GSPLAT_EFFECT_ID;
    if (!e.asset.instancesByTargetId || typeof e.asset.instancesByTargetId !== 'object') {
        e.asset.instancesByTargetId = {};
    }
    delete (e.asset as Record<string, unknown>).defaultParamsById;
    return e;
}

function parseAssetInstanceType(raw: Record<string, unknown> | undefined): AssetEffectType | null {
    const t = raw?.type ?? raw?.effectId;
    return typeof t === 'string' && ASSET_EFFECT_TYPES.has(t) ? (t as AssetEffectType) : null;
}

function readMorphKeyframeIdsFromParams(params: Record<string, unknown>): string[] | null {
    const raw = params.keyframeEntityIds ?? params.keyframeTargetIds ?? params.keyframeIds;
    if (!Array.isArray(raw)) return null;
    const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return ids.length > 0 ? ids : null;
}

function pruneDuplicateMorphAssetInstances(
    map: Record<string, EffectsAssetInstance>,
    ownerTargetId: string,
    keyframeIds: readonly string[]
): void {
    const keyframes = new Set(keyframeIds);
    for (const [targetId, inst] of Object.entries(map)) {
        if (targetId === ownerTargetId || inst?.type !== 'gsplat-morph') continue;
        const ids = inst.effectParams ? readMorphKeyframeIdsFromParams(inst.effectParams) : null;
        if (!ids) continue;
        if (ids.some(id => keyframes.has(id))) {
            delete map[targetId];
        }
    }
}

export function readAssetInstanceParams(
    settings: ExperienceSettings,
    targetId: string
): EffectsAssetInstance | null {
    const e = ensureEffectsSettings(settings);
    const inst = e.asset.instancesByTargetId?.[targetId];
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
        typeof patchTypeRaw === 'string' && ASSET_EFFECT_TYPES.has(patchTypeRaw)
            ? (patchTypeRaw as AssetEffectType)
            : oldType
    ) as AssetEffectType;
    const typeIsChanging = typeof patchTypeRaw === 'string' && patchTypeRaw !== oldType;

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
            const incoming = filterAssetEffectParams(nextType, patch.effectParams as Record<string, unknown>);
            nextEffectParams = typeIsChanging ? { ...incoming } : { ...nextEffectParams, ...incoming };
        }
    }
    nextEffectParams = filterAssetEffectParams(nextType, nextEffectParams);

    const next: EffectsAssetInstance = {
        type: nextType,
        enabled:
            typeof patch.enabled === 'boolean'
                ? patch.enabled
                : current?.enabled !== false,
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

export function resolveAssetInstanceStorageTargetId(targetId: string, inst: EffectsAssetInstance): string {
    if (inst.type !== 'gsplat-morph' || !inst.effectParams) {
        return targetId;
    }
    return readMorphKeyframeIdsFromParams(inst.effectParams)?.[0] ?? targetId;
}

export function findAssetMorphOwnerTargetId(settings: ExperienceSettings, targetId: string): string | null {
    const e = ensureEffectsSettings(settings);
    for (const [ownerId, inst] of Object.entries(e.asset.instancesByTargetId ?? {})) {
        if (inst?.type !== 'gsplat-morph' || !inst.effectParams) continue;
        const ids = readMorphKeyframeIdsFromParams(inst.effectParams);
        if (ids?.includes(targetId)) {
            return ownerId;
        }
    }
    return null;
}

export function deleteAssetInstanceFromSettings(
    settings: ExperienceSettings,
    targetId: string
): EffectsAssetInstance | null {
    const e = ensureEffectsSettings(settings);
    const current = readAssetInstanceParams(settings, targetId);
    delete e.asset.instancesByTargetId![targetId];
    return current;
}

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

export function deleteAssetRuntimeMirror(state: State, targetId: string): void {
    if (!state.effectsRuntimeState) {
        return;
    }
    delete state.effectsRuntimeState.asset.instances[targetId];
}

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

/** reveal 存盘块内元字段；其余键归入 `effectParams`（读入时）。 */
const REVEAL_TYPE_BLOCK_META_KEYS = new Set(['enabled', 'autoStart', 'totalDuration', 'effectParams']);

/**
 * 从 `effects.reveal.paramsById[id]` 解析 reveal `type`。
 * - 新格式：`{ radial: { … } }` 等，type 为顶层键；
 * - 旧格式：`{ type: "radial", … }`（导入读兼容）。
 */
export function detectRevealTypeFromPack(pack: Record<string, unknown>): string | undefined {
    if (typeof pack.type === 'string') {
        return pack.type;
    }
    for (const key of Object.keys(pack)) {
        if (key === 'type') {
            continue;
        }
        const v = pack[key];
        if (
            (REVEAL_EFFECT_TYPES.has(key) || key === 'none') &&
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v)
        ) {
            return key;
        }
    }
    return undefined;
}

/** postMessage / 协议专用：仅识别 `{ [type]: { … } }`，忽略顶层 `type` 字符串。 */
function detectRevealTypeFromNestedPack(pack: Record<string, unknown>): string | undefined {
    for (const key of Object.keys(pack)) {
        if (key === 'type') {
            continue;
        }
        const v = pack[key];
        if (
            (REVEAL_EFFECT_TYPES.has(key) || key === 'none') &&
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v)
        ) {
            return key;
        }
    }
    return undefined;
}

/**
 * `EFFECT_PARAMS_PATCH`（reveal）包形：`{ [type]: { autoStart?, totalDuration?, …专参 } }`。
 * `fallbackType` 在 patch 未带 `type` 时用于专参-only 增量（如仅改 `maxEndRadius`）。
 */
export function buildRevealProtocolParams(
    patch: Partial<LegacyRevealEffect>,
    fallbackType?: string
): Record<string, unknown> {
    const type = (patch.type ?? fallbackType ?? 'none') as string;
    if (type === 'none') {
        return revealNoneParamRecord();
    }
    const block: Record<string, unknown> = {};
    if (typeof patch.enabled === 'boolean') {
        block.enabled = patch.enabled;
    }
    if (typeof patch.autoStart === 'boolean') {
        block.autoStart = patch.autoStart;
    }
    if (typeof patch.totalDuration === 'number') {
        block.totalDuration = patch.totalDuration;
    }
    if (patch.effectParams && typeof patch.effectParams === 'object' && !Array.isArray(patch.effectParams)) {
        Object.assign(block, patch.effectParams);
    }
    return { [type]: block };
}

function effectParamsFromRevealTypeBlock(block: Record<string, unknown>): Record<string, unknown> | undefined {
    const ep: Record<string, unknown> = {};
    if (block.effectParams && typeof block.effectParams === 'object' && !Array.isArray(block.effectParams)) {
        Object.assign(ep, block.effectParams as Record<string, unknown>);
    }
    for (const [k, v] of Object.entries(block)) {
        if (REVEAL_TYPE_BLOCK_META_KEYS.has(k)) {
            continue;
        }
        ep[k] = v;
    }
    return Object.keys(ep).length > 0 ? ep : undefined;
}

export type ParseRevealProtocolParamsOptions = {
    /** 当前 reveal `type`：嵌套键须与此一致；不传则允许从嵌套键推导 `patch.type`（导入/内部兼容） */
    lockToCurrentType?: string;
};

/**
 * 将 `EFFECT_PARAMS_PATCH.params`（嵌套包形）转为 `patchRevealSettingsFromParams` 的增量。
 * scene reveal 协议须传 `lockToCurrentType`，且**不会**写入 `patch.type`（改类型请用 `EFFECT_DELETE` + `EFFECT_ADD`）。
 */
export function parseRevealProtocolParamsToPatch(
    params: Record<string, unknown>,
    options?: ParseRevealProtocolParamsOptions
): Partial<LegacyRevealEffect> | null {
    const nestedType = detectRevealTypeFromNestedPack(params);
    if (!nestedType) {
        return null;
    }

    const lock = options?.lockToCurrentType;
    if (lock !== undefined && nestedType !== lock) {
        console.warn(
            `[effects] reveal EFFECT_PARAMS_PATCH: nested key "${nestedType}" must match current type "${lock}"; use EFFECT_DELETE + EFFECT_ADD to change type`
        );
        return null;
    }

    const patch: Partial<LegacyRevealEffect> = {};
    if (lock === undefined) {
        patch.type = nestedType as LegacyRevealEffect['type'];
    }
    const block = params[nestedType] as Record<string, unknown> | undefined;
    if (block && typeof block === 'object' && !Array.isArray(block)) {
        if (typeof block.enabled === 'boolean') {
            patch.enabled = block.enabled;
        }
        if (typeof block.autoStart === 'boolean') {
            patch.autoStart = block.autoStart;
        }
        if (
            typeof block.totalDuration === 'number' &&
            !Number.isNaN(block.totalDuration) &&
            block.totalDuration > 0
        ) {
            patch.totalDuration = block.totalDuration;
        }
        const ep = effectParamsFromRevealTypeBlock(block);
        if (ep) {
            patch.effectParams = ep;
        }
    }
    return patch;
}

/** `EFFECT_PARAMS_PATCH`（reveal）是否含嵌套类型块 */
export function revealProtocolParamsHasPatchKeys(params: Record<string, unknown>): boolean {
    return detectRevealTypeFromNestedPack(params) !== undefined;
}

/** 开场特效为 `none` 时的 `paramsById[id]` 存盘形态（空块对象）。 */
function revealNoneParamRecord(): Record<string, unknown> {
    return { none: {} };
}

/** 一次性 reveal 存盘：`{ [type]: { enabled?, autoStart?, totalDuration?, …专参 } }`；`none` 时为 `{ none: {} }`。 */
function revealToParamRecord(rev: LegacyRevealEffect): Record<string, unknown> {
    const type = rev.type ?? 'none';
    if (type === 'none') {
        return revealNoneParamRecord();
    }
    const block: Record<string, unknown> = {
        enabled: rev.enabled !== false
    };
    if (typeof rev.autoStart === 'boolean') {
        block.autoStart = rev.autoStart;
    }
    if (typeof rev.totalDuration === 'number') {
        block.totalDuration = rev.totalDuration;
    }
    if (rev.effectParams && typeof rev.effectParams === 'object' && !Array.isArray(rev.effectParams)) {
        Object.assign(block, rev.effectParams);
    }
    return { [type]: block };
}

function parseRevealPack(pack: Record<string, unknown> | undefined): LegacyRevealEffect | null {
    if (!pack) {
        return null;
    }
    const typeStr = detectRevealTypeFromPack(pack);
    if (!typeStr) {
        if (pack && typeof pack === 'object' && !Array.isArray(pack) && Object.keys(pack).length === 0) {
            return {
                type: 'none',
                enabled: false,
                autoStart: true,
                totalDuration: DEFAULT_VFX_TOTAL_DURATION
            };
        }
        return null;
    }

    // 旧扁平格式：`type` / `autoStart` / `totalDuration` / `effectParams`
    if (typeof pack.type === 'string') {
        const isNoneFlat = pack.type === 'none';
        const base: LegacyRevealEffect = {
            type: pack.type as LegacyRevealEffect['type'],
            enabled: isNoneFlat ? false : readEffectEnabledFromBlock(pack),
            autoStart: typeof pack.autoStart === 'boolean' ? pack.autoStart : true,
            totalDuration:
                typeof pack.totalDuration === 'number' ? pack.totalDuration : DEFAULT_VFX_TOTAL_DURATION
        };
        if (pack.effectParams && typeof pack.effectParams === 'object' && !Array.isArray(pack.effectParams)) {
            const ep = { ...(pack.effectParams as Record<string, unknown>) };
            if (Object.keys(ep).length > 0) {
                base.effectParams = ep;
            }
        }
        return base;
    }

    // 新格式：`{ [type]: { autoStart?, totalDuration?, …effectParams } }`
    const block = pack[typeStr] as Record<string, unknown> | undefined;
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
        return null;
    }
    const isNone = typeStr === 'none';
    const base: LegacyRevealEffect = {
        type: typeStr as LegacyRevealEffect['type'],
        enabled: isNone ? false : readEffectEnabledFromBlock(block),
        autoStart: typeof block.autoStart === 'boolean' ? block.autoStart : true,
        totalDuration:
            typeof block.totalDuration === 'number' ? block.totalDuration : DEFAULT_VFX_TOTAL_DURATION
    };
    if (isNone) {
        return base;
    }
    const ep: Record<string, unknown> = {};
    if (block.effectParams && typeof block.effectParams === 'object' && !Array.isArray(block.effectParams)) {
        Object.assign(ep, block.effectParams as Record<string, unknown>);
    }
    for (const [k, v] of Object.entries(block)) {
        if (REVEAL_TYPE_BLOCK_META_KEYS.has(k)) {
            continue;
        }
        ep[k] = v;
    }
    if (Object.keys(ep).length > 0) {
        base.effectParams = ep;
    }
    return base;
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

/** 开场 reveal 在场景中生效，或 persistent scene 轨有已启用特效 */
export function hasRevealInSettings(settings: ExperienceSettings): boolean {
    return isRevealEffectActiveInScene(readRevealParams(settings)) || hasEnabledPersistentEffects(settings);
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
    if (typeof merged.enabled === 'boolean') {
        rev.enabled = merged.enabled;
    } else {
        delete (rev as Record<string, unknown>).enabled;
    }
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

    const nextEnabled =
        typeof patch.enabled === 'boolean' ? patch.enabled : current?.enabled !== false;

    const next: LegacyRevealEffect = {
        type: nextType,
        enabled: nextEnabled,
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
 * 持久化前归一化：reveal 为 `none`（含历史空包 `{}`、缺键回退为 none）时，
 * 保证 `paramsById[scene.gsplat-reveal] === { none: {} }`。
 */
export function normalizeRevealStoragePack(settings: ExperienceSettings): void {
    const e = ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    e.reveal.activeEffectId = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    const type = (readRevealParams(settings)?.type ?? 'none') as string;
    if (type !== 'none') {
        return;
    }
    e.reveal.paramsById[id] = { ...revealNoneParamRecord() };
    syncLegacyRevealEffectShadow(settings);
}

/** 将 scene reveal 设为 `none` 存盘：`paramsById[id] === { none: {} }`（`EFFECT_DELETE`，`effectType` 为被卸下的旧类型） */
export function clearRevealScenePack(settings: ExperienceSettings): void {
    const e = ensureEffectsSettings(settings);
    e.reveal.paramsById[SCENE_GSPLAT_REVEAL_EFFECT_ID] = { ...revealNoneParamRecord() };
    const rev = ensureRevealEffect(settings);
    rev.type = 'none';
    rev.enabled = false;
    delete (rev as Record<string, unknown>).effectParams;
    rev.autoStart = true;
    rev.totalDuration = DEFAULT_VFX_TOTAL_DURATION;
    syncLegacyRevealEffectShadow(settings);
}

/**
 * `EFFECT_ADD`（reveal）：写入单一 `type` 块（调用方须先 `EFFECT_DELETE` 清掉旧类型）；`none` 请走 `EFFECT_DELETE`。
 */
export function replaceRevealSceneEffect(
    settings: ExperienceSettings,
    type: LegacyRevealEffect['type'],
    opts?: { enabled?: boolean; autoStart?: boolean; totalDuration?: number; effectParams?: Record<string, unknown> }
): LegacyRevealEffect {
    if (type === 'none') {
        clearRevealScenePack(settings);
        return { type: 'none', enabled: false, autoStart: true, totalDuration: DEFAULT_VFX_TOTAL_DURATION };
    }

    const enabled = opts?.enabled !== false;
    const autoStart = opts?.autoStart ?? true;
    const totalDuration = opts?.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
    const effectParams =
        opts?.effectParams && typeof opts.effectParams === 'object' && !Array.isArray(opts.effectParams)
            ? { ...opts.effectParams }
            : undefined;

    const next: LegacyRevealEffect = {
        type,
        enabled,
        autoStart,
        totalDuration,
        ...(effectParams && Object.keys(effectParams).length > 0 ? { effectParams } : {})
    };

    const e = ensureEffectsSettings(settings);
    e.reveal.paramsById[SCENE_GSPLAT_REVEAL_EFFECT_ID] = { ...revealToParamRecord(next) };
    syncLegacyRevealEffectShadow(settings);
    return next;
}

/** 协议层：将单 type 嵌套 `params`（`{ [type]: block }`）合并进 scene persistent 包 */
export function patchPersistentSceneFromProtocolParams(
    settings: ExperienceSettings,
    params: Record<string, unknown>
): PersistentSceneEffectEntry[] {
    return patchPersistentTrackFromProtocolParams(settings, 'scene', params);
}

export function patchPersistentTrackFromProtocolParams(
    settings: ExperienceSettings,
    trackName: PersistentTrackName,
    params: Record<string, unknown>
): PersistentSceneEffectEntry[] {
    const patches = parsePersistentProtocolParamsToPatch(params);
    for (const [type, p] of Object.entries(patches)) {
        patchPersistentTrackEffect(settings, trackName, type, p);
    }
    return readPersistentTrackEffects(settings, trackName, { includeDisabled: true });
}

/** reveal 播完后再挂 persistent（双轨配置） */
export function shouldDeferPersistentMount(settings: ExperienceSettings): boolean {
    const revealType = (readRevealParams(settings)?.type ?? 'none') as string;
    if (revealType === 'none' || isPersistentVfx(revealType)) {
        return false;
    }
    return hasEnabledPersistentEffects(settings);
}

/** 从 reveal 切走时清空全部 persistent 包 */
export function clearPersistentRevealTrack(settings: ExperienceSettings): void {
    clearPersistentTrackEffects(settings, 'scene');
    clearPersistentTrackEffects(settings, 'camera');
    clearPersistentTrackEffects(settings, 'stylization');
}

/**
 * 导出前调用：若仍存在内存里的 `revealEffect`，先镜像进 `effects`，保证 JSON 以 **`effects` 为唯一 scene reveal 真源**。
 * 调用方随后应从快照对象上 **删除 `revealEffect` 键**（不再写入 settings.json）。
 */
export function flushRevealIntoEffectsForExport(settings: ExperienceSettings): void {
    if (settings.revealEffect != null) {
        mirrorEffectsSettingsFromReveal(settings);
    }
    ensureEffectsSettings(settings);
    normalizeRevealStoragePack(settings);
}

/**
 * 以 `settings.revealEffect` 为 **reveal** 真源写入 `effects.reveal`；`effects.persistent` 在以下情况保留/写入：
 * - 旧单轨：`revealEffect.type` 为 persistent → 仅写 persistent；
 * - 双轨：`revealEffect` 为 reveal 且 `effects.persistent` 已有配置（含 `enabled: false`）→ **不清除** persistent，实现「播完 reveal 再挂 persistent」的存盘结构。
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
            ...revealToParamRecord({
                type: 'none',
                autoStart: typeof rev.autoStart === 'boolean' ? rev.autoStart : true,
                totalDuration:
                    typeof rev.totalDuration === 'number' ? rev.totalDuration : DEFAULT_VFX_TOTAL_DURATION
            })
        };
    }

    if (isPersistentVfx(t)) {
        const trackName = persistentTrackNameForType(t);
        const trackId = PERSISTENT_TRACK_IDS[trackName];
        const block: Record<string, unknown> = {
            enabled: true,
            autoStart: typeof rev.autoStart === 'boolean' ? rev.autoStart : true
        };
        if (rev.effectParams && typeof rev.effectParams === 'object' && !Array.isArray(rev.effectParams)) {
            Object.assign(block, rev.effectParams);
        }
        ensurePersistentTrackInEffects(e, trackName).paramsById[trackId] = { [t]: block };
        syncLegacyRevealEffectShadow(settings);
        return;
    }

    const preservePersistentWithReveal =
        hasConfiguredPersistentEffects(settings) && !isPersistentVfx(t);

    if (preservePersistentWithReveal) {
        syncLegacyRevealEffectShadow(settings);
        return;
    }

    clearPersistentRevealTrack(settings);
    syncLegacyRevealEffectShadow(settings);
}

function applyRevealParams(settings: ExperienceSettings): void {
    syncLegacyRevealEffectShadow(settings);
}

/** 导入/导出前：归一化 persistent 包内点彩专参（完整白名单 + 默认值） */
export function normalizePersistentEffectsForPersistence(settings: ExperienceSettings): void {
    ensureEffectsSettings(settings);
    const tracks: PersistentTrackName[] = ['scene', 'camera', 'stylization'];
    for (const trackName of tracks) {
        const pack = readPersistentTrackPack(settings, trackName);
        let changed = false;
        const nextPack: Record<string, unknown> = { ...pack };
        for (const [type, block] of Object.entries(pack)) {
            if (type !== 'pointillism-stipple') {
                continue;
            }
            if (block === null || typeof block !== 'object' || Array.isArray(block)) {
                continue;
            }
            const b = block as Record<string, unknown>;
            const entry = entryFromPersistentTypeBlock(type, b);
            const normalized = normalizePointillismStippleEffectParams(entry.effectParams ?? {}, true);
            const nextBlock: Record<string, unknown> = {};
            if (typeof b.enabled === 'boolean') {
                nextBlock.enabled = b.enabled;
            }
            if (typeof b.autoStart === 'boolean') {
                nextBlock.autoStart = b.autoStart;
            }
            Object.assign(nextBlock, normalized);
            nextPack[type] = nextBlock;
            changed = true;
        }
        if (changed) {
            writePersistentTrackPack(settings, trackName, nextPack);
        }
    }
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
    const effectsType = pack ? detectRevealTypeFromPack(pack) : undefined;
    const hasEffectsType = effectsType !== undefined;
    ensureRevealEffect(settings);
    const rev = settings.revealEffect!;
    const hasRevealType = typeof rev.type === 'string';

    if (hasEffectsType && hasRevealType && String(effectsType) !== String(rev.type)) {
        applyRevealParams(settings);
    } else if (hasEffectsType && !hasRevealType) {
        applyRevealParams(settings);
    }
    mirrorEffectsSettingsFromReveal(settings);
    normalizeRevealStoragePack(settings);
    normalizePersistentEffectsForPersistence(settings);
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
    const enabledPersistent = readActivePersistentEffects(settings);
    const persistentActive = enabledPersistent.length > 0;
    const reveal = state.effectsRuntimeState.reveal;
    const prevActiveType = reveal.activeType;
    const prevRevealStatus = reveal.status;
    const revealTypeChanged = prevActiveType !== revealType;
    reveal.activeEffectId = SCENE_GSPLAT_REVEAL_EFFECT_ID;
    reveal.activeType = revealType;
    if (revealType === 'none') {
        reveal.status = 'inactive';
    } else if (prevRevealStatus === 'playing' && !revealTypeChanged) {
        reveal.status = 'playing';
    } else if (prevRevealStatus === 'completed' && !revealTypeChanged) {
        reveal.status = 'completed';
    } else {
        reveal.status = 'inactive';
    }

    const persistent = state.effectsRuntimeState.persistent;
    persistent.activeEffectId = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    if (!persistentActive) {
        persistent.activeTypes = undefined;
        persistent.status = 'inactive';
    } else {
        persistent.activeTypes = enabledPersistent.map(e => e.type as PersistentEffectType);
        persistent.status = 'playing';
    }
    state.effectsRuntimeState.asset.activeEffectId = ASSET_GSPLAT_EFFECT_ID;
    syncAssetInstancesRuntimeFromSettings(state, settings);
}
