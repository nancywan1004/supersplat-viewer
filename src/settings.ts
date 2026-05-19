import { ExperienceSettings as V1, AnimTrack as AnimTrackV1, validateV1 } from './schemas/v1';
import { ExperienceSettings as V2, AnimTrack as AnimTrackV2, TransformFrame, validateV2 } from './schemas/v2';
import {
    ensureBloom,
    ensureShadow,
    normalizeHoistBloomSessionFields,
    normalizeImportedAnnotation,
    normalizeBloomLocalLightRegions,
    normalizeBloomAfterImport
} from './settings-serialize/settings-serialize-helper';
import { Vec3 } from 'playcanvas';
import { assertObject } from './schemas/validate-utils';

type LegacyKeyframes = AnimTrackV1['keyframes'];

type KeyFrameItem = {
    times?: number; // 兼容typo
    time?: number;
    position?: number[];
    target?: number[];
};

const normalizeKeyframes = (keyframes: LegacyKeyframes | KeyFrameItem[]): LegacyKeyframes => {
    if (!Array.isArray(keyframes)) {
        return keyframes;
    }

    const times: number[] = [];
    const positions: number[] = [];
    const targets: number[] = [];

    keyframes.forEach((frame) => {
        if (!frame) {
            return;
        }

        const timeValue = typeof frame.times === 'number'
            ? frame.times
            : typeof (frame as any).time === 'number'
                ? (frame as any).time
                : times.length > 0
                    ? times[times.length - 1]
                    : 0;

        times.push(timeValue);

        // Only apply xy axis conversion for non-LegacyKeyFrame format
        // LegacyKeyFrame has 'times' as array or 'values' property, which means it's already processed
        // KeyFrameItem has 'times' as a single number (or 'time'), so check the type
        const isLegacyKeyFrame = Array.isArray((frame as any).times) || (frame as any).values !== undefined;

        if (!isLegacyKeyFrame) {
            if (Array.isArray(frame.position) && frame.position.length === 3) {
                // Flip X and Y axes to match coordinate system
                positions.push(-frame.position[0], -frame.position[1], frame.position[2]);
            }

            if (Array.isArray(frame.target) && frame.target.length === 3) {
                // Flip X and Y axes to match coordinate system
                targets.push(-frame.target[0], -frame.target[1], frame.target[2]);
            }
        } else {
            // LegacyKeyFrame format: position and target are already in the correct format
            if (Array.isArray(frame.position) && frame.position.length === 3) {
                positions.push(frame.position[0], frame.position[1], frame.position[2]);
            }

            if (Array.isArray(frame.target) && frame.target.length === 3) {
                targets.push(frame.target[0], frame.target[1], frame.target[2]);
            }
        }
    });

    return {
        times,
        values: {
            position: positions,
            target: targets
        }
    };
};

const migrateV1 = (settings: V1): V1 => {
    if (settings.animTracks) {
        settings.animTracks?.forEach((track: AnimTrackV1) => {
            // some early settings did not have frameRate set on anim tracks
            if (!track.frameRate) {
                const defaultFrameRate = 30;

                track.frameRate = defaultFrameRate;
                const times = track.keyframes.times;
                for (let i = 0; i < times.length; i++) {
                    times[i] *= defaultFrameRate;
                }
            }

            // smoothness property added in v1.4.0
            if (!track.hasOwnProperty('smoothness')) {
                track.smoothness = 0;
            }
        });
    } else {
        // some scenes were published without animTracks
        settings.animTracks = [];
    }

    return settings;
};

const migrateAnimTrackV2 = (animTrackV1: AnimTrackV1, fov: number): AnimTrackV2 => {
    const keyframes = normalizeKeyframes(animTrackV1.keyframes as any);

    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: keyframes.times,
            values: {
                position: keyframes.values.position,
                target: keyframes.values.target,
                fov: new Array(keyframes.times.length).fill(fov)
            }
        }
    };
};

