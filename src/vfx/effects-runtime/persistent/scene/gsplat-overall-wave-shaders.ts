/** �?GLSL/WGSL �?{@link GsplatPersistentOverallWave} �?setUniform 一�?*/
export const OVERALL_WAVE_UNIFORM_NAMES = {
    time: 'uOverallTime',
    center: 'uOverallCenter',
    intensity: 'uOverallIntensity',
    waveAmplitude: 'uOverallWaveAmplitude',
    waveFrequency: 'uOverallWaveFrequency',
    waveSpeed: 'uOverallWaveSpeed',
    noiseType: 'uOverallNoiseType',
    waveDirection: 'uOverallWaveDirection',
    crestTint: 'uOverallCrestTint',
    troughTint: 'uOverallTroughTint'
} as const;

/** overall-wave 独立 shader（composer layered / 单脚本） */
export const overallWaveShaderGlsl = /* glsl */`
uniform float uOverallTime;
uniform vec3 uOverallCenter;
uniform float uOverallIntensity;
uniform float uOverallWaveAmplitude;
uniform float uOverallWaveFrequency;
uniform float uOverallWaveSpeed;
uniform float uOverallNoiseType;
uniform vec3 uOverallWaveDirection;
uniform vec3 uOverallCrestTint;
uniform vec3 uOverallTroughTint;

vec3 overallHash2(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(vec3(p.x * p.y * p.z, p.x + p.y * p.z, p.x * p.y + p.z));
}

const float TAU = 6.28318530718;

vec3 noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec3 n000 = overallHash2(i + vec3(0.0, 0.0, 0.0));
    vec3 n100 = overallHash2(i + vec3(1.0, 0.0, 0.0));
    vec3 n010 = overallHash2(i + vec3(0.0, 1.0, 0.0));
    vec3 n110 = overallHash2(i + vec3(1.0, 1.0, 0.0));
    vec3 n001 = overallHash2(i + vec3(0.0, 0.0, 1.0));
    vec3 n101 = overallHash2(i + vec3(1.0, 0.0, 1.0));
    vec3 n011 = overallHash2(i + vec3(0.0, 1.0, 1.0));
    vec3 n111 = overallHash2(i + vec3(1.0, 1.0, 1.0));
    vec3 x0 = mix(n000, n100, f.x);
    vec3 x1 = mix(n010, n110, f.x);
    vec3 x2 = mix(n001, n101, f.x);
    vec3 x3 = mix(n011, n111, f.x);
    vec3 y0 = mix(x0, x1, f.y);
    vec3 y1 = mix(x2, x3, f.y);
    return mix(y0, y1, f.z);
}

float overallWaveLen() {
    return 1.0 / max(uOverallWaveFrequency, 0.02);
}

float overallGlobalAtten(float dist) {
    return 1.0 / (1.0 + dist * 0.006);
}

vec3 overallNoisePos(vec3 worldPos) {
    return worldPos / overallWaveLen() + vec3(uOverallTime * uOverallWaveSpeed * 0.35);
}

vec3 normalizeVec3(vec3 v, vec3 fallback) {
    float len = length(v);
    return len > 1e-5 ? v / len : fallback;
}

vec3 g_offset;
float g_height;

void evalTravelingWaveLine(vec3 rel) {
    float waveLen = overallWaveLen();
    float atten = overallGlobalAtten(length(rel));

    vec3 travel = normalizeVec3(uOverallWaveDirection, vec3(0.0, 0.0, 1.0));
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 lateral = cross(travel, up);
    if (dot(lateral, lateral) < 1e-6) {
        lateral = cross(travel, vec3(0.0, 0.0, 1.0));
    }
    lateral = normalizeVec3(lateral, vec3(1.0, 0.0, 0.0));

    float along = dot(rel, travel);
    float cross = dot(rel, lateral);
    float propagate = 1.6 + uOverallWaveSpeed * 1.2;

    vec3 np = vec3(along / waveLen, cross / waveLen * 1.1, uOverallTime * uOverallWaveSpeed * 0.14);
    vec3 nA = noise3(np) * 2.0 - 1.0;
    vec3 nB = noise3(np * 2.4 + vec3(5.3, 1.7, uOverallTime * 0.09)) * 2.0 - 1.0;
    vec3 nC = noise3(np * 5.1 - vec3(2.0, 9.0, uOverallTime * 0.11)) * 2.0 - 1.0;

    float crestBend = (nA.x * 0.5 + nB.y * 0.32 + nC.x * 0.22) * waveLen * 0.55;
    float phaseAlong = (along + crestBend - uOverallTime * propagate) / waveLen * TAU;

    float phaseJit = (nA.y + nB.x * 0.65 + nC.y * 0.4) * 2.2;
    float surgeSin = sin(phaseAlong + phaseJit) * (0.6 + nB.z * 0.28);
    float surgeNoise = (noise3(vec3(cross / waveLen * 1.2, phaseAlong * 0.12, uOverallTime * 0.17 + np.z)).x - 0.5) * 1.35;
    float surge = surgeSin * 0.55 + surgeNoise * 0.45;
    float wobble = (noise3(vec3(cross / waveLen * 0.5 + nC.z, along / waveLen * 0.3, uOverallTime * 0.2)).y - 0.5) * 0.45;

    float h = (surge + wobble * 0.35) * atten;
    g_height = h;
    g_offset = travel * h;
}

void applyOverallWaveLighting(inout vec4 color) {
    float crest = max(g_height, 0.0);
    float trough = max(-g_height, 0.0);
    float hi = smoothstep(0.02, 0.28, crest);
    float lo = smoothstep(0.02, 0.28, trough);
    float darkAmt = clamp(uOverallIntensity * lo * 1.1, 0.0, 2.5);
    float hiAmt = clamp(uOverallIntensity * hi * 1.35, 0.0, 2.5);
    color.rgb = mix(color.rgb, color.rgb * uOverallTroughTint, darkAmt);
    color.rgb = mix(color.rgb, color.rgb * uOverallCrestTint, hiAmt);
}

void evalNoiseStyle(vec3 center) {
    vec3 rel = center - uOverallCenter;
    float typ = floor(uOverallNoiseType + 0.5);

    g_offset = vec3(0.0);
    g_height = 0.0;

    if (typ < 0.5) {
        float atten = overallGlobalAtten(length(rel));
        vec3 p = overallNoisePos(center);
        vec3 n = noise3(p) * 2.0 - 1.0;
        vec3 n2 = noise3(p * 1.7 + vec3(3.1)) * 2.0 - 1.0;
        g_offset = (n * 0.65 + n2 * 0.35) * atten;
        g_height = dot(g_offset, vec3(0.0, 1.0, 0.0));
    } else {
        evalTravelingWaveLine(rel);
    }
}

void modifySplatCenter(inout vec3 center) {
    evalNoiseStyle(center);
    center += g_offset * uOverallWaveAmplitude;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
    evalNoiseStyle(center);
    applyOverallWaveLighting(color);
}
`;

