import { ExperienceSettings as V1, AnimTrack as AnimTrackV1 } from './schemas/v1';
import { ExperienceSettings as V2, AnimTrack as AnimTrackV2, TransformFrame } from './schemas/v2';
import { Vec3 } from 'playcanvas';

const migrateV1 = (settings: V1): V1 => {
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

    return settings;
};

const migrateAnimTrackV2 = (animTrackV1: AnimTrackV1, fov: number): AnimTrackV2 => {
    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: animTrackV1.keyframes.times,
            values: {
                position: animTrackV1.keyframes.values.position,
                target: animTrackV1.keyframes.values.target,
                fov: new Array(animTrackV1.keyframes.times.length).fill(fov)
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
                intensity: 1,
                blurLevel: 2
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
            }
        },
        animTracks: v1.animTracks.map((animTrackV1: AnimTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || 60);
        }),
        cameras: [{
            initial: {
                position: (v1.camera.position || [0, 0, 5]) as [number, number, number],
                target: (v1.camera.target || [0, 0, 0]) as [number, number, number],
                fov: v1.camera.fov || 65
            }
        }],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default',
        hasStartPose: !!(v1.camera.position && v1.camera.target),
        revealEffect: {}
    };
};

// Convert 3x3 rotation matrix to target point
const rotationMatrixToTarget = (position: [number, number, number], rotation: [[number, number, number], [number, number, number], [number, number, number]]): [number, number, number] => {
    // Extract viewing direction from the third row (camera's Z-axis in world space)
    // Flip X and Y components to match coordinate system
    const forward = new Vec3(-rotation[2][0], -rotation[2][1], rotation[2][2]);
    
    // Calculate target point at a reasonable distance
    const targetDistance = 3;
    const pos = new Vec3(position[0], position[1], position[2]);
    const target = pos.clone().add(forward.mulScalar(targetDistance));
    
    return [target.x, target.y, target.z];
};

// Calculate FOV from focal length and image dimensions
const focalLengthToFov = (fx: number, width: number): number => {
    // FOV = 2 * atan(width / (2 * fx)) * (180 / PI)
    return 2 * Math.atan(width / (2 * fx)) * (180 / Math.PI);
};

// Migrate transform format to V2 with animTracks
const migrateTransformToV2 = (transforms: TransformFrame[]): V2 => {
    if (!transforms || transforms.length === 0) {
        throw new Error('Transform array is empty');
    }
    
    // Use first frame for initial camera pose
    const firstFrame = transforms[0];
    const originalTarget = rotationMatrixToTarget(firstFrame.position, firstFrame.rotation);
    
    // Flip X and Y axes to match coordinate system
    const initialPosition: [number, number, number] = [-firstFrame.position[0], -firstFrame.position[1], firstFrame.position[2]];
    const initialTarget: [number, number, number] = [-originalTarget[0], -originalTarget[1], originalTarget[2]];
    const initialFov = focalLengthToFov(firstFrame.fx, firstFrame.width);
    
    // Build keyframes from all transforms
    // Check if frames have frame_duration field
    const hasFrameDuration = firstFrame.frame_duration !== undefined;
    const frameRate = 30; // Use fixed frame rate for time calculations
    
    const times: number[] = [];
    const positions: number[] = [];
    const targets: number[] = [];
    const fovs: number[] = [];
    
    let cumulativeTime = 0;
    
    transforms.forEach((frame, index) => {
        // Calculate time for this keyframe
        if (hasFrameDuration) {
            // For frame_duration: accumulate time in seconds, then convert to frame units
            const timeInFrames = cumulativeTime * frameRate;
            times.push(timeInFrames);
            
            // Debug: log first few frames and frames with different durations
            if (index < 10 || (index > 0 && Math.abs(frame.frame_duration - transforms[index-1].frame_duration) > 0.01)) {
                console.log(`Frame ${index}: time=${cumulativeTime.toFixed(3)}s (${timeInFrames.toFixed(2)} frames), duration=${frame.frame_duration}s`);
            }
            
            // Add current frame's duration for next iteration
            cumulativeTime += frame.frame_duration;
        } else {
            // Use frame index for fixed frame rate
            times.push(index);
        }
        
        // Position - flip X and Y axes to match coordinate system
        positions.push(-frame.position[0], -frame.position[1], frame.position[2]);
        
        // Target (calculated from rotation matrix) - also flip X and Y axes
        const target = rotationMatrixToTarget(frame.position, frame.rotation);
        targets.push(-target[0], -target[1], target[2]);
        
        // FOV (calculated from focal length)
        const fov = focalLengthToFov(frame.fx, frame.width);
        fovs.push(fov);
        
        if (index === 0) {
            console.log(`=== Transform Migration ===`);
            console.log('Has frame_duration:', hasFrameDuration);
            console.log('Frame rate:', frameRate);
        }
    });
    
    // Calculate total duration
    let duration: number;
    if (hasFrameDuration) {
        // Sum all frame durations
        duration = transforms.reduce((sum, frame) => sum + (frame.frame_duration || 0), 0);
        console.log(`Total duration: ${duration.toFixed(3)}s (${(duration * frameRate).toFixed(2)} frames)`);
        console.log(`Last keyframe time: ${times[times.length - 1].toFixed(2)} frames`);
    } else {
        // Use frame count and frame rate
        duration = (transforms.length - 1) / frameRate;
    }
    
    return {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: [0, 0, 0]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 1,
                blurLevel: 2
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
            }
        },
        animTracks: [{
            name: 'Camera Path',
            duration: duration,
            frameRate: frameRate,
            loopMode: 'repeat',
            interpolation: 'spline',
            smoothness: 0.3,  // 降低平滑度以更好地体现速度变化：0 = 线性，1 = 最平滑
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
        annotations: [],
        startMode: 'animTrack',
        hasStartPose: true,
        revealEffect: {
            type: 'smooth',
            autoStart: true
        }
    };
};

// import a json object to conform to the latest settings schema. settings is assumed to be one of the well-formed schemas
const importSettings = (settings: any): V2 => {
    let result: V2;

    // Check if it's a transform array format
    if (Array.isArray(settings) && settings.length > 0 && settings[0].rotation && settings[0].position) {
        // Transform format -> v2
        result = migrateTransformToV2(settings as TransformFrame[]);
    } else {
        const version = settings.version;
        if (version === undefined) {
            // v1 -> v2
            result = migrateV2(migrateV1(settings as V1));
        } else if (version === 2) {
            // already v2
            result = settings as V2;
        } else {
            throw new Error(`Unsupported experience settings version: ${version}`);
        }
    }

    return result;
};

// export the latest/current schema types
export type { AnimTrack, Camera, Annotation, PostEffectSettings, RevealEffect, TransformFrame, ExperienceSettings } from './schemas/v2';

export { importSettings };
