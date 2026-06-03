import type { Material, GraphicsDevice } from 'playcanvas';
import type { Global } from '../../types';
import type { GsplatContribution } from './gsplat-contribution';
import {
    ComposerDiagnosticCode,
    type ComposedGsplatModifyResult,
    type ComposerDiagnostic
} from './composer-diagnostics';
const NOOP_GLSL = /* glsl */ `
void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
}
`;

const NOOP_WGSL = /* wgsl */ `
fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
}
`;

function fnv1a(input: string): string {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function hashShaderBlocksGlsl(c: GsplatContribution): string {
    const b = c.shaderBlocks.glsl;
    return fnv1a([b.header ?? '', b.applyPosition ?? '', b.applyRotationScale ?? '', b.applyColor ?? ''].join('\x1e'));
}

function hashShaderBlocksWgsl(c: GsplatContribution): string {
    const b = c.shaderBlocks.wgsl;
    return fnv1a([b.header ?? '', b.applyPosition ?? '', b.applyRotationScale ?? '', b.applyColor ?? ''].join('\x1e'));
}

function uniformKeysSignature(c: GsplatContribution): string {
    return Object.keys(c.uniforms ?? {}).sort().join(',');
}

function indentBody(src: string, spaces: string): string {
    const t = src.trim();
    if (!t) return '';
    return t
        .split('\n')
        .map((line) => (line.trim() ? spaces + line : ''))
        .filter((line) => line.length > 0)
        .join('\n');
}

function isFullContribution(c: GsplatContribution): boolean {
    return c.source === 'full' && !!c.fullModifyGlsl && !!c.fullModifyWgsl;
}

function buildGlsl(active: GsplatContribution[]): string {
    const headers: string[] = [];
    const pos: string[] = [];
    const rot: string[] = [];
    const col: string[] = [];

    for (const c of active) {
        const g = c.shaderBlocks.glsl;
        if (g.header?.trim()) headers.push(`// --- header: ${c.id} ---\n${g.header.trim()}`);
        if (g.applyPosition?.trim()) {
            pos.push(`// --- ${c.id}: applyPosition ---\n${indentBody(g.applyPosition, '    ')}`);
        }
        if (g.applyRotationScale?.trim()) {
            rot.push(`// --- ${c.id}: applyRotationScale ---\n${indentBody(g.applyRotationScale, '    ')}`);
        }
        if (g.applyColor?.trim()) {
            col.push(`// --- ${c.id}: applyColor ---\n${indentBody(g.applyColor, '    ')}`);
        }
    }

    if (headers.length === 0 && pos.length === 0 && rot.length === 0 && col.length === 0) {
        return NOOP_GLSL;
    }

    const headerBlock = headers.length > 0 ? `${headers.join('\n\n')}\n\n` : '';
    const posBody = pos.length > 0 ? `${pos.join('\n\n')}\n` : '';
    const rotBody = rot.length > 0 ? `${rot.join('\n\n')}\n` : '';
    const colBody = col.length > 0 ? `${col.join('\n\n')}\n` : '';

    return `${headerBlock}void modifySplatCenter(inout vec3 center) {
${posBody}}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
${rotBody}}

void modifySplatColor(vec3 center, inout vec4 color) {
${colBody}}
`;
}

function buildWgsl(active: GsplatContribution[]): string {
    const headers: string[] = [];
    const pos: string[] = [];
    const rot: string[] = [];
    const col: string[] = [];

    for (const c of active) {
        const g = c.shaderBlocks.wgsl;
        if (g.header?.trim()) headers.push(`// --- header: ${c.id} ---\n${g.header.trim()}`);
        if (g.applyPosition?.trim()) {
            pos.push(`// --- ${c.id}: applyPosition ---\n${indentBody(g.applyPosition, '    ')}`);
        }
        if (g.applyRotationScale?.trim()) {
            rot.push(`// --- ${c.id}: applyRotationScale ---\n${indentBody(g.applyRotationScale, '    ')}`);
        }
        if (g.applyColor?.trim()) {
            col.push(`// --- ${c.id}: applyColor ---\n${indentBody(g.applyColor, '    ')}`);
        }
    }

    if (headers.length === 0 && pos.length === 0 && rot.length === 0 && col.length === 0) {
        return NOOP_WGSL;
    }

    const headerBlock = headers.length > 0 ? `${headers.join('\n\n')}\n\n` : '';
    const posBody = pos.length > 0 ? `${pos.join('\n\n')}\n` : '';
    const rotBody = rot.length > 0 ? `${rot.join('\n\n')}\n` : '';
    const colBody = col.length > 0 ? `${col.join('\n\n')}\n` : '';

    return `${headerBlock}fn modifySplatCenter(center: ptr<function, vec3f>) {
${posBody}}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
${rotBody}}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
${colBody}}
`;
}

function buildSignature(active: GsplatContribution[]): string {
    const parts = active.map((c) => {
        const caps = c.capabilities ?? {};
        if (isFullContribution(c)) {
            return [
                'full',
                c.id,
                c.enabled ? '1' : '0',
                String(c.version),
                c.scope,
                c.targetId ?? '',
                caps.requiresGsplatShaderSlot ? '1' : '0',
                caps.exclusiveWithLighting ? '1' : '0',
                caps.allowConcurrentWithPersistent ? '1' : '0',
                fnv1a(c.fullModifyGlsl!),
                fnv1a(c.fullModifyWgsl!),
                uniformKeysSignature(c)
            ].join('|');
        }
        return [
            'layered',
            c.id,
            c.enabled ? '1' : '0',
            String(c.version),
            c.scope,
            c.targetId ?? '',
            caps.requiresGsplatShaderSlot ? '1' : '0',
            caps.exclusiveWithLighting ? '1' : '0',
            caps.allowConcurrentWithPersistent ? '1' : '0',
            hashShaderBlocksGlsl(c),
            hashShaderBlocksWgsl(c),
            uniformKeysSignature(c)
        ].join('|');
    });
    return fnv1a(parts.join('\n'));
}

function mergeUniforms(active: GsplatContribution[]): Record<string, number | number[] | Float32Array> {
    const out: Record<string, number | number[] | Float32Array> = {};
    for (const c of active) {
        const u = c.uniforms;
        if (!u) continue;
        for (const [k, v] of Object.entries(u)) {
            out[`${c.id}::${k}`] = v;
        }
    }
    return out;
}

/**
 * 全项目 gsplatModifyVS 的**唯一**合成与（由调用方触发）下发入口。
 * - `compose()`：内存侧 signature + GLSL/WGSL 文本。
 * - `applyComposedToMaterials()`：写入材质 chunk（M3：NightMode 路径）。
 */
export class GsplatEffectComposer {
    private readonly contributions = new Map<string, GsplatContribution>();

    private lastComposition: ComposedGsplatModifyResult | null = null;

    private lastSignature = '';

    /** 避免 cap/冲突诊断在每帧 compose 时重复刷控制台 */
    private lastLoggedDiagnosticKey = '';

    /** signature 变化次数（供调试/性能） */
    recomposeCount = 0;

    readonly maxSceneContributors: number;

    readonly maxAssetContributors: number;

    private readonly _graphicsDevice: GraphicsDevice;

    constructor(
        global: Global,
        options?: { maxSceneContributors?: number; maxAssetContributors?: number }
    ) {
        this.maxSceneContributors = options?.maxSceneContributors ?? 2;
        this.maxAssetContributors = options?.maxAssetContributors ?? 8;
        this._graphicsDevice = (global.app as unknown as { graphicsDevice: GraphicsDevice }).graphicsDevice;
    }

    setContribution(contribution: GsplatContribution): void {
        this.contributions.set(contribution.id, contribution);
    }

    removeContribution(id: string): void {
        this.contributions.delete(id);
    }

    getContribution(id: string): GsplatContribution | undefined {
        return this.contributions.get(id);
    }

    clearContributions(): void {
        this.contributions.clear();
    }

    getRegisteredIds(): string[] {
        return [...this.contributions.keys()];
    }

    compose(): ComposedGsplatModifyResult {
        try {
            return this.composeInternal();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[GsplatEffectComposer] compose failed, using NOOP:', msg);
            const diag: ComposerDiagnostic = {
                code: ComposerDiagnosticCode.COMPOSE_ERROR,
                message: msg
            };
            const fallback: ComposedGsplatModifyResult = {
                compositionSignature: fnv1a(`error|${msg}`),
                gsplatModifyGlsl: NOOP_GLSL,
                gsplatModifyWgsl: NOOP_WGSL,
                activeContributionIds: [],
                mergedUniforms: {},
                diagnostics: [diag],
                signatureChanged: true
            };
            this.lastComposition = fallback;
            this.lastSignature = fallback.compositionSignature;
            return fallback;
        }
    }

    /**
     * 将最近一次 compose 结果写入材质；无活跃贡献时 **delete** `gsplatModifyVS`（与旧 removeShaders 语义对齐）。
     */
    applyComposedToMaterials(materials: Set<Material>, result?: ComposedGsplatModifyResult): void {
        const res = result ?? this.lastComposition;
        if (!res) return;
        const list = [...materials];
        if (list.length === 0) return;
        const lang = this._graphicsDevice?.isWebGPU ? 'wgsl' : 'glsl';
        const shouldDelete = res.activeContributionIds.length === 0;
        for (const m of list) {
            const chunks = m.getShaderChunks(lang);
            if (shouldDelete) {
                chunks.delete('gsplatModifyVS');
            } else {
                const src = lang === 'glsl' ? res.gsplatModifyGlsl : res.gsplatModifyWgsl;
                chunks.set('gsplatModifyVS', src);
            }
            m.update();
        }
    }

    private composeInternal(): ComposedGsplatModifyResult {
        const diagnostics: ComposerDiagnostic[] = [];
        const enabled = [...this.contributions.values()].filter((c) => c.enabled);

        const exclusive = enabled.filter((c) => c.capabilities?.exclusiveWithLighting === true);
        const droppedExclusive = new Set<string>();
        if (exclusive.length > 1) {
            exclusive.sort((a, b) => b.priority - a.priority);
            const keep = exclusive[0]!;
            for (let i = 1; i < exclusive.length; i++) {
                droppedExclusive.add(exclusive[i]!.id);
                diagnostics.push({
                    code: ComposerDiagnosticCode.CONFLICT_REDUCED,
                    message: `exclusiveWithLighting: keeping ${keep.id}, dropped ${exclusive[i]!.id}`,
                    contributionId: exclusive[i]!.id
                });
            }
        }

        const pool = enabled.filter((c) => !droppedExclusive.has(c.id));

        const scene = pool.filter((c) => c.scope === 'scene').sort((a, b) => b.priority - a.priority);
        const asset = pool.filter((c) => c.scope === 'asset').sort((a, b) => b.priority - a.priority);

        const sceneKept = scene.slice(0, this.maxSceneContributors);
        const assetKept = asset.slice(0, this.maxAssetContributors);

        for (const c of scene.slice(this.maxSceneContributors)) {
            diagnostics.push({
                code: ComposerDiagnosticCode.SCENE_CAP_DEGRADED,
                message: `scene contributors capped at ${this.maxSceneContributors}, dropped ${c.id}`,
                contributionId: c.id
            });
        }
        for (const c of asset.slice(this.maxAssetContributors)) {
            diagnostics.push({
                code: ComposerDiagnosticCode.ASSET_CAP_DEGRADED,
                message: `asset contributors capped at ${this.maxAssetContributors}, dropped ${c.id}`,
                contributionId: c.id
            });
        }

        const merged = [...sceneKept, ...assetKept].sort((a, b) => a.priority - b.priority);

        const fullList = merged.filter((c) => isFullContribution(c));
        const layeredList = merged.filter((c) => !isFullContribution(c));

        let finalActive: GsplatContribution[] = [];

        if (fullList.length > 0 && layeredList.length > 0) {
            fullList.sort((a, b) => b.priority - a.priority);
            const keep = fullList[0]!;
            diagnostics.push({
                code: ComposerDiagnosticCode.CONFLICT_REDUCED,
                message: `full vs layered: keeping full contributor ${keep.id}, dropping ${layeredList.length} layered`,
                contributionId: keep.id
            });
            finalActive = [keep];
        } else if (fullList.length > 1) {
            fullList.sort((a, b) => b.priority - a.priority);
            const keep = fullList[0]!;
            for (let i = 1; i < fullList.length; i++) {
                diagnostics.push({
                    code: ComposerDiagnosticCode.CONFLICT_REDUCED,
                    message: `multiple full chunks: keeping ${keep.id}, dropped ${fullList[i]!.id}`,
                    contributionId: fullList[i]!.id
                });
            }
            finalActive = [keep];
        } else if (fullList.length === 1) {
            finalActive = [fullList[0]!];
        } else {
            finalActive = layeredList;
        }

        if (diagnostics.length === 0) {
            diagnostics.push({ code: ComposerDiagnosticCode.OK });
        }

        let gsplatModifyGlsl: string;
        let gsplatModifyWgsl: string;

        if (finalActive.length === 0) {
            gsplatModifyGlsl = '';
            gsplatModifyWgsl = '';
        } else if (finalActive.length === 1 && isFullContribution(finalActive[0]!)) {
            const c = finalActive[0]!;
            gsplatModifyGlsl = c.fullModifyGlsl!;
            gsplatModifyWgsl = c.fullModifyWgsl!;
        } else {
            gsplatModifyGlsl = buildGlsl(finalActive);
            gsplatModifyWgsl = buildWgsl(finalActive);
        }

        const compositionSignature = finalActive.length === 0 ? fnv1a('empty') : buildSignature(finalActive);
        const signatureChanged = compositionSignature !== this.lastSignature;
        if (signatureChanged) {
            this.recomposeCount++;
        }
        this.lastSignature = compositionSignature;

        const result: ComposedGsplatModifyResult = {
            compositionSignature,
            gsplatModifyGlsl,
            gsplatModifyWgsl,
            activeContributionIds: finalActive.map((c) => c.id),
            mergedUniforms: mergeUniforms(finalActive),
            diagnostics,
            signatureChanged
        };
        this.lastComposition = result;

        const nonOk = diagnostics.filter((d) => d.code !== ComposerDiagnosticCode.OK);
        if (nonOk.length === 0) {
            this.lastLoggedDiagnosticKey = '';
        } else {
            const warnKey = nonOk.map((d) => `${d.code}:${d.contributionId ?? ''}:${d.message ?? ''}`).join('|');
            if (warnKey !== this.lastLoggedDiagnosticKey) {
                this.lastLoggedDiagnosticKey = warnKey;
                console.warn('[GsplatEffectComposer]', diagnostics);
            }
        }

        return result;
    }

    getLastComposition(): ComposedGsplatModifyResult | null {
        return this.lastComposition;
    }

    getDebugSnapshot() {
        const last = this.lastComposition;
        return {
            registeredIds: this.getRegisteredIds(),
            recomposeCount: this.recomposeCount,
            lastSignature: this.lastSignature,
            activeContributionIds: last?.activeContributionIds ?? [],
            diagnostics: last?.diagnostics ?? []
        };
    }

    /** 无材质写路径时仍可每帧 compose（例如仅调 uniform 的宿主自管材质） */
    update(): void {
        this.compose();
    }

    dispose(): void {
        this.contributions.clear();
        this.lastComposition = null;
        this.lastSignature = '';
    }
}
