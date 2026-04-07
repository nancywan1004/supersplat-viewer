import { Script, Color, Entity, Vec3, Mat4 } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';
import { collectPointLights, collectSpotLights } from '../../light';
import type { Texture } from 'playcanvas';

/**
 * 调亮/调暗原理（Shader 内 modifySplatColor）：
 * - 线性空间：result = linearColor * mult，再 gamma 写回。
 * - 调暗 (f < 0)：mult = mix(1, nightColor, -f)。nightColor = 环境光 + 点光 + 聚光贡献，乘数 < 1；主光不参与此计算。
 * - 调亮 (f > 0)：mult = baseBright * (1 + dirContrib)。baseBright = mix(1, uBrightFactor, f) 整体提亮；
 *   dirContrib = NdotL * uLightColor 为平行光方向性（视线方向近似 splat 朝向，面向光更亮）。
 * TS 侧：主光强度 = settings 基准 × (1 + nightFade)；天空球强度与 fade 同向；Bloom 由 settings 统一控制，调亮/调暗都使用同一强度。
 */
const shaderGLSL = /* glsl */`
uniform vec3 uSpherePositions[10];
uniform vec3 uSphereColors[10];
uniform vec3 uSpotPositions[10];
uniform vec3 uSpotDirections[10];
uniform vec3 uSpotColors[10];
uniform vec4 uSpotParams[10];  // x=innerConeRad, y=outerConeRad, z=range, w=enabled
uniform float uNightFade;
uniform float uBrightFactor;
uniform vec3 uNightAmbient;
uniform mat4 uModelMatrix;
uniform vec3 uCameraPos;
uniform vec3 uLightDir; // direction of directional light
uniform vec3 uLightColor; // color of directional light
uniform sampler2D uCommittedBrightnessVolume; // 64×4096 2D 图集，体素 (ix,iy,iz) -> (ix+0.5)/64, (iy+iz*64+0.5)/4096
uniform vec3 uCommittedAabbMin;
uniform vec3 uCommittedAabbMax;
uniform float uCommittedBrightness;
uniform float uCommittedVolumeEncodedBrightness; // 1 = volume stores effective brightness (0~1 = -1~1), 0 = mask * uniform
uniform vec3 uLocalLightTintColor;   // sRGB，单区域/回退用
uniform float uLocalLightTintBlend;
uniform sampler2D uCommittedTintVolume;  // per-voxel 颜色调制 RGBA，多区域时每区域只影响自己体素
uniform float uCommittedTintVolumeActive; // 1 = 使用纹理，0 = 使用 uniform

vec3 l2g(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 g2l(vec3 c) { return pow(c, vec3(2.2)); }

void modifySplatCenter(inout vec3 center) {
    // Night mode doesn't modify center position
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    // Night mode doesn't modify rotation/scale
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec4 worldPos = uModelMatrix * vec4(center, 1.0);
    worldPos /= worldPos.w;
    vec3 wpos = worldPos.xyz;

    // 已提交区域：3D 体积纹理一次采样，无点数上限
    float inCommittedLit = 0.0;
    vec2 committedUV = vec2(0.0);
    if (uCommittedVolumeEncodedBrightness > 0.5) {
        vec3 size = max(uCommittedAabbMax - uCommittedAabbMin, vec3(1e-6));
        vec3 n = clamp((wpos - uCommittedAabbMin) / size, 0.0, 1.0);
        float ix = floor(n.x * 64.0); float iy = floor(n.y * 64.0); float iz = floor(n.z * 64.0);
        ix = min(ix, 63.0); iy = min(iy, 63.0); iz = min(iz, 63.0);
        float u = (ix + 0.5) / 64.0;
        float v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2(u, v);
        float encoded = texture2D(uCommittedBrightnessVolume, committedUV).r;
        if (encoded > 0.002) {
            float effectiveBrightness = encoded * 2.0 - 1.0;
            color.rgb *= 1.0 + effectiveBrightness;
            inCommittedLit = 1.0;
        }
    } else if (abs(uCommittedBrightness) > 1e-6) {
        vec3 size = max(uCommittedAabbMax - uCommittedAabbMin, vec3(1e-6));
        vec3 n = clamp((wpos - uCommittedAabbMin) / size, 0.0, 1.0);
        float ix = floor(n.x * 64.0); float iy = floor(n.y * 64.0); float iz = floor(n.z * 64.0);
        ix = min(ix, 63.0); iy = min(iy, 63.0); iz = min(iz, 63.0);
        float u = (ix + 0.5) / 64.0;
        float v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2(u, v);
        float committedMask = texture2D(uCommittedBrightnessVolume, committedUV).r;
        color.rgb *= 1.0 + uCommittedBrightness * committedMask;
        if (committedMask > 0.002) inCommittedLit = 1.0;
    }
    if (inCommittedLit > 0.5) {
        vec3 tintCol = uLocalLightTintColor;
        float blend = uLocalLightTintBlend;
        if (uCommittedTintVolumeActive > 0.5) {
            vec4 tintSample = texture2D(uCommittedTintVolume, committedUV);
            tintCol = tintSample.rgb;
            blend = tintSample.a;
        }
        if (blend > 1e-6) {
            vec3 linear = g2l(color.rgb);
            linear *= mix(vec3(1.0), g2l(tintCol), blend);
            color.rgb = l2g(linear);
        }
    }

    float f = uNightFade;
    if (abs(f) < 1e-6) {
        return;
    }

    vec3 sum = vec3(0.0);
    for (int i = 0; i < 10; ++i) {
        vec3 pos = uSpherePositions[i];
        vec3 clr = uSphereColors[i];
        if (length(pos) > 0.001) {
            float dist = length(pos - wpos);
            if (dist > 0.001) {
                sum += g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (int i = 0; i < 10; ++i) {
        if (uSpotParams[i].w < 0.5) continue;
        vec3 spotPos = uSpotPositions[i];
        vec3 spotDir = uSpotDirections[i];
        vec3 spotClr = uSpotColors[i];
        float range = uSpotParams[i].z;
        float innerCos = cos(uSpotParams[i].x);
        float outerCos = cos(uSpotParams[i].y);
        float cosOuter = min(innerCos, outerCos);
        float cosInner = max(innerCos, outerCos);
        vec3 toPoint = wpos - spotPos;
        float dist = length(toPoint);
        if (dist >= range || dist < 0.001) continue;
        vec3 L = toPoint / dist;
        float cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) continue;
        float spotAtt = (cosTheta >= cosInner) ? 1.0 : smoothstep(cosOuter, cosInner, cosTheta);
        sum += g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
    }

    vec3 linearColor = g2l(color.rgb);
    vec3 nightColor = g2l(uNightAmbient) + sum;
    vec3 viewDir = normalize(uCameraPos - wpos);
    float NdotL = max(0.0, dot(viewDir, uLightDir));
    vec3 dirContrib = NdotL * uLightColor;
    vec3 mult;
    if (f > 0.0) {
        // 调亮：所有光源（环境光+点光+聚光+平行光）统一参与
        vec3 baseBright = mix(vec3(1.0), vec3(uBrightFactor), f);
        mult = baseBright * (vec3(1.0) + sum + dirContrib);
    } else {
        // 调暗：同样让平行光参与，不再与调亮分支做“光源参与”差异化
        mult = mix(vec3(1.0), nightColor + dirContrib, -f);
    }
    color.rgb = l2g(linearColor * mult);
}
`;

