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
uniform vec3 uLightTint;

varying float vPhase;
varying vec2 vCorner;

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
    gl_FragColor = vec4(uLightTint * intensity, intensity);
}
`;
