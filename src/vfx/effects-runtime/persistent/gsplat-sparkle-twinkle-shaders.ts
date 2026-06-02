export const shaderGLSL = /* glsl */`
attribute vec3 vertex_position;
attribute vec2 corner;
attribute float aPhase;

uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform vec3 uCameraPos;
uniform float uPointSize;
uniform float uViewBias;

varying float vPhase;
varying vec2 vCorner;

void main(void) {
    vec3 center = (matrix_model * vec4(vertex_position, 1.0)).xyz;
    vec3 toCam = uCameraPos - center;
    float len = length(toCam);
    vec3 viewDir = len > 1e-5 ? toCam / len : vec3(0.0, 0.0, 1.0);
    vec3 worldUp = abs(viewDir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(worldUp, viewDir));
    vec3 up = cross(viewDir, right);
    vec3 worldPos = center + (right * corner.x + up * corner.y) * uPointSize;
    if (len > 1e-5) {
        worldPos += (toCam / len) * uViewBias;
    }
    gl_Position = matrix_viewProjection * vec4(worldPos, 1.0);
    vPhase = aPhase;
    vCorner = corner;
}
`;

export const fragmentShaderGLSL = /* glsl */`
precision mediump float;

uniform float uTime;
uniform float uTwinkleSpeed;
uniform float uTwinkleMin;
uniform float uTwinkleSharpness;
uniform float uBrightness;
uniform vec3 uLightTint1;
uniform vec3 uLightTint2;
uniform vec3 uLightTint3;
uniform float uColorBlendMode;

varying float vPhase;
varying vec2 vCorner;

float sparkleColorPick(float cycleId, float phase) {
    return fract(sin(cycleId * 127.1 + phase * 311.7) * 43758.5453);
}

vec3 sparkleTintForPick(float pick) {
    if (pick < 0.333333) {
        return uLightTint1;
    }
    if (pick < 0.666666) {
        return uLightTint2;
    }
    return uLightTint3;
}

void main(void) {
    float soft = smoothstep(1.05, 0.15, length(vCorner));
    if (soft < 0.001) {
        discard;
    }
    float phase2 = vPhase * 1.73 + 2.1;
    float wave = sin(uTime * uTwinkleSpeed + vPhase);
    float wave2 = sin(uTime * uTwinkleSpeed * 1.37 + phase2);
    float combined = wave * 0.65 + wave2 * 0.35;
    float normalized = combined * 0.5 + 0.5;
    float sharp = pow(max(normalized, 0.0), max(uTwinkleSharpness, 0.01));
    float tw = uTwinkleMin + (1.0 - uTwinkleMin) * sharp;
    float intensity = tw * uBrightness * soft;
    float globalTwinkleCycle = floor(uTime * uTwinkleSpeed * 0.15915494);
    float perPointTwinkleCycle = floor((uTime * uTwinkleSpeed + vPhase) * 0.15915494);
    // 勾选颜色混合：每点独立随机色；未勾选：同一闪烁周期内全场景同色
    float cycleId = uColorBlendMode > 0.5 ? perPointTwinkleCycle : globalTwinkleCycle;
    float colorPhase = uColorBlendMode > 0.5 ? vPhase : 0.0;
    vec3 tint = sparkleTintForPick(sparkleColorPick(cycleId, colorPhase));
    gl_FragColor = vec4(tint * intensity, intensity);
}
`;