// Night Mode + Bloom Brush 合成：涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode
const shaderGLSLBloomBrush = /* glsl */`
uniform vec3 uSpherePositions[10];
uniform vec3 uSphereColors[10];
uniform vec3 uSpotPositions[10];
uniform vec3 uSpotDirections[10];
uniform vec3 uSpotColors[10];
uniform vec4 uSpotParams[10];
uniform float uNightFade;
uniform float uBrightFactor;
uniform vec3 uNightAmbient;
uniform mat4 uModelMatrix;
uniform vec3 uCameraPos;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform mat4 uModelViewProj;
uniform sampler2D uBloomMask;
uniform float uBloomThreshold;
uniform float uBloomBrushActive;
uniform float uBloomBrushLocalBrightness;
uniform sampler2D uCommittedBrightnessVolume;
uniform vec3 uCommittedAabbMin;
uniform vec3 uCommittedAabbMax;
uniform float uCommittedBrightness;
uniform float uCommittedVolumeEncodedBrightness;
uniform vec3 uLocalLightTintColor;
uniform float uLocalLightTintBlend;
uniform sampler2D uCommittedTintVolume;
uniform float uCommittedTintVolumeActive;

vec3 l2g(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 g2l(vec3 c) { return pow(c, vec3(2.2)); }

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec4 worldPos = uModelMatrix * vec4(center, 1.0);
    worldPos /= worldPos.w;
    vec3 wpos = worldPos.xyz;

    // 已提交区域：3D 体积纹理一次采样
    float committedMask = 0.0;
    vec2 committedUV = vec2(0.0);
    if (uCommittedVolumeEncodedBrightness > 0.5) {
        vec3 size = max(uCommittedAabbMax - uCommittedAabbMin, vec3(1e-6));
        vec3 n = clamp((wpos - uCommittedAabbMin) / size, 0.0, 1.0);
        float ix = floor(n.x * 64.0); float iy = floor(n.y * 64.0); float iz = floor(n.z * 64.0);
        ix = min(ix, 63.0); iy = min(iy, 63.0); iz = min(iz, 63.0);
        float u = (ix + 0.5) / 64.0;
        float v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2(u, v);
        float encoded = texture2D(uCommittedBrightnessVolume, committedUV).r;
        if (encoded > 0.002) {
            float effectiveBrightness = encoded * 2.0 - 1.0;
            color.rgb *= 1.0 + effectiveBrightness;
            committedMask = 1.0;
        }
    } else if (abs(uCommittedBrightness) > 1e-6) {
        vec3 size = max(uCommittedAabbMax - uCommittedAabbMin, vec3(1e-6));
        vec3 n = clamp((wpos - uCommittedAabbMin) / size, 0.0, 1.0);
        float ix = floor(n.x * 64.0); float iy = floor(n.y * 64.0); float iz = floor(n.z * 64.0);
        ix = min(ix, 63.0); iy = min(iy, 63.0); iz = min(iz, 63.0);
        float u = (ix + 0.5) / 64.0;
        float v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2(u, v);
        committedMask = texture2D(uCommittedBrightnessVolume, committedUV).r;
        color.rgb *= 1.0 + uCommittedBrightness * committedMask;
    }
    if (committedMask > 0.5) {
        vec3 tintCol = uLocalLightTintColor;
        float blend = uLocalLightTintBlend;
        if (uCommittedTintVolumeActive > 0.5) {
            vec4 tintSample = texture2D(uCommittedTintVolume, committedUV);
            tintCol = tintSample.rgb;
            blend = tintSample.a;
        }
        if (blend > 1e-6) {
            vec3 linear = g2l(color.rgb);
            linear *= mix(vec3(1.0), g2l(tintCol), blend);
            color.rgb = l2g(linear);
        }
    }

    // 笔刷区域：仅对「明确未提交」区域应用实时预览亮度；committedMask>=0.2 视为已提交，避免体积边缘重复乘算
    if (uBloomBrushActive > 0.5) {
        vec4 clipPos = uModelViewProj * vec4(center, 1.0);
        vec3 ndc = clipPos.xyz / clipPos.w;
        vec2 uv = ndc.xy * 0.5 + 0.5;
        if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            float maskVal = texture2D(uBloomMask, uv).r;
            float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (maskVal > 0.5 && lum >= uBloomThreshold) {
                if (committedMask < 0.2) {
                    color.rgb *= 1.0 + uBloomBrushLocalBrightness;
                }
            }
        }
    }

    float f = uNightFade;
    if (abs(f) < 1e-6) {
        return;
    }

    vec3 sum = vec3(0.0);
    for (int i = 0; i < 10; ++i) {
        vec3 pos = uSpherePositions[i];
        vec3 clr = uSphereColors[i];
        if (length(pos) > 0.001) {
            float dist = length(pos - wpos);
            if (dist > 0.001) {
                sum += g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (int i = 0; i < 10; ++i) {
        if (uSpotParams[i].w < 0.5) continue;
        vec3 spotPos = uSpotPositions[i];
        vec3 spotDir = uSpotDirections[i];
        vec3 spotClr = uSpotColors[i];
        float range = uSpotParams[i].z;
        float innerCos = cos(uSpotParams[i].x);
        float outerCos = cos(uSpotParams[i].y);
        float cosOuter = min(innerCos, outerCos);
        float cosInner = max(innerCos, outerCos);
        vec3 toPoint = wpos - spotPos;
        float dist = length(toPoint);
        if (dist >= range || dist < 0.001) continue;
        vec3 L = toPoint / dist;
        float cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) continue;
        float spotAtt = (cosTheta >= cosInner) ? 1.0 : smoothstep(cosOuter, cosInner, cosTheta);
        sum += g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
    }

    vec3 linearColor = g2l(color.rgb);
    vec3 nightColor = g2l(uNightAmbient) + sum;
    vec3 viewDir = normalize(uCameraPos - wpos);
    float NdotL = max(0.0, dot(viewDir, uLightDir));
    vec3 dirContrib = NdotL * uLightColor;
    vec3 mult;
    if (f >= 0.0) {
        // 调亮：所有光源（环境光+点光+聚光+平行光）统一参与
        vec3 baseBright = mix(vec3(1.0), vec3(uBrightFactor), f);
        mult = baseBright * (vec3(1.0) + sum + dirContrib);
    } else {
        // 调暗：同样让平行光参与，不再与调亮分支做“光源参与”差异化
        mult = mix(vec3(1.0), nightColor + dirContrib, -f);
    }
    color.rgb = l2g(linearColor * mult);
}
`;

