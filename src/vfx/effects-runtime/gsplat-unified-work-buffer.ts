import type { Entity } from 'playcanvas';
import type { GsplatShaderBlocks } from './gsplat-contribution';
import { extractGlslWgslModifyBlocks } from './gsplat-effect-layers-extractor';

type UnifiedGsplatComponent = {
    unified?: boolean;
    setWorkBufferModifier?: (shaders: { glsl?: string; wgsl?: string } | null) => void;
    setParameter?: (name: string, value: unknown) => void;
    workBufferUpdate?: number;
};

type WorkBufferContributor = {
    id: string;
    priority: number;
    glsl: string;
    wgsl: string;
};

type LayeredLang = 'glsl' | 'wgsl';

const NOOP_BY_LANG: Record<LayeredLang, string> = {
    glsl: /* glsl */ `
void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
}
`,
    wgsl: /* wgsl */ `
fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
}
`
};

const MODIFY_SHELL: Record<LayeredLang, { center: string; rot: string; color: string }> = {
    glsl: {
        center: 'void modifySplatCenter(inout vec3 center)',
        rot: 'void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale)',
        color: 'void modifySplatColor(vec3 center, inout vec4 color)'
    },
    wgsl: {
        center: 'fn modifySplatCenter(center: ptr<function, vec3f>)',
        rot: 'fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>)',
        color: 'fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>)'
    }
};

const contributorsByEntity = new WeakMap<Entity, Map<string, WorkBufferContributor>>();

function indentBody(src: string, spaces: string): string {
    const t = src.trim();
    if (!t) return '';
    return t
        .split('\n')
        .map((line) => (line.trim() ? spaces + line : ''))
        .filter((line) => line.length > 0)
        .join('\n');
}

function buildLayeredModify(
    layers: { id: string; shaderBlocks: GsplatShaderBlocks }[],
    lang: LayeredLang
): string {
    const blockKey = lang;
    const headers: string[] = [];
    const pos: string[] = [];
    const rot: string[] = [];
    const col: string[] = [];

    for (const layer of layers) {
        const g = layer.shaderBlocks[blockKey];
        if (g.header?.trim()) headers.push(`// --- header: ${layer.id} ---\n${g.header.trim()}`);
        if (g.applyPosition?.trim()) {
            pos.push(`// --- ${layer.id}: applyPosition ---\n${indentBody(g.applyPosition, '    ')}`);
        }
        if (g.applyRotationScale?.trim()) {
            rot.push(`// --- ${layer.id}: applyRotationScale ---\n${indentBody(g.applyRotationScale, '    ')}`);
        }
        if (g.applyColor?.trim()) {
            col.push(`// --- ${layer.id}: applyColor ---\n${indentBody(g.applyColor, '    ')}`);
        }
    }

    if (headers.length === 0 && pos.length === 0 && rot.length === 0 && col.length === 0) {
        return NOOP_BY_LANG[lang];
    }

    const shell = MODIFY_SHELL[lang];
    const headerBlock = headers.length > 0 ? `${headers.join('\n\n')}\n\n` : '';
    const posBody = pos.length > 0 ? `${pos.join('\n\n')}\n` : '';
    const rotBody = rot.length > 0 ? `${rot.join('\n\n')}\n` : '';
    const colBody = col.length > 0 ? `${col.join('\n\n')}\n` : '';

    return `${headerBlock}${shell.center} {
${posBody}}

${shell.rot} {
${rotBody}}

${shell.color} {
${colBody}}
`;
}

function applyGsplatUnifiedWorkBuffer(entity: Entity, shaders: { glsl: string; wgsl: string }): void {
    const gsplat = entity.gsplat as UnifiedGsplatComponent;
    gsplat.setWorkBufferModifier!({ glsl: shaders.glsl, wgsl: shaders.wgsl });
    gsplat.workBufferUpdate = 2;
}

function removeGsplatUnifiedWorkBuffer(entity: Entity): void {
    const gsplat = entity.gsplat as UnifiedGsplatComponent | null;
    gsplat?.setWorkBufferModifier?.(null);
    if (gsplat) {
        gsplat.workBufferUpdate = 0;
    }
}

function recomposeUnifiedWorkBuffer(entity: Entity): void {
    const map = contributorsByEntity.get(entity);
    if (!map || map.size === 0) {
        contributorsByEntity.delete(entity);
        removeGsplatUnifiedWorkBuffer(entity);
        return;
    }

    const layers = [...map.values()]
        .sort((a, b) => a.priority - b.priority)
        .map((c) => ({
            id: c.id,
            shaderBlocks: extractGlslWgslModifyBlocks(c.glsl, c.wgsl)
        }));

    applyGsplatUnifiedWorkBuffer(entity, {
        glsl: buildLayeredModify(layers, 'glsl'),
        wgsl: buildLayeredModify(layers, 'wgsl')
    });
}

