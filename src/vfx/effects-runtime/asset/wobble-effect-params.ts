/**
 * 静物活化（`gsplat-wobble`）`effectParams` 默认值（按动作模式）。
 */

/** 扭动 / 摇头晃脑等模式的通用默认 */
export const DEFAULT_WOBBLE_EFFECT_PARAMS: Readonly<Record<string, unknown>> = {
    amplitude: 0.7,
    wobbleAxis: 'x',
    motionMode: 'wobble',
    frequency: 5,
    bounceAmplitude: 0.6,
    bounceStretch: 0.75,
    wobbleAnchorLift: 0.15,
    colorMix: 1,
    goldColor: [1, 0.85, 0],
    haloWidth: 0.1,
    haloSpeed: 1,
    haloOpacity: 1,
    continuousRender: true
};

/** 瞌睡虫（`deepMeditation`）专用默认 */
export const DEFAULT_DEEP_MEDITATION_WOBBLE_PARAMS: Readonly<Record<string, unknown>> = {
    motionMode: 'deepMeditation',
    amplitude: 0.05,
    wobbleAxis: 'x',
    colorMix: 1,
    goldColor: [148 / 255, 228 / 255, 230 / 255],
    haloOpacity: 0.17,
    haloWidth: 0.14,
    haloSpeed: 0.25
};

export function getDefaultWobbleEffectParams(motionMode?: string): Record<string, unknown> {
    if (motionMode === 'deepMeditation') {
        return {
            ...DEFAULT_WOBBLE_EFFECT_PARAMS,
            ...DEFAULT_DEEP_MEDITATION_WOBBLE_PARAMS
        };
    }
    return { ...DEFAULT_WOBBLE_EFFECT_PARAMS };
}

export function mergeWobbleEffectParams(
    incoming: Record<string, unknown> | undefined | null,
    motionModeHint?: string
): Record<string, unknown> {
    const mode =
        typeof incoming?.motionMode === 'string'
            ? incoming.motionMode
            : typeof motionModeHint === 'string'
              ? motionModeHint
              : 'wobble';
    const base = getDefaultWobbleEffectParams(mode);
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return base;
    }
    return { ...base, ...incoming };
}
