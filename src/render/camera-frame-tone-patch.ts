import type { GraphicsDevice } from 'playcanvas';
import { ShaderChunks } from 'playcanvas';

/**
 * CameraFrame（CF）路径的色调顺序修正（Phase 2 / D2）。
 *
 * 背景：挂上 CF 后，viewer 会把 gsplat / 天空盒的输出 patch 成 gamma 空间（RT 里是"未 tonemap 的显示值"），
 * 并把 tonemap 交给 compose（`cameraFrame.rendering.toneMapping`）。但引擎 compose 里那句
 * `result = toneMap(result)` 拿到的是 gamma 数据（**少了 decodeGamma**），而末尾的
 * `gammaCorrectOutput(result)` 在 GAMMA_NONE 下又是 `return color;`（**不编码**），于是整条 CF 链变成
 * `ACES(gamma)`：暗部被抬亮、亮部被压暗，画面发灰发平 —— 与非 CF 路径 / SuperSplat 的
 * `encode(ACES(decode(x)))` 不一致。
 *
 * 本模块只补两处，且**只在 CF 挂载期间生效**，退出时按快照精确恢复：
 *
 * 1. `gammaPS`：把 `#if (GAMMA == SRGB) ... #else ... #endif` 拍平成 SRGB 分支 →
 *    `gammaCorrectOutput` 真正做编码，`gammaCorrectInput` 也变成 decodeGamma（这正是 sRGB 语义）；
 *    同时让 CF 下**标准材质 / GLB 资产**也写 gamma 空间，不再和 splat / 天空盒混空间（修掉 mesh 分叉）。
 * 2. tonemap 各变体：在 `toneMap` 函数体开头插入 `color = pow(color, 2.2)`（WGSL 因参数不可变而改名参数 + `var color`），
 *    让 ACES 等曲线作用在线性值上。**不用「重命名 + 外层包装」**：那依赖函数声明顺序，而 chunk 的
 *    include 顺序不可依赖（compose 里 `tonemappingPS` 在 `gammaPS` 之前，材质里相反）。
 *
 * 重要：这样**不改变任何后处理的输入空间**——compose 里 tonemap 之前的
 * CAS / FRINGING / BLOOM / COLOR_ENHANCE / GRADING 仍看到同一张未 tonemap 的 RT，tonemap 之后的
 * COLOR_LUT / VIGNETTE 仍是线性值；且 bloom 自己的 prefilter / blur pass 根本不引用这两个 chunk。
 * 所以后处理参数不需要重校，变化的只有最终色调（这正是目标）。
 */

/** tonemap 变体：compose 与材质都通过 `tonemappingPS` 分发到其中之一 */
const TONEMAP_CHUNKS = [
    'tonemappingNonePS',
    'tonemappingLinearPS',
    'tonemappingFilmicPS',
    'tonemappingHejlPS',
    'tonemappingAcesPS',
    'tonemappingAces2PS',
    'tonemappingNeutralPS'
] as const;

const GAMMA_CHUNK = 'gammaPS';

/**
 * 把 gammaPS 的 `#if (GAMMA == SRGB) ... #else ... #endif` 拍平，只保留 SRGB 分支的实现。
 * 注意：#if 之前的前缀必须原样保留（`#include "decodePS"` 就在那里，丢了会导致 decodeGamma 未定义）。
 * 返回 null 表示 chunk 结构不符合预期（引擎升级），调用方应保持原样并告警。
 */
export const flattenGammaChunk = (source: string | undefined): string | null => {
    if (!source) return null;
    const match = /#if\s*\(\s*GAMMA\s*==\s*SRGB\s*\)([\s\S]*?)#else[\s\S]*?#endif/.exec(source);
    if (!match || match.index === undefined) return null;
    const prefix = source.slice(0, match.index);
    return `${prefix}${match[1].trim()}\n`;
};

/**
 * 出现次数：签名>1 时改写会产出重复定义，必须放弃
 */
const countOccurrences = (source: string, search: string): number => source.split(search).length - 1;

/**
 * GLSL：在 `toneMap` 函数体开头插入一句 decode，让 ACES 等曲线作用在线性值上。
 *
 * 为什么不用「重命名 + 外层包装」：那依赖函数声明顺序，而 chunk 的 include 顺序不可依赖 ——
 * compose shader 里是 `tonemappingPS` 在 `gammaPS` **之前**，材质里则相反。函数体内部插一句
 * 既不新增符号、也不依赖任何外部函数（不引用 decodePS 的 decodeGamma），数学等价于 `pow(x, 2.2)`。
 * 注意 GLSL ES 的参数默认是 `in` 的副本，可以赋值。
 */
export const decodeTonemapChunkGlsl = (source: string | undefined): string | null => {
    if (!source) return null;
    const signature = 'vec3 toneMap(vec3 color) {';
    if (countOccurrences(source, signature) !== 1) return null;
    return source.replace(signature, `${signature}\n\tcolor = pow(color, vec3(2.2));`);
};