const shaderWGSL = /* wgsl */`
uniform uSpherePositions: array<vec3f, 10>;
uniform uSphereColors: array<vec3f, 10>;
uniform uSpotPositions: array<vec3f, 10>;
uniform uSpotDirections: array<vec3f, 10>;
uniform uSpotColors: array<vec3f, 10>;
uniform uSpotParams: array<vec4f, 10>;
uniform uNightFade: f32;
uniform uBrightFactor: f32;
uniform uNightAmbient: vec3f;
uniform uModelMatrix: mat4x4f;
uniform uCameraPos: vec3f;
uniform uLightDir: vec3f;
uniform uLightColor: vec3f;
var uCommittedBrightnessVolume: texture_2d<f32>;
var uCommittedBrightnessVolumeSampler: sampler;
uniform uCommittedAabbMin: vec3f;
uniform uCommittedAabbMax: vec3f;
uniform uCommittedBrightness: f32;
uniform uCommittedVolumeEncodedBrightness: f32;
uniform uLocalLightTintColor: vec3f;
uniform uLocalLightTintBlend: f32;
var uCommittedTintVolume: texture_2d<f32>;
var uCommittedTintVolumeSampler: sampler;
uniform uCommittedTintVolumeActive: f32;

fn l2g(c: vec3f) -> vec3f { return pow(c, vec3f(1.0 / 2.2)); }
fn g2l(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let worldPos = uniform.uModelMatrix * vec4f(center, 1.0);
    let wpos = worldPos.xyz / worldPos.w;

    var inCommittedLit = 0.0;
    var committedUV = vec2f(0.0, 0.0);
    if (uniform.uCommittedVolumeEncodedBrightness > 0.5) {
        let size = max(uniform.uCommittedAabbMax - uniform.uCommittedAabbMin, vec3f(1e-6));
        let n = clamp((wpos - uniform.uCommittedAabbMin) / size, vec3f(0.0), vec3f(1.0));
        let ix = min(floor(n.x * 64.0), 63.0);
        let iy = min(floor(n.y * 64.0), 63.0);
        let iz = min(floor(n.z * 64.0), 63.0);
        let u = (ix + 0.5) / 64.0;
        let v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2f(u, v);
        let encoded = textureSample(uCommittedBrightnessVolume, uCommittedBrightnessVolumeSampler, committedUV).r;
        if (encoded > 0.002) {
            let effectiveBrightness = encoded * 2.0 - 1.0;
            (*color).rgb *= 1.0 + effectiveBrightness;
            inCommittedLit = 1.0;
        }
    } else if (abs(uniform.uCommittedBrightness) > 1e-6) {
        let size = max(uniform.uCommittedAabbMax - uniform.uCommittedAabbMin, vec3f(1e-6));
        let n = clamp((wpos - uniform.uCommittedAabbMin) / size, vec3f(0.0), vec3f(1.0));
        let ix = min(floor(n.x * 64.0), 63.0);
        let iy = min(floor(n.y * 64.0), 63.0);
        let iz = min(floor(n.z * 64.0), 63.0);
        let u = (ix + 0.5) / 64.0;
        let v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2f(u, v);
        let committedMask = textureSample(uCommittedBrightnessVolume, uCommittedBrightnessVolumeSampler, committedUV).r;
        (*color).rgb *= 1.0 + uniform.uCommittedBrightness * committedMask;
        if (committedMask > 0.002) { inCommittedLit = 1.0; }
    }
    if (inCommittedLit > 0.5) {
        var tintCol = uniform.uLocalLightTintColor;
        var blend = uniform.uLocalLightTintBlend;
        if (uniform.uCommittedTintVolumeActive > 0.5) {
            let tintSample = textureSample(uCommittedTintVolume, uCommittedTintVolumeSampler, committedUV);
            tintCol = tintSample.rgb;
            blend = tintSample.a;
        }
        if (blend > 1e-6) {
            var linear = g2l((*color).rgb);
            linear *= mix(vec3f(1.0), g2l(tintCol), blend);
            (*color).rgb = l2g(linear);
        }
    }

    let f = uniform.uNightFade;
    if (abs(f) < 1e-6) {
        return;
    }

    var sum = vec3f(0.0);
    for (var i = 0u; i < 10u; i++) {
        let pos = uniform.uSpherePositions[i];
        let clr = uniform.uSphereColors[i];
        if (length(pos) > 0.001) {
            let dist = length(pos - wpos);
            if (dist > 0.001) {
                sum = sum + g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (var i = 0u; i < 10u; i++) {
        if (uniform.uSpotParams[i].w < 0.5) { continue; }
        let spotPos = uniform.uSpotPositions[i];
        let spotDir = uniform.uSpotDirections[i];
        let spotClr = uniform.uSpotColors[i];
        let range = uniform.uSpotParams[i].z;
        let innerCos = cos(uniform.uSpotParams[i].x);
        let outerCos = cos(uniform.uSpotParams[i].y);
        let cosOuter = min(innerCos, outerCos);
        let cosInner = max(innerCos, outerCos);
        let toPoint = wpos - spotPos;
        let dist = length(toPoint);
        if (dist >= range || dist < 0.001) { continue; }
        let L = toPoint / dist;
        let cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) { continue; }
        var spotAtt = 1.0;
        if (cosTheta < cosInner) {
            spotAtt = smoothstep(cosOuter, cosInner, cosTheta);
        }
        sum = sum + g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
    }

    let linearColor = g2l((*color).rgb);
    let nightColor = g2l(uniform.uNightAmbient) + sum;
    let viewDir = normalize(uniform.uCameraPos - wpos);
    let NdotL = max(0.0, dot(viewDir, uniform.uLightDir));
    let dirContrib = NdotL * uniform.uLightColor;
    var mult: vec3f;
    if (f >= 0.0) {
        // 调亮：所有光源（环境光+点光+聚光+平行光）统一参与
        let baseBright = mix(vec3f(1.0), vec3f(uniform.uBrightFactor), f);
        mult = baseBright * (vec3f(1.0) + sum + dirContrib);
    } else {
        // 调暗：同样让平行光参与，不再与调亮分支做“光源参与”差异化
        mult = mix(vec3f(1.0), nightColor + dirContrib, -f);
    }
    (*color).rgb = l2g(linearColor * mult);
}
`;