export const overallWaveShaderWgsl = /* wgsl */`
uniform uOverallTime: f32;
uniform uOverallCenter: vec3f;
uniform uOverallIntensity: f32;
uniform uOverallWaveAmplitude: f32;
uniform uOverallWaveFrequency: f32;
uniform uOverallWaveSpeed: f32;
uniform uOverallNoiseType: f32;
uniform uOverallWaveDirection: vec3f;
uniform uOverallCrestTint: vec3f;
uniform uOverallTroughTint: vec3f;

fn overallHash2(p: vec3f) -> vec3f {
    var p2 = fract(p * 0.3183099 + 0.1);
    p2 *= 17.0;
    return fract(vec3f(
        p2.x * p2.y * p2.z,
        p2.x + p2.y * p2.z,
        p2.x * p2.y + p2.z
    ));
}

fn noise3(p: vec3f) -> vec3f {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let n000 = overallHash2(i + vec3f(0.0, 0.0, 0.0));
    let n100 = overallHash2(i + vec3f(1.0, 0.0, 0.0));
    let n010 = overallHash2(i + vec3f(0.0, 1.0, 0.0));
    let n110 = overallHash2(i + vec3f(1.0, 1.0, 0.0));
    let n001 = overallHash2(i + vec3f(0.0, 0.0, 1.0));
    let n101 = overallHash2(i + vec3f(1.0, 0.0, 1.0));
    let n011 = overallHash2(i + vec3f(0.0, 1.0, 1.0));
    let n111 = overallHash2(i + vec3f(1.0, 1.0, 1.0));
    let x0 = mix(n000, n100, f.x);
    let x1 = mix(n010, n110, f.x);
    let x2 = mix(n001, n101, f.x);
    let x3 = mix(n011, n111, f.x);
    let y0 = mix(x0, x1, f.y);
    let y1 = mix(x2, x3, f.y);
    return mix(y0, y1, f.z);
}

fn overallWaveLen() -> f32 {
    return 1.0 / max(uniform.uOverallWaveFrequency, 0.02);
}

fn overallGlobalAtten(dist: f32) -> f32 {
    return 1.0 / (1.0 + dist * 0.006);
}

fn overallNoisePos(worldPos: vec3f) -> vec3f {
    return worldPos / overallWaveLen() + vec3f(uniform.uOverallTime * uniform.uOverallWaveSpeed * 0.35);
}

fn normalizeVec3(v: vec3f, fallback: vec3f) -> vec3f {
    let len = length(v);
    if (len > 1e-5) {
        return v / len;
    }
    return fallback;
}

const TAU: f32 = 6.28318530718;

var<private> g_offset: vec3f;
var<private> g_height: f32;

fn evalTravelingWaveLine(rel: vec3f) {
    let waveLen = overallWaveLen();
    let atten = overallGlobalAtten(length(rel));

    let travel = normalizeVec3(uniform.uOverallWaveDirection, vec3f(0.0, 0.0, 1.0));
    let up = vec3f(0.0, 1.0, 0.0);
    var lateral = cross(travel, up);
    if (dot(lateral, lateral) < 1e-6) {
        lateral = cross(travel, vec3f(0.0, 0.0, 1.0));
    }
    lateral = normalizeVec3(lateral, vec3f(1.0, 0.0, 0.0));

    let along = dot(rel, travel);
    let cross = dot(rel, lateral);
    let propagate = 1.6 + uniform.uOverallWaveSpeed * 1.2;

    let np = vec3f(along / waveLen, cross / waveLen * 1.1, uniform.uOverallTime * uniform.uOverallWaveSpeed * 0.14);
    let nA = noise3(np) * 2.0 - 1.0;
    let nB = noise3(np * 2.4 + vec3f(5.3, 1.7, uniform.uOverallTime * 0.09)) * 2.0 - 1.0;
    let nC = noise3(np * 5.1 - vec3f(2.0, 9.0, uniform.uOverallTime * 0.11)) * 2.0 - 1.0;

    let crestBend = (nA.x * 0.5 + nB.y * 0.32 + nC.x * 0.22) * waveLen * 0.55;
    let phaseAlong = (along + crestBend - uniform.uOverallTime * propagate) / waveLen * TAU;

    let phaseJit = (nA.y + nB.x * 0.65 + nC.y * 0.4) * 2.2;
    let surgeSin = sin(phaseAlong + phaseJit) * (0.6 + nB.z * 0.28);
    let surgeNoise = (noise3(vec3f(cross / waveLen * 1.2, phaseAlong * 0.12, uniform.uOverallTime * 0.17 + np.z)).x - 0.5) * 1.35;
    let surge = surgeSin * 0.55 + surgeNoise * 0.45;
    let wobble = (noise3(vec3f(cross / waveLen * 0.5 + nC.z, along / waveLen * 0.3, uniform.uOverallTime * 0.2)).y - 0.5) * 0.45;

    let h = (surge + wobble * 0.35) * atten;
    g_height = h;
    g_offset = travel * h;
}

fn applyOverallWaveLighting(color: ptr<function, vec4f>) {
    let crest = max(g_height, 0.0);
    let trough = max(-g_height, 0.0);
    let hi = smoothstep(0.02, 0.28, crest);
    let lo = smoothstep(0.02, 0.28, trough);
    let darkAmt = clamp(uniform.uOverallIntensity * lo * 1.1, 0.0, 2.5);
    let hiAmt = clamp(uniform.uOverallIntensity * hi * 1.35, 0.0, 2.5);
    var rgb = (*color).rgb;
    rgb = mix(rgb, rgb * uniform.uOverallTroughTint, darkAmt);
    rgb = mix(rgb, rgb * uniform.uOverallCrestTint, hiAmt);
    (*color) = vec4f(rgb, (*color).a);
}

fn evalNoiseStyle(center: vec3f) {
    let rel = center - uniform.uOverallCenter;

    g_offset = vec3f(0.0);
    g_height = 0.0;

    let typ = i32(floor(uniform.uOverallNoiseType + 0.5));
    switch typ {
        case 0: {
            let atten = overallGlobalAtten(length(rel));
            let p = overallNoisePos(center);
            let n = noise3(p) * 2.0 - 1.0;
            let n2 = noise3(p * 1.7 + vec3f(3.1)) * 2.0 - 1.0;
            g_offset = (n * 0.65 + n2 * 0.35) * atten;
            g_height = dot(g_offset, vec3f(0.0, 1.0, 0.0));
        }
        default: {
            evalTravelingWaveLine(rel);
        }
    }
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    evalNoiseStyle(*center);
    *center = *center + g_offset * uniform.uOverallWaveAmplitude;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    evalNoiseStyle(center);
    applyOverallWaveLighting(color);
}
`;
