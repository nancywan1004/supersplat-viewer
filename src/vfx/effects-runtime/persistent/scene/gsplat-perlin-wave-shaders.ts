/** 与 GLSL/WGSL 及 {@link GsplatRevealPerlinWave} 的 setUniform 一致 */
export const PERLIN_WAVE_UNIFORM_NAMES = {
    time: 'uPerlinTime',
    center: 'uPerlinCenter',
    intensity: 'uPerlinIntensity',
    waveAmplitude: 'uPerlinWaveAmplitude',
    waveFrequency: 'uPerlinWaveFrequency',
    waveSpeed: 'uPerlinWaveSpeed',
    scaleBlend: 'uPerlinScaleBlend',
    endRadius: 'uEndRadius'
} as const;

/** perlin-wave 独立 shader（composer layered / 单脚本） */
export const perlinWaveShaderGlsl = /* glsl */`
uniform float uPerlinTime;
uniform vec3 uPerlinCenter;
uniform float uPerlinIntensity;
uniform float uPerlinWaveAmplitude;
uniform float uPerlinWaveFrequency;
uniform float uPerlinWaveSpeed;
uniform float uPerlinScaleBlend;
uniform float uEndRadius;

vec3 perlinHash2(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(vec3(p.x * p.y * p.z, p.x + p.y * p.z, p.x * p.y + p.z));
}

mat2 rot(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
}

vec3 noise2(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    vec3 n000 = perlinHash2(i + vec3(0, 0, 0));
    vec3 n100 = perlinHash2(i + vec3(1, 0, 0));
    vec3 n010 = perlinHash2(i + vec3(0, 1, 0));
    vec3 n110 = perlinHash2(i + vec3(1, 1, 0));
    vec3 n001 = perlinHash2(i + vec3(0, 0, 1));
    vec3 n101 = perlinHash2(i + vec3(1, 0, 1));
    vec3 n011 = perlinHash2(i + vec3(0, 1, 1));
    vec3 n111 = perlinHash2(i + vec3(1, 1, 1));

    vec3 x0 = mix(n000, n100, f.x);
    vec3 x1 = mix(n010, n110, f.x);
    vec3 x2 = mix(n001, n101, f.x);
    vec3 x3 = mix(n011, n111, f.x);

    vec3 y0 = mix(x0, x1, f.y);
    vec3 y1 = mix(x2, x3, f.y);

    return mix(y0, y1, f.z);
}

vec4 sin3D(vec3 p, float t, float spatialScale, float timeScale) {
    float m = exp(-2.0 * length(sin(p * 2.0 * spatialScale + t * timeScale))) * 5.0;
    return vec4(m) + 0.3;
}

float g_dist;

void initShared(vec3 center) {
    g_dist = length(center - uPerlinCenter);
}

void modifySplatCenter(inout vec3 center) {
    initShared(center);
    vec3 noiseOffset = uPerlinWaveAmplitude * noise2(center * uPerlinWaveFrequency + uPerlinTime * uPerlinWaveSpeed);
    center += noiseOffset;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    initShared(modifiedCenter);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    initShared(center);
    vec4 e = sin3D(center, uPerlinTime, uPerlinWaveFrequency, uPerlinWaveSpeed * 3.0);
    color = mix(color, color * e, uPerlinIntensity);
}
`;

export const perlinWaveShaderWgsl = /* wgsl */`
uniform uPerlinTime: f32;
uniform uPerlinCenter: vec3f;
uniform uPerlinIntensity: f32;
uniform uPerlinWaveAmplitude: f32;
uniform uPerlinWaveFrequency: f32;
uniform uPerlinWaveSpeed: f32;
uniform uPerlinScaleBlend: f32;

fn perlinHash2(p: vec3f) -> vec3f {
    var p2 = fract(p * 0.3183099 + 0.1);
    p2 *= 17.0;
    return fract(vec3f(
        p2.x * p2.y * p2.z,
        p2.x + p2.y * p2.z,
        p2.x * p2.y + p2.z
    ));
}

fn rot(a: f32) -> mat2x2f {
    let s = sin(a);
    let c = cos(a);
    return mat2x2f(
        vec2f(c, -s),
        vec2f(s, c)
    );
}

fn noise2(p: vec3f) -> vec3f {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    let n000 = perlinHash2(i + vec3f(0.0, 0.0, 0.0));
    let n100 = perlinHash2(i + vec3f(1.0, 0.0, 0.0));
    let n010 = perlinHash2(i + vec3f(0.0, 1.0, 0.0));
    let n110 = perlinHash2(i + vec3f(1.0, 1.0, 0.0));
    let n001 = perlinHash2(i + vec3f(0.0, 0.0, 1.0));
    let n101 = perlinHash2(i + vec3f(1.0, 0.0, 1.0));
    let n011 = perlinHash2(i + vec3f(0.0, 1.0, 1.0));
    let n111 = perlinHash2(i + vec3f(1.0, 1.0, 1.0));

    let x0 = mix(n000, n100, f.x);
    let x1 = mix(n010, n110, f.x);
    let x2 = mix(n001, n101, f.x);
    let x3 = mix(n011, n111, f.x);

    let y0 = mix(x0, x1, f.y);
    let y1 = mix(x2, x3, f.y);

    return mix(y0, y1, f.z);
}

fn sin3D(p: vec3f, t: f32, spatialScale: f32, timeScale: f32) -> vec4f {
    let m = exp(-2.0 * length(sin(p * 2.0 * spatialScale + t * timeScale))) * 5.0;
    return vec4f(m, m, m, 1.0) + vec4f(0.3, 0.3, 0.3, 0.0);
}

var<private> g_dist: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uPerlinCenter);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    initShared(*center);
    let noiseOffset = uniform.uPerlinWaveAmplitude * noise2(*center * uniform.uPerlinWaveFrequency + uniform.uPerlinTime * uniform.uPerlinWaveSpeed);
    *center = *center + noiseOffset;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    initShared(modifiedCenter);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    initShared(center);
    let e = sin3D(center, uniform.uPerlinTime, uniform.uPerlinWaveFrequency, uniform.uPerlinWaveSpeed * 3.0);
    *color = mix(*color, *color * e, uniform.uPerlinIntensity);
}
`;