const migrateV2 = (v1: V1): V2 => {
    return {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color as [number, number, number] || [0, 0, 0]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 0,
                blurLevel: 10,
                threshold: 0,
                bloomDebug: false,
                bloomScope: 'global',
                bloomBrushSize: 30,
                bloomBrushBrightness: 1
            },
            grading: {
                enabled: false,
                brightness: 0,
                contrast: 1,
                saturation: 1,
                tint: [1, 1, 1]
            },
            vignette: {
                enabled: false,
                intensity: 0.5,
                inner: 0.3,
                outer: 0.75,
                curvature: 1
            },
            fringing: {
                enabled: false,
                intensity: 0.5
            },
            shadow: {
                enabled: true,
                darken: 0,
                debugVisual: false,
                castShadows: false
            }
        },
        animTracks: v1.animTracks.map((animTrackV1: AnimTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || 60);
        }),
        cameras: (v1.camera.position && v1.camera.target) ? [{
            initial: {
                position: v1.camera.position as [number, number, number],
                target: v1.camera.target as [number, number, number],
                fov: v1.camera.fov || 75
            }
        }] : [],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default',
        hasStartPose: !!(v1.camera.position && v1.camera.target),
        revealEffect: {
            type: 'radial',
            autoStart: true
        }
    };
};

// Convert 3x3 rotation matrix to target point
const rotationMatrixToTarget = (position: [number, number, number], rotation: [[number, number, number], [number, number, number], [number, number, number]], distance: number = 3): [number, number, number] => {
    // Extract viewing direction from the third row (camera's Z-axis in world space)
    // Flip X and Y components to match coordinate system
    const forward = new Vec3(-rotation[2][0], -rotation[2][1], rotation[2][2]);
    
    // Calculate target point at a reasonable distance
    const pos = new Vec3(position[0], position[1], position[2]);
    const target = pos.clone().add(forward.mulScalar(distance));
    
    return [target.x, target.y, target.z];
};

/**
 * 计算相机水平和垂直 FOV
 * @param fx 水平焦距（像素）
 * @param fy 垂直焦距（像素）
 * @param width 图像宽度（像素）
 * @param height 图像高度（像素）
 * @returns [水平FOV, 垂直FOV]，单位：度
 */
function computeFOV(fx: number, fy: number, width: number, height: number): [number, number] {
    const fovX = 2 * Math.atan(width / (2 * fx)) * (180 / Math.PI);
    const fovY = 2 * Math.atan(height / (2 * fy)) * (180 / Math.PI);
    return [fovX, fovY];
}

// Migrate transform format to V2 with animTracks
const migrateTransformToV2 = (transforms: TransformFrame[], targetDistance: number = 3): V2 => {
    if (!transforms || transforms.length === 0) {
        throw new Error('Transform array is empty');
    }
    
    // Use first frame for initial camera pose
    const firstFrame = transforms[0];
    const originalTarget = rotationMatrixToTarget(firstFrame.position, firstFrame.rotation, targetDistance);
    
    // Flip X and Y axes to match coordinate system
    const initialPosition: [number, number, number] = [-firstFrame.position[0], -firstFrame.position[1], firstFrame.position[2]];
    const initialTarget: [number, number, number] = [-originalTarget[0], -originalTarget[1], originalTarget[2]];
    const initialFovs = computeFOV(firstFrame.fx, firstFrame.fy, firstFrame.width, firstFrame.height);
    const initialFov = initialFovs[1] // vertical fov
    
    // Build keyframes from all transforms
    const frameRate = 15;
    const times: number[] = [];
    const positions: number[] = [];
    const targets: number[] = [];
    const fovs: number[] = [];
    
    transforms.forEach((frame, index) => {
        times.push(index);
        
        // Position - flip X and Y axes to match coordinate system
        positions.push(-frame.position[0], -frame.position[1], frame.position[2]);
        
        // Target (calculated from rotation matrix) - also flip X and Y axes
        const target = rotationMatrixToTarget(frame.position, frame.rotation, targetDistance);
        targets.push(-target[0], -target[1], target[2]);
        
        // FOV (calculated from focal length)
        const fov_xy = computeFOV(frame.fx, frame.fy, frame.width, frame.height);
        const fov_y = fov_xy[1]
        fovs.push(fov_y);
        
        if (index === 0) {
            console.log(`=== Frame ${index} ===`);
            console.log('Original Position:', frame.position);
            console.log('Flipped Position:', [-frame.position[0], -frame.position[1], frame.position[2]]);
            console.log('Original Target:', target);
            console.log('Flipped Target:', [-target[0], -target[1], target[2]]);
        }
    });
    
    // Calculate duration based on number of frames and frame rate
    const duration = (transforms.length - 1) / frameRate;
    
    const result = {
        version: 2 as const,
        tonemapping: 'none' as const,
        highPrecisionRendering: false,
        background: {
            color: [0, 0, 0] as [number, number, number]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 0,
                blurLevel: 10,
                threshold: 0,
                bloomDebug: false,
                bloomScope: 'global' as const,
                bloomBrushSize: 30,
                bloomBrushBrightness: 1
            },
            grading: {
                enabled: false,
                brightness: 0,
                contrast: 1,
                saturation: 1,
                tint: [1, 1, 1] as [number, number, number]
            },
            vignette: {
                enabled: false,
                intensity: 0.5,
                inner: 0.3,
                outer: 0.75,
                curvature: 1
            },
            fringing: {
                enabled: false,
                intensity: 0.5
            },
            shadow: {
                darken: 0,
                debugVisual: false,
                castShadows: false
            }
        },
        animTracks: [{
            name: 'Camera Path',
            duration: duration,
            frameRate: frameRate,
            loopMode: 'repeat' as const,
            interpolation: 'spline' as const,
            smoothness: 1,  // 增加平滑度：0 = 线性，1 = 最平滑
            keyframes: {
                times: times,
                values: {
                    position: positions,
                    target: targets,
                    fov: fovs
                }
            }
        }],
        cameras: [{
            initial: {
                position: initialPosition,
                target: initialTarget,
                fov: initialFov
            }
        }],
        annotations: [] as V2['annotations'],
        startMode: 'animTrack' as const,
        hasStartPose: true,
        revealEffect: {
            type: 'radial' as const,
            autoStart: true
        }
    } as V2;
    ensureShadow(result);
    return result;
};