// Night Mode + Bloom Brush 合成：涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode
const shaderWGSLBloomBrush = /* wgsl */`
uniform uSpherePositions: array<vec3f, 10>;
uniform uSphereColors: array<vec3f, 10>;
uniform uSpotPositions: array<vec3f, 10>;
uniform uSpotDirections: array<vec3f, 10>;
uniform uSpotColors: array<vec3f, 10>;
uniform uSpotParams: array<vec4f, 10>;
uniform uNightFade: f32;
uniform uBrightFactor: f32;
uniform uNightAmbient: vec3f;
uniform uModelMatrix: mat4x4f;
uniform uCameraPos: vec3f;
uniform uLightDir: vec3f;
uniform uLightColor: vec3f;
uniform uModelViewProj: mat4x4f;
var uBloomMask: texture_2d<f32>;
var uBloomMaskSampler: sampler;
uniform uBloomThreshold: f32;
uniform uBloomBrushActive: f32;
uniform uBloomBrushLocalBrightness: f32;
var uCommittedBrightnessVolume: texture_2d<f32>;
var uCommittedBrightnessVolumeSampler: sampler;
uniform uCommittedAabbMin: vec3f;
uniform uCommittedAabbMax: vec3f;
uniform uCommittedBrightness: f32;
uniform uCommittedVolumeEncodedBrightness: f32;
uniform uLocalLightTintColor: vec3f;
uniform uLocalLightTintBlend: f32;
var uCommittedTintVolume: texture_2d<f32>;
var uCommittedTintVolumeSampler: sampler;
uniform uCommittedTintVolumeActive: f32;

fn l2g(c: vec3f) -> vec3f { return pow(c, vec3f(1.0 / 2.2)); }
fn g2l(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let worldPos = uniform.uModelMatrix * vec4f(center, 1.0);
    let wpos = worldPos.xyz / worldPos.w;

    var committedMask = 0.0;
    var committedUV = vec2f(0.0, 0.0);
    if (uniform.uCommittedVolumeEncodedBrightness > 0.5) {
        let size = max(uniform.uCommittedAabbMax - uniform.uCommittedAabbMin, vec3f(1e-6));
        let n = clamp((wpos - uniform.uCommittedAabbMin) / size, vec3f(0.0), vec3f(1.0));
        let ix = min(floor(n.x * 64.0), 63.0);
        let iy = min(floor(n.y * 64.0), 63.0);
        let iz = min(floor(n.z * 64.0), 63.0);
        let u = (ix + 0.5) / 64.0;
        let v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2f(u, v);
        let encoded = textureSample(uCommittedBrightnessVolume, uCommittedBrightnessVolumeSampler, committedUV).r;
        if (encoded > 0.002) {
            let effectiveBrightness = encoded * 2.0 - 1.0;
            (*color).rgb *= 1.0 + effectiveBrightness;
            committedMask = 1.0;
        }
    } else if (abs(uniform.uCommittedBrightness) > 1e-6) {
        let size = max(uniform.uCommittedAabbMax - uniform.uCommittedAabbMin, vec3f(1e-6));
        let n = clamp((wpos - uniform.uCommittedAabbMin) / size, vec3f(0.0), vec3f(1.0));
        let ix = min(floor(n.x * 64.0), 63.0);
        let iy = min(floor(n.y * 64.0), 63.0);
        let iz = min(floor(n.z * 64.0), 63.0);
        let u = (ix + 0.5) / 64.0;
        let v = (iy + iz * 64.0 + 0.5) / 4096.0;
        committedUV = vec2f(u, v);
        committedMask = textureSample(uCommittedBrightnessVolume, uCommittedBrightnessVolumeSampler, committedUV).r;
        (*color).rgb *= 1.0 + uniform.uCommittedBrightness * committedMask;
    }
    if (committedMask > 0.5) {
        var tintCol = uniform.uLocalLightTintColor;
        var blend = uniform.uLocalLightTintBlend;
        if (uniform.uCommittedTintVolumeActive > 0.5) {
            let tintSample = textureSample(uCommittedTintVolume, uCommittedTintVolumeSampler, committedUV);
            tintCol = tintSample.rgb;
            blend = tintSample.a;
        }
        if (blend > 1e-6) {
            var linear = g2l((*color).rgb);
            linear *= mix(vec3f(1.0), g2l(tintCol), blend);
            (*color).rgb = l2g(linear);
        }
    }

    // 笔刷区域：仅对「明确未提交」区域应用实时预览亮度；committedMask>=0.2 视为已提交，避免体积边缘重复乘算
    if (uniform.uBloomBrushActive > 0.5) {
        let clipPos = uniform.uModelViewProj * vec4f(center, 1.0);
        let ndc = clipPos.xyz / clipPos.w;
        let uv = ndc.xy * 0.5 + 0.5;
        if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            let maskVal = textureSample(uBloomMask, uBloomMaskSampler, uv).r;
            let lum = dot((*color).rgb, vec3f(0.2126, 0.7152, 0.0722));
            if (maskVal > 0.5 && lum >= uniform.uBloomThreshold) {
                if (committedMask < 0.2) {
                    (*color).rgb *= 1.0 + uniform.uBloomBrushLocalBrightness;
                }
            }
        }
    }

    let f = uniform.uNightFade;
    if (abs(f) < 1e-6) {
        return;
    }

    var sum = vec3f(0.0);
    for (var i = 0u; i < 10u; i++) {
        let pos = uniform.uSpherePositions[i];
        let clr = uniform.uSphereColors[i];
        if (length(pos) > 0.001) {
            let dist = length(pos - wpos);
            if (dist > 0.001) {
                sum = sum + g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (var i = 0u; i < 10u; i++) {
        if (uniform.uSpotParams[i].w < 0.5) { continue; }
        let spotPos = uniform.uSpotPositions[i];
        let spotDir = uniform.uSpotDirections[i];
        let spotClr = uniform.uSpotColors[i];
        let range = uniform.uSpotParams[i].z;
        let innerCos = cos(uniform.uSpotParams[i].x);
        let outerCos = cos(uniform.uSpotParams[i].y);
        let cosOuter = min(innerCos, outerCos);
        let cosInner = max(innerCos, outerCos);
        let toPoint = wpos - spotPos;
        let dist = length(toPoint);
        if (dist >= range || dist < 0.001) { continue; }
        let L = toPoint / dist;
        let cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) { continue; }
        var spotAtt = 1.0;
        if (cosTheta < cosInner) {
            spotAtt = smoothstep(cosOuter, cosInner, cosTheta);
        }
        sum = sum + g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
    }

    let linearColor = g2l((*color).rgb);
    let nightColor = g2l(uniform.uNightAmbient) + sum;
    let viewDir = normalize(uniform.uCameraPos - wpos);
    let NdotL = max(0.0, dot(viewDir, uniform.uLightDir));
    let dirContrib = NdotL * uniform.uLightColor;
    var mult: vec3f;
    if (f > 0.0) {
        // 调亮：所有光源（环境光+点光+聚光+平行光）统一参与
        let baseBright = mix(vec3f(1.0), vec3f(uniform.uBrightFactor), f);
        mult = baseBright * (vec3f(1.0) + sum + dirContrib);
    } else {
        // 调暗：同样让平行光参与，不再与调亮分支做“光源参与”差异化
        mult = mix(vec3f(1.0), nightColor + dirContrib, -f);
    }
    (*color).rgb = l2g(linearColor * mult);
}
`;

