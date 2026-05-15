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
import { SCENE_GSPLAT_PERSISTENT_EFFECT_ID, SCENE_GSPLAT_REVEAL_EFFECT_ID } from '../vfx/effects-runtime/effect-types';
import { hasRevealEffectFromSettings, isPersistentVfx } from '../vfx/effects-runtime/reveal/reveal-policy';
import { DEFAULT_EFFECTS } from './settings-serialize-configs';
import { ensureRevealEffect } from './settings-serialize-helper';

function cloneDefaultEffects(): NonNullable<ExperienceSettings['effects']> {
    return JSON.parse(JSON.stringify(DEFAULT_EFFECTS)) as NonNullable<ExperienceSettings['effects']>;
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
    // `enabled` 缺省时：若 scene 包已写可持续类型，默认视为开（与 editUI `enabled ?? true` 一致）；否则为关。
    // 须在 paramsById 归一化之后推断，否则导入仅写 `paramsById` 的 JSON 会在 mirror 时被误判为关并清空 persistent。
    if (typeof e.persistent.enabled !== 'boolean') {
        const pid = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
        const p = e.persistent.paramsById[pid] as Record<string, unknown> | undefined;
        const t = p && typeof p.type === 'string' ? p.type : undefined;
        e.persistent.enabled = !!(t && isPersistentVfx(t));
    }
    if (!e.asset || typeof e.asset !== 'object') {
        e.asset = { defaultParamsById: {} };
    }
    if (!e.asset.defaultParamsById || typeof e.asset.defaultParamsById !== 'object') {
        e.asset.defaultParamsById = {};
    }
    return e;
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

/** persistent 轨 `paramsById`：仅 `type` / `autoStart` / `effectParams`，**不含** `totalDuration`（与一次性 reveal 包形区分）。 */
function persistentToParamRecord(rev: LegacyRevealEffect): Record<string, unknown> {
    const out: Record<string, unknown> = {
        type: rev.type,
        autoStart: rev.autoStart ?? true
    };
    if (rev.effectParams && typeof rev.effectParams === 'object' && !Array.isArray(rev.effectParams)) {
        const ep = { ...rev.effectParams };
        if (Object.keys(ep).length > 0) {
            out.effectParams = ep;
        }
    }
    return out;
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

/** 解析 persistent 轨存盘包；忽略 `totalDuration`（旧 JSON 残留键不读入）。 */
function parsePersistentPack(pack: Record<string, unknown> | undefined): LegacyRevealEffect | null {
    if (!pack || typeof pack.type !== 'string') {
        return null;
    }
    const base: LegacyRevealEffect = {
        type: pack.type as LegacyRevealEffect['type'],
        autoStart: typeof pack.autoStart === 'boolean' ? pack.autoStart : true
    };
    if (pack.effectParams && typeof pack.effectParams === 'object' && !Array.isArray(pack.effectParams)) {
        const ep = { ...(pack.effectParams as Record<string, unknown>) };
        if (Object.keys(ep).length > 0) {
            base.effectParams = ep;
        }
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

/** `effects.persistent` 视为开（`enabled !== false`）且含合法可持续 `type` */
function persistentRevealInEffects(settings: ExperienceSettings): boolean {
    ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    const pe = settings.effects!.persistent;
    if (pe.enabled === false) return false;
    const pack = pe.paramsById[id] as Record<string, unknown> | undefined;
    return !!(pack && typeof pack.type === 'string' && isPersistentVfx(pack.type));
}

/** `revealEffect` 或 persistent 轨任一表示存在 scene reveal 配置 */
export function hasRevealInSettings(settings: ExperienceSettings): boolean {
    return hasRevealEffectFromSettings(readRevealParams(settings)) || persistentRevealInEffects(settings);
}

/** 可持续 scene GSplat 参数：优先读 `effects.persistent`，再回退 legacy 单轨 `revealEffect`。 */
export function readPersistentRevealParams(settings: ExperienceSettings): LegacyRevealEffect | null {
    ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    const pe = settings.effects!.persistent;
    if (pe.enabled !== false) {
        const pack = pe.paramsById[id] as Record<string, unknown> | undefined;
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
    const id = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
    const rawPack = e.persistent.paramsById[id] as Record<string, unknown> | undefined;
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
    e.persistent.paramsById[id] = { ...persistentToParamRecord(next) };
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
        e.persistent.enabled = true;
        e.persistent.paramsById[persistentId] = { ...persistentToParamRecord(rev) };
        syncLegacyRevealEffectShadow(settings);
        return;
    }

    const pe = e.persistent;
    const existingPersistentPack = pe.paramsById[persistentId] as Record<string, unknown> | undefined;
    const existingPersistentType =
        existingPersistentPack && typeof existingPersistentPack.type === 'string'
            ? (existingPersistentPack.type as string)
            : undefined;
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
        asset: { instances: {} }
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
}