/** unified 高斯是否支持 per-entity work buffer（不影响同层其它 GS 实例）。 */
export function gsplatSupportsUnifiedWorkBuffer(entity: Entity): boolean {
    const gsplat = entity.gsplat as UnifiedGsplatComponent | null;
    return !!(gsplat?.unified && gsplat.setWorkBufferModifier);
}

/** 注册/更新同一实体上的 work buffer 贡献者；多贡献者时按 priority 分层合成。 */
export function registerGsplatUnifiedWorkBufferContributor(
    entity: Entity,
    id: string,
    shaders: { glsl: string; wgsl: string },
    priority = 0
): void {
    let map = contributorsByEntity.get(entity);
    if (!map) {
        map = new Map();
        contributorsByEntity.set(entity, map);
    }
    map.set(id, { id, priority, glsl: shaders.glsl, wgsl: shaders.wgsl });
    recomposeUnifiedWorkBuffer(entity);
}

/** 注销贡献者；若无剩余贡献者则清除 work buffer。 */
export function unregisterGsplatUnifiedWorkBufferContributor(entity: Entity, id: string): void {
    const map = contributorsByEntity.get(entity);
    if (!map?.has(id)) {
        return;
    }
    map.delete(id);
    recomposeUnifiedWorkBuffer(entity);
}

export function setGsplatUnifiedWorkBufferParameter(
    entity: Entity,
    name: string,
    value: unknown
): void {
    (entity.gsplat as UnifiedGsplatComponent | null)?.setParameter?.(name, value);
}

/** GsplatShaderEffect 子类 unified work buffer 分支所需的最小宿主面。 */
export type UnifiedWorkBufferShaderHost = {
    entity: Entity;
    app: { renderNextFrame: boolean };
    initialized: boolean;
    enabled: boolean;
    isPaused: boolean;
    effectTime: number;
    shadersNeedApplication: boolean;
    _unifiedWorkBuffer: boolean;
    getShaderGLSL(): string;
    getShaderWGSL(): string;
    updateEffect(effectTime: number, dt: number): void;
    applyShaders(): void;
};

export function tryApplyUnifiedWorkBufferShaders(
    host: UnifiedWorkBufferShaderHost,
    contributorId: string,
    priority: number
): boolean {
    if (!gsplatSupportsUnifiedWorkBuffer(host.entity)) {
        return false;
    }
    registerGsplatUnifiedWorkBufferContributor(
        host.entity,
        contributorId,
        { glsl: host.getShaderGLSL(), wgsl: host.getShaderWGSL() },
        priority
    );
    host._unifiedWorkBuffer = true;
    host.initialized = true;
    host.updateEffect(host.effectTime, 0);
    return true;
}

export function removeUnifiedWorkBufferShaders(
    host: UnifiedWorkBufferShaderHost,
    contributorId: string
): boolean {
    if (!host._unifiedWorkBuffer) {
        return false;
    }
    unregisterGsplatUnifiedWorkBufferContributor(host.entity, contributorId);
    host._unifiedWorkBuffer = false;
    return true;
}

export function setUniformViaUnifiedWorkBuffer(
    host: UnifiedWorkBufferShaderHost,
    name: string,
    value: unknown
): boolean {
    if (!host._unifiedWorkBuffer) {
        return false;
    }
    setGsplatUnifiedWorkBufferParameter(host.entity, name, value);
    host.app.renderNextFrame = true;
    return true;
}

export function updateViaUnifiedWorkBuffer(
    host: UnifiedWorkBufferShaderHost,
    dt: number,
    superUpdate: (dt: number) => void
): void {
    if (!host._unifiedWorkBuffer) {
        superUpdate(dt);
        return;
    }
    if (!host.initialized && host.entity.gsplat) {
        host.initialized = true;
        if (host.enabled && host.shadersNeedApplication) {
            host.applyShaders();
            host.shadersNeedApplication = false;
        }
    }
    if (host.shadersNeedApplication) {
        host.applyShaders();
        host.shadersNeedApplication = false;
    }
    if (!host.isPaused) {
        host.effectTime += dt;
    }
    host.updateEffect(host.effectTime, dt);
    if (host.enabled) {
        host.app.renderNextFrame = true;
    }
}

export function skipUnifiedMaterialListener(entity: Entity): boolean {
    return gsplatSupportsUnifiedWorkBuffer(entity);
}