/**
 * WGSL：同上。WGSL 的函数参数不可变，因此把参数改名后声明一个局部 `var color`（函数体仍引用 `color`）。
 */
export const decodeTonemapChunkWgsl = (source: string | undefined): string | null => {
    if (!source) return null;
    const signature = 'fn toneMap(color: vec3f) -> vec3f {';
    if (countOccurrences(source, signature) !== 1) return null;
    return source.replace(signature, `fn toneMap(cfToneInput: vec3f) -> vec3f {\n\tvar color = pow(cfToneInput, vec3f(2.2));`);
};

type Snapshot = { dialect: 'glsl' | 'wgsl'; name: string; source: string };

/**
 * CF 色调修正器：`apply()` 打补丁（幂等），`restore()` 按首次 apply 时的快照还原。
 * 每次 apply 都重新读取当前 chunk（可能有其它系统也 patch 过），但快照只在第一次记录。
 */
export class CameraFrameTonePatch {
    private readonly device: GraphicsDevice;

    private snapshots: Snapshot[] | null = null;

    private applied = false;

    constructor(device: GraphicsDevice) {
        this.device = device;
    }

    get isApplied(): boolean {
        return this.applied;
    }

    /**
     * 应用修正。任一 chunk 结构与预期不符时只告警并跳过该项，绝不半途破坏渲染。
     * @param enabled - false 时等价于 restore()
     */
    apply(enabled: boolean): void {
        if (!enabled) {
            this.restore();
            return;
        }
        if (this.applied) return;

        const glsl = ShaderChunks.get(this.device, 'glsl');
        const wgsl = ShaderChunks.get(this.device, 'wgsl');
        const snapshots: Snapshot[] = [];

        // 1) gammaPS 拍平（强制编码）
        const gammaGlsl = glsl.get(GAMMA_CHUNK);
        const flatGlsl = flattenGammaChunk(gammaGlsl);
        if (flatGlsl == null) {
            console.warn(`[cfTone] glsl ${GAMMA_CHUNK} 结构与预期不符，跳过 gamma 修正`);
        } else {
            snapshots.push({ dialect: 'glsl', name: GAMMA_CHUNK, source: gammaGlsl });
            glsl.set(GAMMA_CHUNK, flatGlsl);
        }
        const gammaWgsl = wgsl.get(GAMMA_CHUNK);
        const flatWgsl = flattenGammaChunk(gammaWgsl);
        if (flatWgsl == null) {
            console.warn(`[cfTone] wgsl ${GAMMA_CHUNK} 结构与预期不符，跳过 gamma 修正`);
        } else {
            snapshots.push({ dialect: 'wgsl', name: GAMMA_CHUNK, source: gammaWgsl });
            wgsl.set(GAMMA_CHUNK, flatWgsl);
        }

        // 2) tonemap 各变体：函数体开头插一句 decode（不同后端拥有的变体数量不同，缺失的静默跳过）
        for (const name of TONEMAP_CHUNKS) {
            const srcGlsl = glsl.get(name);
            if (srcGlsl !== undefined) {
                const patchedGlsl = decodeTonemapChunkGlsl(srcGlsl);
                if (patchedGlsl == null) {
                    console.warn(`[cfTone] glsl ${name} 未找到唯一的 toneMap 签名，跳过`);
                } else {
                    snapshots.push({ dialect: 'glsl', name, source: srcGlsl });
                    glsl.set(name, patchedGlsl);
                }
            }

            const srcWgsl = wgsl.get(name);
            if (srcWgsl !== undefined) {
                const patchedWgsl = decodeTonemapChunkWgsl(srcWgsl);
                if (patchedWgsl == null) {
                    console.warn(`[cfTone] wgsl ${name} 未找到唯一的 toneMap 签名，跳过`);
                } else {
                    snapshots.push({ dialect: 'wgsl', name, source: srcWgsl });
                    wgsl.set(name, patchedWgsl);
                }
            }
        }

        this.snapshots = snapshots;
        this.applied = true;
        console.log(`[cfTone] CameraFrame 色调修正已启用（${snapshots.length} 个 chunk）`);
    }

    /** 还原到 apply 前记录的快照（未 apply 过则什么都不做） */
    restore(): void {
        if (!this.applied || !this.snapshots) return;

        const glsl = ShaderChunks.get(this.device, 'glsl');
        const wgsl = ShaderChunks.get(this.device, 'wgsl');
        for (const snapshot of this.snapshots) {
            (snapshot.dialect === 'glsl' ? glsl : wgsl).set(snapshot.name, snapshot.source);
        }
        this.snapshots = null;
        this.applied = false;
        console.log('[cfTone] CameraFrame 色调修正已还原');
    }
}