/**
 * Night mode effect for gaussian splats.
 * Creates a night mode lighting effect with ambient lighting and sphere-based lighting.
 * 
 * @example
 * // Add the script to root entity
 * app.root.addComponent('script');
 * const nightModeScript = app.root.script.create(NightMode);
 * nightModeScript.light = lightEntity;
 * nightModeScript.camera = cameraEntity;
 * nightModeScript.splat = gsplatEntity;
 */
class NightMode extends GsplatShaderEffect {
    static scriptName = 'nightMode';

    /**
     * Light entity to control intensity
     * @attribute
     * @type {Entity | null}
     */
    light: Entity | null = null;

    /**
     * Camera entity for bloom effects
     * @attribute
     * @type {Entity | null}
     */
    camera: Entity | null = null;

    /**
     * Gsplat entity to apply night mode to
     * @attribute
     * @type {Entity | null}
     */
    splat: Entity | null = null;

    /** Bloom Brush 合成：开启时涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode */
    bloomBrushActive: boolean = false;
    bloomBrushMask: Texture | null = null;
    bloomBrushThreshold: number = 0.2;
    /** 笔刷区域局部亮度 -1～1，0 不变；由 setBloomBrushParams 传入 */
    bloomBrushLocalBrightness: number = 0;
    private _bloomBrushModelViewProj: Mat4 = new Mat4();

    /** 已提交亮度：3D 体积烘焙纹理 + AABB + 乘数，由 BloomController 通过 setCommittedBrightnessVolume 传入 */
    private committedVolumeTexture: Texture | null = null;
    private committedVolumeAabbMin: Vec3 = new Vec3(0, 0, 0);
    private committedVolumeAabbMax: Vec3 = new Vec3(1, 1, 1);
    private committedBrightness: number = 0;
    /** 为 true 时体积纹理存储的是编码后的有效亮度 (0~1 = -1~1)，shader 直接解码应用；否则为 mask × uCommittedBrightness */
    private committedVolumeEncodedBrightness: boolean = false;
    /** 局部亮灯区域颜色调制（sRGB [0,1]），单区域/回退用；由 BloomController 通过 setCommittedTint 传入 */
    private localLightTintColor: [number, number, number] = [1, 1, 1];
    /** 局部亮灯区域颜色混合系数 0～1 */
    private localLightTintBlend: number = 0;
    /** per-voxel 颜色调制纹理（多区域时每区域只影响自己体素），null 时用 uniform */
    private committedTintVolumeTexture: Texture | null = null;

    /**
     * Night ambient color
     * @attribute
     * @type {Color}
     */
    nightAmbient: Color = new Color(0, 0, 0);

    /**
     * Emissive intensity for spheres
     * @attribute
     */
    emissiveIntensity: number = 10;

    /**
     * Lighting intensity for spheres
     * @attribute
     */
    lightingIntensity: number = 1.23;

    /**
     * Emissive bloom intensity
     * @attribute
     */
    emissiveBloom: number = 0.05;

    /**
     * Brighten multiplier when fade > 0 (max brighten factor)
     * @attribute
     */
    brightFactor: number = 1.4;

    /**
     * Directional light contribution scale when brightening (fade > 0). 0 = no dir light in shader.
     * @attribute
     */
    dirLightScale: number = 0.4;

    private nightFade: number = 0;
    /** 上次已 fire 的 nightFade，用于仅在 fade 变化时触发事件 */
    private _lastFiredNightFade: number | null = null;
    private manualFadeControl: boolean = true; // Slider-only control, no auto animation
    /** Reveal/VFX 互斥接管期间：禁止 NightMode 往 gsplatModifyVS 写入，避免与 VFX shader 冲突 */
    private suspendedByVfx: boolean = false;

    private fireNightFadeChanged(source: 'set' | 'exit' | 'request' | 'applyFromSettings' | 'forceReapply') {
        // 唯一事件：带来源信息（确定性区分 exit vs set）
        this.app.fire('nightFade:changedDetailed', { value: this.nightFade, source });
    }

