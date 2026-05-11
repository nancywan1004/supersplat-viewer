import { Quat, Vec3 } from 'playcanvas';

import { CubicSpline } from '../core/spline';
import { vecToAngles } from '../core/math';
import { AnimTrack } from '../settings';
import { AnimCursor } from './anim-cursor';

const tmpDir = new Vec3();
const tmpAngles = new Vec3();
const tmpQuat = new Quat();

const normalizeAngleDeg = (angle: number) => {
    let result = angle % 360;
    if (result <= -180) result += 360;
    if (result > 180) result -= 360;
    return result;
};

const lerpAngleDeg = (a: number, b: number, t: number) => {
    const delta = normalizeAngleDeg(b - a);
    return normalizeAngleDeg(a + delta * t);
};

const directionToAngles = (dir: Vec3) => {
    vecToAngles(tmpAngles, dir);
    return { pitch: tmpAngles.x, yaw: tmpAngles.y };
};

const anglesToDirection = (yaw: number, pitch: number, result: Vec3) => {
    tmpQuat.setFromEulerAngles(pitch, yaw, 0).transformVector(Vec3.FORWARD, result).normalize();
};

// manage the state of a camera animation track
class AnimState {
    spline: CubicSpline;
    interpolation: 'step' | 'spline';
    times: number[];
    positions: number[];
    yaws: number[];
    pitches: number[];
    distances: number[];
    fovs: number[];
    durationFrames: number;
    lastKeyFrame: number;
    looping: boolean;
    loopFrames: number;
    defaultFov: number;

    cursor: AnimCursor = new AnimCursor(0, 'none');

    frameRate: number;

    result: number[] = [];

    position: Vec3 = new Vec3();

    target: Vec3 = new Vec3();

    constructor(
        spline: CubicSpline,
        interpolation: 'step' | 'spline',
        times: number[],
        positions: number[],
        yaws: number[],
        pitches: number[],
        distances: number[],
        fovs: number[],
        duration: number,
        loopMode: 'none' | 'repeat' | 'pingpong',
        frameRate: number,
        looping: boolean,
        loopFrames: number,
        defaultFov: number
    ) {
        this.spline = spline;
        this.interpolation = interpolation;
        this.times = times;
        this.positions = positions;
        this.yaws = yaws;
        this.pitches = pitches;
        this.distances = distances;
        this.fovs = fovs;
        this.durationFrames = duration * frameRate;
        this.lastKeyFrame = times.length > 0 ? times[times.length - 1] : 0;
        this.looping = looping;
        this.loopFrames = loopFrames;
        this.defaultFov = defaultFov;
        // repeat + 首尾接缝：周期 = 轨道 duration + fl_loopTimeSeconds，混合播完后再取模回到起点
        const cursorPeriodSec =
            duration + (looping && loopFrames > 0 ? loopFrames / frameRate : 0);
        this.cursor.reset(cursorPeriodSec, loopMode);
        this.frameRate = frameRate;
    }

    private applyPose(
        posX: number,
        posY: number,
        posZ: number,
        yaw: number,
        pitch: number,
        distance: number,
        fov: number
    ) {
        this.position.set(posX, posY, posZ);
        anglesToDirection(yaw, pitch, tmpDir);
        this.target.copy(this.position).add(tmpDir.mulScalar(Math.max(1e-4, distance)));
        this.result[6] = fov;
    }

    private setFromKey(index: number) {
        const posBase = index * 3;
        this.applyPose(
            this.positions[posBase],
            this.positions[posBase + 1],
            this.positions[posBase + 2],
            this.yaws[index],
            this.pitches[index],
            this.distances[index],
            this.fovs[index] ?? this.defaultFov
        );
    }

    private findSegment(frame: number) {
        const { times } = this;
        const lastIdx = times.length - 1;
        if (frame <= times[0]) return { seg: 0, t: 0 };
        if (frame >= times[lastIdx]) return { seg: Math.max(0, lastIdx - 1), t: 1 };

        let seg = 0;
        while (seg < lastIdx && times[seg + 1] <= frame) seg++;
        const t0 = times[seg];
        const t1 = times[seg + 1];
        const t = t1 > t0 ? (frame - t0) / (t1 - t0) : 1;
        return { seg, t };
    }

