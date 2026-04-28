/**
 * 首访与 VFX 视频导出共用语义：存在开场 reveal/VFX 时，编辑侧叠加内容（放置资产、标注、附加光源等）
 * 应在与 `revealComplete` 对齐的时刻之后才参与画面；亮灯区域依赖 Bloom 的 `_bloomStackUnlocked`，由 synthetic `revealComplete` 解锁。
 *
 * 与 viewer 的对应关系（正常浏览）：
 * - `hasRevealEffect` 时，`initAnnotations` / `initSceneAssets` 挂在 `revealComplete` 上，首屏不会立刻出现标注与场景资产。
 * - VFX 导出：**仅 Timed 类**（`RevealController.isTimedEffect()`）才按 `frameTime` 与阈值门控编辑叠加层；radial / smooth / rain 等非 Timed 导出全程视为「已过门控」，叠加层始终可见。
 *
 * 架构要点：
 * - `DeferredEditingLayerSpec`：单一职责的可视层，可增删或单测 mock。
 * - 阈值与是否 Timed 由构造时传入的 `RevealExportTimingSource`（通常为 `RevealController`）提供，**不**挂在 `Global` 上。
 * - `VfxExportPostRevealSync`：导出循环内的状态机（显隐去重 + 最多一次 synthetic revealComplete）。
 */

import type { Global } from '../types';
import { DEFAULT_VFX_TOTAL_DURATION } from '../schemas/v2-custom';

/** 与 `RevealController` 上用于导出门控的方法对齐（避免本模块依赖 Global 或整类循环引用时可只实现这两方法） */
export type RevealExportTimingSource = {
    getPostRevealContentThresholdSec(): number;
    isTimedEffect(): boolean;
};

/** 控制某一类「应在 reveal 之后再出现」的内容是否对画面可见 */
export type DeferredEditingLayerVisibilityFn = (global: Global, visible: boolean) => void;

/** 单个延迟可视层（可自定义注册表以扩展 / 测试） */
export interface DeferredEditingLayerSpec {
    readonly id: string;
    readonly applyVisibility: DeferredEditingLayerVisibilityFn;
}

/** 场景里与编辑工具对应的根实体名（与 asset-placement、光照等创建逻辑一致） */
const ENTITY_NAMES = {
    placedAssets: 'placedAssets',
    pointLights: 'pointLights',
    spotLights: 'spotLights'
} as const;

/** 按根节点名开关整棵子树是否参与更新/渲染（找不到则静默跳过） */
function setRootEntityEnabled(global: Global, name: string, visible: boolean): void {
    const entity = global.app.root.findByName(name) as { enabled?: boolean } | null;
    if (entity && typeof entity.enabled === 'boolean') {
        entity.enabled = visible;
    }
}

/** 默认与 viewer 首访 defer（initAnnotations / initSceneAssets）所覆盖的范围一致 */
export const DEFAULT_DEFERRED_EDITING_LAYERS: readonly DeferredEditingLayerSpec[] = [
    {
        id: 'scene.placedAssets',
        applyVisibility: (g, v) => setRootEntityEnabled(g, ENTITY_NAMES.placedAssets, v)
    },
    {
        id: 'annotations.all',
        applyVisibility: (g, v) => {
            // reveal 期间（v=false）强制隐藏标注
            // reveal 解锁时（v=true）参考 viewSettings 中的用户显隐意图
            const targetVisible = v ? (g.viewSettings?.annotationsVisible ?? true) : false;
            const am = (g as { annotationManager?: { setAllAnnotationsVisible?: (x: boolean) => void } })
                .annotationManager;
            am?.setAllAnnotationsVisible?.(targetVisible);
        }
    },
    {
        id: 'lights.point',
        applyVisibility: (g, v) => setRootEntityEnabled(g, ENTITY_NAMES.pointLights, v)
    },
    {
        id: 'lights.spot',
        applyVisibility: (g, v) => setRootEntityEnabled(g, ENTITY_NAMES.spotLights, v)
    }
];

function resolveThresholdSec(global: Global, reveal: RevealExportTimingSource | null): number {
    if (reveal) {
        const t = Number(reveal.getPostRevealContentThresholdSec());
        if (Number.isFinite(t) && t >= 0) {
            return t;
        }
    }
    return global.settings?.revealEffect?.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
}

/** 是否对本次导出做「按秒数隐藏编辑层 + synthetic revealComplete」门控（仅 Timed + 含 VFX + 有 reveal） */
function shouldApplyTimedExportRevealGate(
    global: Global,
    includeVfx: boolean,
    reveal: RevealExportTimingSource | null
): boolean {
    if (!includeVfx || !global.state.hasRevealEffect || !reveal) {
        return false;
    }
    return reveal.isTimedEffect() === true;
}