    initialize() {
        // Override initialization to work with external gsplat entity
        this.initialized = false;
        this.effectTime = 0;
        this.materialsApplied.clear();
        this.nightFade = 0;

        // Listen for nightFade set event from UI slider (always allowed, no toggle)
        this.app.on('nightFade:set', (value: number) => {
            const clampedValue = Math.max(-1, Math.min(1, value));
            this.manualFadeControl = true;
            this.nightFade = clampedValue;
            // VFX 期间仅记录与广播，不往材质写 shader（避免覆盖 VFX）
            if (!this.suspendedByVfx) {
                if (Math.abs(this.nightFade) > 1e-6 && this.materialsApplied.size === 0 && this.splat?.gsplat) {
                    this.applyShaders();
                }
                if (this.materialsApplied.size > 0) {
                    this.updateEffect(this.effectTime, 0);
                }
            }
            this.fireNightFadeChanged('set');
        });

        this.on('enable', () => {
            this.effectTime = 0;
            if (this.splat?.gsplat) {
                this.initialized = true;
                if (Math.abs(this.nightFade) > 1e-6 && this.materialsApplied.size === 0) {
                    this.applyShaders();
                }
            } else {
                this.shadersNeedApplication = true;
            }
        });

        this.on('disable', () => {
        });

        // 监听 reveal 等互斥效果接管 gsplatModifyVS 的信号：重置亮度为 0 并清空 shader 应用
        this.app.on('nightMode:exit', () => {
            // 进入互斥阶段：完全挂起 NightMode 对 gsplatModifyVS 的写入
            this.suspendedByVfx = true;
            this.nightFade = 0;
            this.manualFadeControl = true;
            this.materialsApplied.clear();
            // 同时清掉局部亮灯/笔刷的 shader 需求，避免 updateEffect 重新 apply
            this.bloomBrushActive = false;
            this.bloomBrushMask = null;
            this.committedVolumeTexture = null;
            this.committedBrightness = 0;
            this.committedVolumeEncodedBrightness = false;
            this.committedTintVolumeTexture = null;
            this.fireNightFadeChanged('exit');
        });

        if (this.splat?.gsplat) {
            this.initialized = true;
            if (this.enabled && Math.abs(this.nightFade) > 1e-6 && this.materialsApplied.size === 0) {
                this.applyShaders();
            }
        }

        this.app.on('nightFade:request', () => {
            this.fireNightFadeChanged('request');
        });

        // VFX 播放结束后，其 GsplatShaderEffect.disable 会从材质上删掉 gsplatModifyVS，
        // 但 NightMode 的 materialsApplied 并不知情，导致后续 nightFade:set 只更新 uniform 而不重新 apply shader。
        // nightMode:forceReapply 先移除已应用的 shader、清空 materialsApplied，再设 fade 并重新 apply，保证材质上有正确的 shader。
        this.app.on('nightMode:forceReapply', (value: number) => {
            const clampedValue = Math.max(-1, Math.min(1, value));
            this.manualFadeControl = true;
            this.nightFade = clampedValue;
            // 关键：先真正从 materials 上移除 shader（与 disable 时一致），否则残留 gsplatModifyVS 会持续影响渲染
            this.removeShaders();
            // forceReapply 代表“互斥结束，允许恢复 NightMode”
            this.suspendedByVfx = false;
            // |fade|>0 时重新 apply shader；|fade|≈0 时保持移除状态（主光/天空盒仍会被 updateEffect 复位）
            if (Math.abs(this.nightFade) > 1e-6 && this.splat?.gsplat) {
                this.applyShaders();
            }
            // 必须始终执行：把主光/天空盒强度按新的 nightFade 收回/调整，否则 discard 后场景仍像未复位
            this.updateEffect(this.effectTime, 0);
            this.fireNightFadeChanged('forceReapply');
        });
    }

    applyShaders() {
        if (!this.splat?.gsplat) {
            console.warn('NightMode: splat entity not available');
            return;
        }

        if (this.splat.gsplat.unified) {
            this.applyToUnifiedMaterials();
        } else {
            this.applyToComponentMaterial();
        }
    }

    applyToComponentMaterial() {
        const material = this.splat?.gsplat?.material;
        if (!material) {
            // Wait for material to be available
            this.splat?.gsplat?.once('load', () => {
                const mat = this.splat?.gsplat?.material;
                if (mat) {
                    this.applyShaderToMaterial(mat);
                    this.materialsApplied.add(mat);
                }
            });
            return;
        }
        this.applyShaderToMaterial(material);
        this.materialsApplied.add(material);
    }

    applyToUnifiedMaterials() {
        this.updateUnifiedMaterials();
        if (this.materialsApplied.size === 0) {
            this.needsRetry = true;
        }
    }

    updateUnifiedMaterials() {
        if (!this.splat?.gsplat) return;

        // @ts-ignore - gsplat system exists at runtime
        const gsplatSystem = this.app.systems.gsplat;
        const scene = this.app.scene;
        const composition = scene.layers;

        const componentLayers = this.splat.gsplat.layers;
        if (!componentLayers) return;

        let targetCameras;
        if (this.camera && this.camera.camera) {
            // this.camera = Entity, this.camera.camera = CameraComponent
            // this.camera.camera.camera = Camera 实例（内部渲染对象）
            // getGSplatMaterial() 需要 Camera 实例作为 key，传 CameraComponent 会查找失败
            targetCameras = [this.camera.camera.camera];
        } else {
            targetCameras = composition.cameras.map(cameraComponent => cameraComponent.camera);
        }

        targetCameras.forEach((camera) => {
            componentLayers.forEach((layerId) => {
                if (camera.layers.indexOf(layerId) >= 0) {
                    const layer = composition.getLayerById(layerId);
                    if (layer) {
                        const material = gsplatSystem.getGSplatMaterial(camera as any, layer);
                        if (material && !this.materialsApplied.has(material)) {
                            this.applyShaderToMaterial(material);
                            this.materialsApplied.add(material);
                        }
                    }
                }
            });
        });

        if (this.materialsApplied.size > 0) {
            this.needsRetry = false;
        }
    }

    getShaderGLSL() {
        return this.bloomBrushActive ? shaderGLSLBloomBrush : shaderGLSL;
    }

    getShaderWGSL() {
        return this.bloomBrushActive ? shaderWGSLBloomBrush : shaderWGSL;
    }

    /** 设置 Bloom Brush 合成参数；当 active 变更时会重新应用 shader */
    setBloomBrushParams(active: boolean, mask: Texture | null, threshold: number, modelViewProj?: Float32Array, localBrightness?: number) {
        const prevActive = this.bloomBrushActive;
        this.bloomBrushActive = active;
        this.bloomBrushMask = mask;
        this.bloomBrushThreshold = Math.max(0, Math.min(5, threshold));
        this.bloomBrushLocalBrightness = typeof localBrightness === 'number' ? Math.max(-1, Math.min(1, localBrightness)) : 0;
        if (modelViewProj) {
            this._bloomBrushModelViewProj.data.set(modelViewProj);
        }
        if (prevActive !== active && this.materialsApplied.size > 0) {
            this.removeShaders();
            this.applyShaders();
        }
    }

    /** 已废弃：请使用 setCommittedBrightnessVolume。保留仅为兼容。 */
    setCommittedBrightnessRegions(_points: Array<{ position: Vec3; radius: number }>, _brightness: number) {
        // no-op，由 BloomController 统一走 setCommittedBrightnessVolume
    }

    /** 设置已提交亮度体积纹理与 AABB（由 BloomController 在 Set/加载/apply 时调用）。options.volumeEncodedBrightness 为 true 表示多区域叠加烘焙，体积存的是有效亮度。 */
    setCommittedBrightnessVolume(
        volumeTexture: Texture | null,
        aabbMin: Vec3,
        aabbMax: Vec3,
        brightness: number,
        options?: { volumeEncodedBrightness?: boolean }
    ) {
        this.committedVolumeTexture = volumeTexture;
        this.committedVolumeAabbMin.copy(aabbMin);
        this.committedVolumeAabbMax.copy(aabbMax);
        this.committedBrightness = Math.max(-1, Math.min(1, brightness));
        this.committedVolumeEncodedBrightness = !!options?.volumeEncodedBrightness;
        if (this.materialsApplied.size > 0) {
            this.setCommittedUniforms();
        }
    }