    // update given delta time
    update(dt: number) {
        const { cursor, result, spline, frameRate, times } = this;
        if (times.length === 0) return;

        // update the animation cursor
        cursor.update(dt);

        const frame = cursor.value * frameRate;
        const nearestFrame = Math.round(frame);
        const keyIdx = times.indexOf(nearestFrame);
        if (keyIdx !== -1 && Math.abs(frame - nearestFrame) < 1e-4) {
            this.setFromKey(keyIdx);
            return;
        }

        const playbackEnd = Math.min(this.durationFrames, this.lastKeyFrame + 1);
        const blendEnd = playbackEnd + this.loopFrames;
        const inBlend = this.looping && this.loopFrames > 0 && frame >= this.lastKeyFrame && frame < blendEnd;

        if (inBlend) {
            const lastIdx = times.length - 1;
            const blendLen = Math.max(1e-6, blendEnd - this.lastKeyFrame);
            const alpha = Math.max(0, Math.min(1, (frame - this.lastKeyFrame) / blendLen));
            const lastBase = lastIdx * 3;
            const firstBase = 0;
            const posX = this.positions[lastBase] + (this.positions[firstBase] - this.positions[lastBase]) * alpha;
            const posY = this.positions[lastBase + 1] + (this.positions[firstBase + 1] - this.positions[lastBase + 1]) * alpha;
            const posZ = this.positions[lastBase + 2] + (this.positions[firstBase + 2] - this.positions[lastBase + 2]) * alpha;
            const yaw = lerpAngleDeg(this.yaws[lastIdx], this.yaws[0], alpha);
            const pitch = lerpAngleDeg(this.pitches[lastIdx], this.pitches[0], alpha);
            const distance = this.distances[lastIdx] + (this.distances[0] - this.distances[lastIdx]) * alpha;
            const fov = (this.fovs[lastIdx] ?? this.defaultFov) + ((this.fovs[0] ?? this.defaultFov) - (this.fovs[lastIdx] ?? this.defaultFov)) * alpha;
            this.applyPose(posX, posY, posZ, yaw, pitch, distance, fov);
            return;
        }

        const extendedCycleFrames =
            this.durationFrames + (this.looping && this.loopFrames > 0 ? this.loopFrames : 0);
        if (this.looping && this.loopFrames > 0 && frame >= blendEnd && frame < extendedCycleFrames) {
            this.setFromKey(0);
            return;
        }

        if (this.interpolation === 'step') {
            const { seg } = this.findSegment(frame);
            this.setFromKey(seg);
            return;
        }

        spline.evaluate(frame, result);
        if (!result.every(isFinite)) return;

        const { seg, t } = this.findSegment(frame);
        const yaw = lerpAngleDeg(this.yaws[seg], this.yaws[seg + 1], t);
        const pitch = lerpAngleDeg(this.pitches[seg], this.pitches[seg + 1], t);
        const distance = this.distances[seg] + (this.distances[seg + 1] - this.distances[seg]) * t;
        const fov = (this.fovs[seg] ?? this.defaultFov) + ((this.fovs[seg + 1] ?? this.defaultFov) - (this.fovs[seg] ?? this.defaultFov)) * t;
        this.applyPose(result[0], result[1], result[2], yaw, pitch, distance, fov);
    }

    getFov() {
        const fov = this.result[6];
        if (Number.isFinite(fov)) {
            return fov;
        }
        return this.defaultFov;
    }

    // construct an animation from a settings track
    static fromTrack(track: AnimTrack) {
        const { keyframes, duration, frameRate, loopMode, smoothness, interpolation } = track;
        const { times, values } = keyframes;
        const { position, target, fov } = values;

        const points = [];
        const yaws: number[] = [];
        const pitches: number[] = [];
        const distances: number[] = [];
        const fovs: number[] = [];
        const defaultFov = (Array.isArray(fov) && fov.length > 0 && Number.isFinite(fov[0])) ? fov[0] : 60;
        for (let i = 0; i < times.length; i++) {
            const posX = position[i * 3];
            const posY = position[i * 3 + 1];
            const posZ = position[i * 3 + 2];
            const tgtX = target[i * 3];
            const tgtY = target[i * 3 + 1];
            const tgtZ = target[i * 3 + 2];
            points.push(posX, posY, posZ);

            tmpDir.set(tgtX - posX, tgtY - posY, tgtZ - posZ);
            const dist = tmpDir.length();
            if (dist > 1e-6) {
                tmpDir.mulScalar(1 / dist);
                const ang = directionToAngles(tmpDir);
                yaws.push(ang.yaw);
                pitches.push(ang.pitch);
                distances.push(dist);
            } else if (i > 0) {
                yaws.push(yaws[i - 1]);
                pitches.push(pitches[i - 1]);
                distances.push(distances[i - 1]);
            } else {
                const ang = directionToAngles(Vec3.FORWARD);
                yaws.push(ang.yaw);
                pitches.push(ang.pitch);
                distances.push(3);
            }
            fovs.push((Array.isArray(fov) && Number.isFinite(fov[i])) ? fov[i] : defaultFov);
        }

        const spline = CubicSpline.fromPoints(times, points, smoothness);
        const loopSecondsRaw = track.fl_loopTimeSeconds;
        const loopFrames = Number.isFinite(loopSecondsRaw) ? Math.max(0, loopSecondsRaw * frameRate) : 0;
        const loopingFlag = track.fl_loop;
        // repeat + 默认开启接缝混合；仅当 fl_loop === false 时关闭（仍 repeat 时间，但不插值末→首）
        const looping = loopMode === 'repeat' && (typeof loopingFlag === 'boolean' ? loopingFlag : true);

        return new AnimState(
            spline,
            interpolation,
            times,
            position,
            yaws,
            pitches,
            distances,
            fovs,
            duration,
            loopMode,
            frameRate,
            looping,
            loopFrames,
            defaultFov
        );
    }
}

export { AnimState };
