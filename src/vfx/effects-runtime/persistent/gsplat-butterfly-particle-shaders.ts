export const shaderGLSL = /* glsl */`



attribute vec3 vertex_position;



attribute vec2 corner;



attribute float aPhase;



attribute float aColorMix;



attribute float aWeight;







uniform mat4 matrix_model;



uniform mat4 matrix_viewProjection;



uniform vec3 uCameraPos;



uniform float uPointSize;



uniform float uViewBias;







varying float vPhase;



varying vec2 vCorner;



varying float vColorMix;



varying float vWeight;







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



    vColorMix = aColorMix;



    vWeight = aWeight;



}



`;







export const fragmentShaderGLSL = /* glsl */`



precision mediump float;







uniform float uTime;



uniform float uTwinkleSpeed;



uniform float uTwinkleMin;



uniform float uTwinkleSharpness;



uniform float uBrightness;



uniform vec3 uColorA;



uniform vec3 uColorB;



uniform vec3 uColorC;



uniform float uColorCycle;



uniform float uColorCycleSpeed;



uniform float uTrailFade;



uniform float uTrailMode;







varying float vPhase;



varying vec2 vCorner;



varying float vColorMix;



varying float vWeight;







vec3 resolveBodyColor() {



    if (uColorCycle < 0.5) {



        return uColorA;



    }



    float t = fract(uTime * max(uColorCycleSpeed, 0.01));



    float seg = t * 3.0;



    if (seg < 1.0) {



        return mix(uColorA, uColorB, smoothstep(0.0, 1.0, seg));



    }



    if (seg < 2.0) {



        return mix(uColorB, uColorC, smoothstep(0.0, 1.0, seg - 1.0));



    }



    return mix(uColorC, uColorA, smoothstep(0.0, 1.0, seg - 2.0));



}







void main(void) {



    float soft = smoothstep(1.28, 0.04, length(vCorner));



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



    vec3 bodyColor = resolveBodyColor();



    float intensity = tw * uBrightness * soft * uTrailFade;



    if (uTrailMode > 0.5) {

        intensity *= smoothstep(0.0, 0.28, clamp(vWeight, 0.0, 1.0));

    }



    gl_FragColor = vec4(bodyColor * intensity, intensity);



}



`;


