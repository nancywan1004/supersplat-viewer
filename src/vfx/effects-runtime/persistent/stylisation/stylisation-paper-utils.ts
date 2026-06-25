import { Color } from 'playcanvas';

export const colorsRoughlyEqual = (a: Color, b: Color): boolean =>
    Math.abs(a.r - b.r) < 1e-4 &&
    Math.abs(a.g - b.g) < 1e-4 &&
    Math.abs(a.b - b.b) < 1e-4 &&
    Math.abs(a.a - b.a) < 1e-4;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

export function normalizeRgbColor(
    v: unknown,
    fallback: [number, number, number]
): [number, number, number] {
    if (!Array.isArray(v) || v.length < 3) {
        return [...fallback];
    }
    return [
        clamp01(finiteOr(v[0], fallback[0])),
        clamp01(finiteOr(v[1], fallback[1])),
        clamp01(finiteOr(v[2], fallback[2]))
    ];
}

export function paperClearColorFromRgb(rgb: [number, number, number]): Color {
    return new Color(rgb[0], rgb[1], rgb[2], 1);
}