    /** 设置局部亮灯区域颜色调制（单区域/回退，由 BloomController 传入）。 */
    setCommittedTint(tintColor: [number, number, number], tintBlend: number) {
        this.localLightTintColor = [
            Math.max(0, Math.min(1, tintColor[0] ?? 1)),
            Math.max(0, Math.min(1, tintColor[1] ?? 1)),
            Math.max(0, Math.min(1, tintColor[2] ?? 1))
        ];
        this.localLightTintBlend = Math.max(0, Math.min(1, tintBlend));
        if (this.materialsApplied.size > 0) {
            this.setCommittedUniforms();
        }
    }

    /** 设置 per-voxel 颜色调制纹理（多区域时每区域只影响自己体素）；null 时使用 uniform。 */
    setCommittedTintVolume(tintVolumeTexture: Texture | null) {
        this.committedTintVolumeTexture = tintVolumeTexture;
        if (this.materialsApplied.size > 0) {
            this.setCommittedUniforms();
        }
    }

    private setCommittedUniforms(): void {
        if (this.committedVolumeTexture) {
            this.setUniform('uCommittedBrightnessVolume', this.committedVolumeTexture);
        }
        this.setUniform('uCommittedAabbMin', [this.committedVolumeAabbMin.x, this.committedVolumeAabbMin.y, this.committedVolumeAabbMin.z]);
        this.setUniform('uCommittedAabbMax', [this.committedVolumeAabbMax.x, this.committedVolumeAabbMax.y, this.committedVolumeAabbMax.z]);
        this.setUniform('uCommittedBrightness', this.committedBrightness);
        this.setUniform('uCommittedVolumeEncodedBrightness', this.committedVolumeEncodedBrightness ? 1 : 0);
        this.setUniform('uLocalLightTintColor', this.localLightTintColor);
        this.setUniform('uLocalLightTintBlend', this.localLightTintBlend);
        if (this.committedTintVolumeTexture) {
            this.setUniform('uCommittedTintVolume', this.committedTintVolumeTexture);
            this.setUniform('uCommittedTintVolumeActive', 1);
        } else {
            this.setUniform('uCommittedTintVolumeActive', 0);
        }
    }

    update(dt: number) {
        // Override update to handle initialization and material retry
        if (!this.initialized) {
            if (this.splat?.gsplat) {
                this.initialized = true;
                if (this.enabled && this.shadersNeedApplication) {
                    this.applyShaders();
                    this.shadersNeedApplication = false;
                }
            }
            return;
        }

        if (this.shadersNeedApplication) {
            this.applyShaders();
            this.shadersNeedApplication = false;
        }

        if (this.splat?.gsplat?.unified && this.needsRetry) {
            this.updateUnifiedMaterials();
        }

        // Always update effect time and effect state, even if shaders are not applied
        // This ensures nightFade, light intensity, and skybox intensity are properly updated
        this.effectTime += dt;
        this.updateEffect(this.effectTime, dt);

        // Request render if enabled and materials are applied, or if we're transitioning
        if (this.enabled && this.materialsApplied.size > 0) {
            this.app.renderNextFrame = true;
        } else if (Math.abs(this.nightFade) > 1e-6) {
            // Also request render during fade transitions even if shaders are not applied
            this.app.renderNextFrame = true;
        }
    }