// import a json object to conform to the latest settings schema. settings is assumed to be one of the well-formed schemas
const importSettings = (settings: any): V2 => {
    let result: V2;

    // Check if it's a transform array format or object format with frames
    if (Array.isArray(settings) && settings.length > 0 && settings[0].rotation && settings[0].position) {
        // Transform array format -> v2 (backward compatible, uses default distance = 3)
        result = migrateTransformToV2(settings as TransformFrame[]);
    } else if (settings && typeof settings === 'object' && Array.isArray(settings.frames) && settings.frames.length > 0 && settings.frames[0].rotation && settings.frames[0].position) {
        // Transform object format with frames array -> v2 (supports optional targetDistance)
        const targetDistance = typeof settings.targetDistance === 'number' ? settings.targetDistance : 3;
        result = migrateTransformToV2(settings.frames as TransformFrame[], targetDistance);
    } else {
        const version = settings.version;
        if (version === undefined) {
            // v1 -> v2
            result = migrateV2(migrateV1(settings as V1));
        } else if (version === 2) {
            // already v2，保留并规范化 annotations
            result = settings as V2;
            if (!Array.isArray(result.annotations)) {
                result.annotations = [];
            } else {
                result.annotations = result.annotations.map((ann: any) => normalizeImportedAnnotation(ann)).filter(Boolean);
            }
        } else {
            throw new Error(`Unsupported experience settings version: ${version}`);
        }
    }

    if (result.postEffectSettings && typeof result.postEffectSettings === 'object') {
        normalizeHoistBloomSessionFields(result.postEffectSettings as any);
    }

    // 先保证 bloom / shadow 对象存在，再规范化区域与会话
    ensureBloom(result);
    ensureShadow(result);
    normalizeBloomAfterImport(result);
    normalizeBloomLocalLightRegions(result);

    return result;
};

// export the latest/current schema types
export type { AnimTrack, Camera, Annotation, PostEffectSettings, LegacyRevealEffect, TransformFrame, ExperienceSettings, EffectsSettings } from './schemas/v2';
// validate unknown data against any supported settings schema version, throwing on invalid input
const validateSettings = (settings: unknown): void => {
    const obj = assertObject(settings, 'settings');
    const version = obj.version;

    if (version === undefined) {
        validateV1(settings);
    } else if (version === 2) {
        validateV2(settings);
    } else if (typeof version !== 'number') {
        throw new Error(`settings.version must be a number, got ${typeof version}`);
    } else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
};

export { importSettings, validateSettings };