/**
 * VFX 导出时间轴：按帧隐藏/显示延迟层，并在越过阈值时补发一次 `revealComplete`（与真实播完对齐 Bloom 等）。
 */
export class VfxExportPostRevealSync {
    private readonly layers: readonly DeferredEditingLayerSpec[];

    private readonly reveal: RevealExportTimingSource | null;

    /** 避免对每层重复写入相同的 visible（减少无意义遍历） */
    private lastVisibilityApplied: boolean | null = null;

    /**
     * 本段导出内是否已触发过「合成」的 revealComplete。
     * 真实浏览里 Bloom 等在第一次 revealComplete 时解锁；导出必须最多打一次，避免监听器被多次触发。
     */
    private syntheticRevealCompleteFired = false;

    constructor(
        reveal: RevealExportTimingSource | null = null,
        layers: readonly DeferredEditingLayerSpec[] = DEFAULT_DEFERRED_EDITING_LAYERS
    ) {
        this.reveal = reveal ?? null;
        this.layers = layers;
    }

    /** 对注册表内每一层调用 `applyVisibility`；单层的异常只打日志不中断其它层 */
    private applyAllLayers(global: Global, visible: boolean): void {
        if (this.lastVisibilityApplied === visible) {
            return;
        }
        this.lastVisibilityApplied = visible;
        for (const layer of this.layers) {
            try {
                layer.applyVisibility(global, visible);
            } catch (err) {
                console.warn(`[VfxExportPostRevealSync] layer "${layer.id}" applyVisibility failed`, err);
            }
        }
    }

    /**
     * 每帧在设置 VFX 时间与渲染之前调用（与离线编码、快速导出两路循环一致）。
     *
     * - 未勾选包含 VFX、或当前无 reveal、或 **非 Timed 特效**：不门控，编辑层始终可见。
     * - 包含 VFX + 有 reveal + **Timed**：`frameTimeSec < 阈值` 时隐藏编辑层；越过后显示并 `fire('revealComplete')` 一次。
     */
    syncExportFrame(global: Global, frameTimeSec: number, opts: { includeVfx: boolean }): void {
        if (!shouldApplyTimedExportRevealGate(global, opts.includeVfx, this.reveal)) {
            this.applyAllLayers(global, true);
            return;
        }
        const threshold = resolveThresholdSec(global, this.reveal);
        // 浮点累加与帧对齐可能略低于阈值，微小 epsilon 避免最后一帧卡在「未通过」
        const passed = frameTimeSec + 1e-4 >= threshold;
        this.applyAllLayers(global, passed);
        if (passed && !this.syntheticRevealCompleteFired) {
            global.events.fire('revealComplete');
            this.syntheticRevealCompleteFired = true;
        }
    }

    /**
     * 导出结束或取消：强制恢复编辑层可见，并重置内部状态供下次导出使用。
     * 若 **Timed 导出**从未在帧循环里触发过 synthetic `revealComplete`（abort、时长不足等），补发一次，避免 Bloom `_bloomStackUnlocked` 永远 false。
     * 非 Timed 导出不会在循环里触发，此处同样补发，保证结束后面与首访一致。
     */
    finalizeAfterExport(
        global: Global,
        opts: { includeVfx: boolean; hadRevealEffect: boolean }
    ): void {
        this.applyAllLayers(global, true);
        if (opts.includeVfx && opts.hadRevealEffect && !this.syntheticRevealCompleteFired) {
            global.events.fire('revealComplete');
        }
        this.syntheticRevealCompleteFired = false;
        this.lastVisibilityApplied = null;
    }
}

/**
 * @param reveal 一般由组合根通过 `initVideoExport` 注入的 `getRevealExportTimingSource()` 返回（如 `RevealController`）；为 null 时 Timed 门控不启用，阈值回退 settings。
 */
export function createVfxExportPostRevealSync(
    reveal: RevealExportTimingSource | null | undefined = null,
    layers?: readonly DeferredEditingLayerSpec[]
): VfxExportPostRevealSync {
    return new VfxExportPostRevealSync(reveal ?? null, layers ?? DEFAULT_DEFERRED_EDITING_LAYERS);
}

/** 在默认层之后追加自定义层（例如新编辑模块的实体根节点），再传入 `createVfxExportPostRevealSync(...)`。 */
export function extendDeferredEditingLayers(
    ...extra: DeferredEditingLayerSpec[]
): readonly DeferredEditingLayerSpec[] {
    return [...DEFAULT_DEFERRED_EDITING_LAYERS, ...extra];
}