    updateEffect(effectTime: number, dt: number) {
        // Reveal/VFX 互斥期：确保 NightMode 不会重新 apply shader 覆盖 VFX
        if (this.suspendedByVfx) {
            if (this.materialsApplied.size > 0) {
                this.materialsApplied.clear();
                this.app.renderNextFrame = true;
            }
            return;
        }
        const needShader = Math.abs(this.nightFade) > 1e-6
            || (this.committedVolumeTexture != null && (this.committedVolumeEncodedBrightness || Math.abs(this.committedBrightness) > 1e-6))
            || this.bloomBrushActive;
        if (!needShader && this.materialsApplied.size > 0) {
            this.materialsApplied.clear();
            this.app.renderNextFrame = true;
        }

        if (needShader && this.materialsApplied.size === 0 && this.splat?.gsplat) {
            this.applyShaders();
        }

        // 从场景中的 Light 实体收集点光源与聚光灯，上限各 10 个（供高斯 night mode 打光）
        const global = (this.app as any).__global;
        const pointLights = global ? collectPointLights(global) : [];
        const spotLights = global ? collectSpotLights(global) : [];
        const positions: number[] = [];
        const colors: number[] = [];
        const scale = this.lightingIntensity;
        for (let i = 0; i < 10; ++i) {
            const pl = pointLights[i];
            if (!pl) {
                positions.push(0, 0, 0);
                colors.push(0, 0, 0);
            } else {
                positions.push(pl.position.x, pl.position.y, pl.position.z);
                colors.push(
                    pl.color.r * pl.intensity * scale,
                    pl.color.g * pl.intensity * scale,
                    pl.color.b * pl.intensity * scale
                );
            }
        }

        const spotPositions: number[] = [];
        const spotDirections: number[] = [];
        const spotColors: number[] = [];
        const spotParams: number[] = [];
        for (let i = 0; i < 10; ++i) {
            const sl = spotLights[i];
            if (!sl) {
                spotPositions.push(0, 0, 0);
                spotDirections.push(0, 0, -1);
                spotColors.push(0, 0, 0);
                spotParams.push(0, 0, 0, 0);
            } else {
                spotPositions.push(sl.position.x, sl.position.y, sl.position.z);
                spotDirections.push(sl.direction.x, sl.direction.y, sl.direction.z);
                spotColors.push(
                    sl.color.r * sl.intensity * scale,
                    sl.color.g * sl.intensity * scale,
                    sl.color.b * sl.intensity * scale
                );
                spotParams.push(sl.innerConeAngle, sl.outerConeAngle, sl.range, 1);
            }
        }

        // ── 关键：根据 unified 模式选择 uModelMatrix ──
        // modifySplatColor(vec3 center, …) 中用 uModelMatrix * center 来算世界位置。
        //   - unified=false: engine 传 model-space center → 需要 model→world 变换
        //   - unified=true:  engine 传 world-space center → 不需要变换（用单位矩阵）
        const isUnified = this.splat?.gsplat?.unified ?? false;
        let modelMatrix: number[] = [];
        if (isUnified) {
            // unified: center 已是 world space，不再变换
            modelMatrix = [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ];
        } else if (this.splat) {
            const worldTransform = this.splat.getWorldTransform();
            // Convert Mat4 to array (column-major order for GLSL)
            modelMatrix = [
                worldTransform.data[0], worldTransform.data[4], worldTransform.data[8], worldTransform.data[12],
                worldTransform.data[1], worldTransform.data[5], worldTransform.data[9], worldTransform.data[13],
                worldTransform.data[2], worldTransform.data[6], worldTransform.data[10], worldTransform.data[14],
                worldTransform.data[3], worldTransform.data[7], worldTransform.data[11], worldTransform.data[15]
            ];
        } else {
            // Identity matrix as fallback
            modelMatrix = [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ];
        }

        // Update uniforms on all applied materials (only if shaders are applied)
        if (this.materialsApplied.size > 0) {
            this.setUniform('uSpherePositions[0]', positions);
            this.setUniform('uSphereColors[0]', colors);
            this.setUniform('uSpotPositions[0]', spotPositions);
            this.setUniform('uSpotDirections[0]', spotDirections);
            this.setUniform('uSpotColors[0]', spotColors);
            this.setUniform('uSpotParams[0]', spotParams);
            this.setUniform('uNightFade', this.nightFade);
            this.setUniform('uBrightFactor', this.brightFactor);
            this.setUniform('uNightAmbient', [
                this.nightAmbient.r,
                this.nightAmbient.g,
                this.nightAmbient.b
            ]);
            this.setUniform('uModelMatrix', modelMatrix);
            // 无论 fade 正负，统一传入平行光与相机位置，保证所有光源都参与计算
            const camPos = this.camera?.getPosition();
            if (camPos) {
                this.setUniform('uCameraPos', [camPos.x, camPos.y, camPos.z]);
            } else {
                this.setUniform('uCameraPos', [0, 0, 0]);
            }
            if (this.light?.light && (this.light.light as any).type === 'directional' && this.dirLightScale > 0) {
                const wt = this.light.getWorldTransform();
                const data = wt.data;
                const yx = data[1], yy = data[5], yz = data[9];
                const len = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1;
                this.setUniform('uLightDir', [yx / len, yy / len, yz / len]);
                const c = this.light.light.color;
                const intensity = this.light.light.intensity ?? 1;
                const lin = (x: number) => Math.pow(x, 2.2);
                const scale = this.dirLightScale * intensity;
                this.setUniform('uLightColor', [
                    lin(c.r) * scale,
                    lin(c.g) * scale,
                    lin(c.b) * scale
                ]);
            } else {
                this.setUniform('uLightDir', [0, 1, 0]);
                this.setUniform('uLightColor', [0, 0, 0]);
            }
            if (this.bloomBrushActive && this.bloomBrushMask && this.camera?.camera && this.splat) {
                const cam = this.camera.camera;
                if (isUnified) {
                    // unified: center 已是 world space → 只需 view * projection（不含 model）
                    this._bloomBrushModelViewProj.mul2(cam.projectionMatrix, cam.viewMatrix);
                } else {
                    // non-unified: center 是 model space → 需要 projection * view * model
                    this._bloomBrushModelViewProj.copy(cam.viewMatrix);
                    this._bloomBrushModelViewProj.mul2(this._bloomBrushModelViewProj, this.splat.getWorldTransform());
                    this._bloomBrushModelViewProj.mul2(cam.projectionMatrix, this._bloomBrushModelViewProj);
                }
                this.materialsApplied.forEach((material) => {
                    material.setParameter('uBloomMask', this.bloomBrushMask!);
                });
                this.setUniform('uBloomBrushActive', 1);
                this.setUniform('uBloomThreshold', this.bloomBrushThreshold);
                this.setUniform('uBloomBrushLocalBrightness', this.bloomBrushLocalBrightness);
                this.setUniform('uModelViewProj', this._bloomBrushModelViewProj.data);
            }
            this.setCommittedUniforms();
        }

        // ── 调亮/调暗联动（TS 侧）──
        // 主光：基准强度来自 settings，再乘 (1 + nightFade)。调亮时主光变强，调暗时变弱。
        // Bloom：统一由 settings 控制（configureCamera → applyToCameraFrame），调亮/调暗都使用同一套强度，不在此处改写。
        // 天空球与 fade 同向（调亮更亮、调暗更暗）。
        if (this.light?.light) {
            const global = (this.app as any).__global;
            const dirCfg = global?.settings?.lighting?.lights?.find((l: any) => l.type === 'directional');
            const baseIntensity = typeof dirCfg?.intensity === 'number' ? dirCfg.intensity : 1.5;
            const targetIntensity = Math.max(0.1, Math.min(4, baseIntensity * (1 + this.nightFade)));
            this.light.light.intensity = targetIntensity;
        }

        // Update skybox intensity: same direction as scene (fade > 0 brighten → brighter sky, fade < 0 darken → dimmer sky)
        const targetSkyboxIntensity = Math.max(0.2, Math.min(1.5, 1.0 + 0.8 * this.nightFade));
        this.app.scene.skyboxIntensity = targetSkyboxIntensity;

        // 仅在 fade 变化时 fire，避免每帧触发 configureCamera
        // 这里不再发旧的 nightFade:changed(number)，统一走 detailed 事件
        if (this._lastFiredNightFade !== this.nightFade) {
            this._lastFiredNightFade = this.nightFade;
            this.app.fire('nightFade', this.nightFade);
            this.fireNightFadeChanged('request');
        }

        // Always request render to ensure state changes are visible
        this.app.renderNextFrame = true;
    }

    /**
     * Set night fade (-1–1). Controls scene brightness directly (no toggle).
     */
    setNightFade(value: number) {
        const clamped = Math.max(-1, Math.min(1, value));
        this.manualFadeControl = true;
        this.nightFade = clamped;
        if (this.materialsApplied.size > 0) {
            this.updateEffect(this.effectTime, 0);
        }
        // setNightFade 是内部 API：明确标注为 set
        this.fireNightFadeChanged('set');
    }

    /**
     * Apply brightness from settings (e.g. after load). Accepts { fade?: number } or legacy { enabled: boolean; fade?: number }.
     */
    applyFromSettings(config: { enabled?: boolean; fade?: number }) {
        if (!config) return;
        this.manualFadeControl = true;
        // Legacy: enabled === false means "no effect"
        if (config.enabled === false) {
            this.nightFade = 0;
        } else {
            let fade: number;
            if (typeof config.fade === 'number' && Number.isFinite(config.fade)) {
                fade = Math.max(-1, Math.min(1, config.fade));
            } else {
                fade = !!config.enabled ? -0.95 : 0;
            }
            this.nightFade = fade;
        }
        if (Math.abs(this.nightFade) > 1e-6 && this.splat?.gsplat && this.materialsApplied.size === 0) {
            this.applyShaders();
        }
        if (this.materialsApplied.size > 0) {
            this.updateEffect(this.effectTime, 0);
        }
        this.fireNightFadeChanged('applyFromSettings');
    }

    /** Whether brightness effect is active (|fade| > 0), e.g. for Bloom Brush coupling */
    get isNightModeEnabled(): boolean {
        return Math.abs(this.nightFade) > 1e-6;
    }
}

export { NightMode };
