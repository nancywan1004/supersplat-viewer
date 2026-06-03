/**
 * perlin-wave / overall-wave 在 {@link GsplatEffectComposer} 中 layered 合成时的共享声明。
 * 各特效 shader 文件勿重复声明下列 uniform / hash2，由 composer 在合成时 prepend 一次。
 */

export const GSPLAT_WAVE_COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform float uIntensity;
uniform float uWaveAmplitude;
uniform float uWaveFrequency;
uniform float uWaveSpeed;

vec3 hash2(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(vec3(p.x * p.y * p.z, p.x + p.y * p.z, p.x * p.y + p.z));
}
`;

export const GSPLAT_WAVE_COMMON_WGSL = /* wgsl */ `
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uIntensity: f32;
uniform uWaveAmplitude: f32;
uniform uWaveFrequency: f32;
uniform uWaveSpeed: f32;

fn hash2(p: vec3f) -> vec3f {
    var p2 = fract(p * 0.3183099 + 0.1);
    p2 *= 17.0;
    return fract(vec3f(
        p2.x * p2.y * p2.z,
        p2.x + p2.y * p2.z,
        p2.x * p2.y + p2.z
    ));
}
`;
