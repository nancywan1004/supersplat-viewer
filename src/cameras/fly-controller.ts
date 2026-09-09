import {
    Pose,
    Vec2,
    Vec3,
    Quat,
    math
} from 'playcanvas';

import type { Collision, PushOut } from '../collision';
import { SCENE_ASSET_CAMERA_COLLISION_RADIUS } from '../scene-assets/collision/scene-asset-collision';
import type { CameraFrame, Camera, CameraController } from './camera';
import type { SphereConstraint } from '../camera-constraints/sphere-constraint';
import type { BoxConstraint } from '../camera-constraints/box-constraint';
import { SphereMover } from './sphere-mover';

const angles = new Vec3();
const rotation = new Quat();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();
const tmpPos = new Vec3();
const tmpClamp = new Vec3();
const tmpPrevPos = new Vec3();
const tmpDelta = new Vec3();
const tmpNormal = new Vec3();
const tmpTarget = new Vec3();
const tmpTargetClamp = new Vec3();
const tmpRemain = new Vec3();
const tmpSweepMove = new Vec3();
const CAMERA_RADIUS = SCENE_ASSET_CAMERA_COLLISION_RADIUS;

// Damping helper function
const damp = (damping: number, dt: number) => {
    return 1 - Math.pow(damping, dt * 60);
};

/** Pre-allocated push-out vector for sphere collision */
const pushOut: PushOut = { x: 0, y: 0, z: 0 };

class FlyController implements CameraController {
    private _targetPose: Pose;
    private _pose: Pose;
    rotateDamping: number = 0.1; // Lower damping for more responsive rotation (was 0.9)
    moveDamping: number = 0.5;
    pitchRange: Vec2 = new Vec2(-90, 90);
    private constraint: SphereConstraint | null = null;
    private targetConstraint: BoxConstraint | null = null;
    // Fly 下用于“target/focus 约束”的距离（使 Fly 与 Orbit 的约束对象一致）
    private focusDistance: number = 3;
    // 用于对齐 Orbit 的 zoomRange，避免 Fly 在 target clamp 时形成更大一圈的“相机位置外壳”
    private focusDistanceRange: Vec2 = new Vec2(0.5, Infinity);

    /**
     * 传入 Orbit 的 zoomRange，用于 clamp Fly 的 focusDistance
     */
    setFocusDistanceRange(range: Vec2): void {
        this.focusDistanceRange.copy(range);
    }

    fov = 90;

    /** 场景 mesh 碰撞：扫掠移动，避免一帧穿过薄墙 */
    private _collision: Collision | null = null;

    private readonly _sphereMover = new SphereMover(CAMERA_RADIUS);

    /** sceneAsset AABB 碰撞（由 CameraManager 注入，阶段一） */
    private sceneAssetCollisionResolver: (() => Collision | null) | null = null;

    get collision(): Collision | null {
        return this._collision;
    }

    set collision(value: Collision | null) {
        this._collision = value;
        this._sphereMover.collision = value;
        this._sphereMover.reset(this._pose.position);
    }

    private _spawnPosition = new Vec3();
    private _spawnAngles = new Vec3();
    private _spawnDistance = 1;
    private _hasSpawn = false;

    constructor() {
        this._targetPose = new Pose();
        this._pose = new Pose();
    }

    /**
     * 设置约束
     */
    setConstraint(constraint: SphereConstraint | null): void {
        this.constraint = constraint;
    }

    /**
     * 设置 target/focus 约束（与 Orbit 保持一致，用于限制相机活动范围）
     */
    setTargetConstraint(constraint: BoxConstraint | null): void {
        this.targetConstraint = constraint;
    }

    setSceneAssetCollisionResolver(resolver: (() => Collision | null) | null): void {
        this.sceneAssetCollisionResolver = resolver;
    }

    private _applySceneAssetSpherePush(x: number, y: number, z: number): boolean {
        const col = this.sceneAssetCollisionResolver?.();
        return !!col?.querySphere(x, y, z, CAMERA_RADIUS, pushOut);
    }

    onEnter(camera: Camera): void {
        this._targetPose.set(camera.position, camera.angles, camera.distance);
        this._pose.copy(this._targetPose);

        // 固定一个 fly focusDistance：沿用当前 camera.distance（来自 orbit）更符合用户直觉
        // 给一个下限避免太小导致数值不稳定
        this.focusDistance = math.clamp(
            Math.max(0.5, camera.distance || 0),
            this.focusDistanceRange.x,
            this.focusDistanceRange.y
        );

        // 进入 fly 模式：**不做 snap/clamp**（避免 orbit→fly 时因位置在 box 外而瞬移跳变）
        // 约束仅在“inside→outside”或“继续远离 box”时生效（见 update）
        if (!this.targetConstraint && this.constraint) {
            // 兼容旧逻辑：没有 box 约束时，仍可用球形软边界兜底
            this.constraint.clampToSoft(this._targetPose.position, this._targetPose.position);
            this._pose.position.copy(this._targetPose.position);
        }
        this._sphereMover.reset(this._pose.position);
        this._storeSpawn();
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();
        
        const hasTranslateInput = (move[0] !== 0) || (move[1] !== 0) || (move[2] !== 0);

        // Apply rotation with roll support
        // rotate[0] = mouse/touch X (yaw)
        // rotate[1] = mouse/touch Y (pitch)
        // rotate[2] = Q/E keys (roll)
        angles.set(-rotate[1], -rotate[0], rotate[2]);
        this._targetPose.rotate(angles);
        
        // Clamp pitch
        this._targetPose.angles.x = math.clamp(
            this._targetPose.angles.x,
            this.pitchRange.x,
            this.pitchRange.y
        );
        
        // Apply movement in local space
        rotation.setFromEulerAngles(this._pose.angles);
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);
        
        offset.set(0, 0, 0);
        // 注意：Vec3.mulScalar 会修改向量本身，不能直接对 forward/right/up 做 mulScalar
        // 否则后续用 forward 计算 focus/target 会变成接近 0 的向量，导致约束失效（fly 范围比 orbit 松）。
        offset.add(tmpDelta.copy(forward).mulScalar(move[2]));
        offset.add(tmpDelta.copy(right).mulScalar(move[0]));
        offset.add(tmpDelta.copy(up).mulScalar(move[1]));
        
        // 预测下一个位置
        // 用当前 pose 作为基准（而不是 targetPose），避免 damping 造成的“当前点/目标点不一致”
        // 在边界附近会被约束误判为越界，从而出现平移卡死/手感异常。
        tmpPos.copy(this._pose.position).add(offset);

        // 应用约束：
        // - Orbit：约束的是 target/focus（通过 distance）
        // - Fly（选项2）：保持“前后/平移 = 移动相机位置”的语义，所以这里直接约束 **camera.position**
        //   这样可以避免 focusDistance 固定导致的“外壳范围”（fly 比 orbit 更能 zoom out / 更难 zoom in）的不一致问题。
        if (this.targetConstraint) {
            // 关键：**纯旋转不应该引起 position 变化**
            // 否则在 target 被 clamp 到盒边时，反解 position 会产生“左键拖动带平移”的错觉。
            // 所以仅当用户确实有位移输入时，才启用位置约束。
            if (!hasTranslateInput) {
                this._targetPose.position.copy(tmpPos);
            } else {
                const curPos = this._pose.position;
                const desiredPos = tmpPos;

                const currentIn = this.targetConstraint.containsPoint(curPos);
                if (currentIn) {
                    // inside -> outside：先“撞墙”到盒边，再把剩余位移投影到盒面切平面上（允许沿边界滑动）
                    // 仅用 constrainSegment 会把切向分量也吃掉，导致在某些边界方向/斜向移动时出现“卡死”感。
                    if (this.targetConstraint.containsPoint(desiredPos)) {
                        this._targetPose.position.copy(desiredPos);
                    } else {
                        // hit = 撞到边界的位置（已经 clamp 进盒子）
                        this.targetConstraint.constrainSegment(curPos, desiredPos, tmpClamp);

                        // remain = desired - hit（原本想继续走的剩余位移）
                        tmpRemain.sub2(desiredPos, tmpClamp);

                        // 计算 hit 点接触到的盒面法线（可能是多轴：边/角）
                        const min = this.targetConstraint.bbox.getMin();
                        const max = this.targetConstraint.bbox.getMax();
                        const e = this.targetConstraint.epsilon;
                        const tol = e * 2 + 1e-6;

                        // 根据 clampPoint 的“内缩盒子”规则判断贴边方向
                        const minX = (max.x - min.x > 2 * e) ? (min.x + e) : min.x;
                        const maxX = (max.x - min.x > 2 * e) ? (max.x - e) : max.x;
                        const minY = (max.y - min.y > 2 * e) ? (min.y + e) : min.y;
                        const maxY = (max.y - min.y > 2 * e) ? (max.y - e) : max.y;
                        const minZ = (max.z - min.z > 2 * e) ? (min.z + e) : min.z;
                        const maxZ = (max.z - min.z > 2 * e) ? (max.z - e) : max.z;

                        tmpNormal.set(0, 0, 0);
                        if (Math.abs(tmpClamp.x - minX) <= tol) tmpNormal.x = -1;
                        else if (Math.abs(tmpClamp.x - maxX) <= tol) tmpNormal.x = 1;
                        if (Math.abs(tmpClamp.y - minY) <= tol) tmpNormal.y = -1;
                        else if (Math.abs(tmpClamp.y - maxY) <= tol) tmpNormal.y = 1;
                        if (Math.abs(tmpClamp.z - minZ) <= tol) tmpNormal.z = -1;
                        else if (Math.abs(tmpClamp.z - maxZ) <= tol) tmpNormal.z = 1;

                        // 去掉“继续往外推”的分量，保留切向分量（实现滑动）
                        if (tmpNormal.x !== 0 && tmpRemain.x * tmpNormal.x > 0) tmpRemain.x = 0;
                        if (tmpNormal.y !== 0 && tmpRemain.y * tmpNormal.y > 0) tmpRemain.y = 0;
                        if (tmpNormal.z !== 0 && tmpRemain.z * tmpNormal.z > 0) tmpRemain.z = 0;

                        // newDesired = hit + tangentialRemain，并 clamp 兜底到盒内
                        tmpPos.copy(tmpClamp).add(tmpRemain);
                        this.targetConstraint.clampPoint(tmpPos, tmpPos);
                        this._targetPose.position.copy(tmpPos);
                    }
                } else {
                    // 若当前已经在 box 外：不 snap（避免切模式跳变）
                    // 仅阻止继续远离 box；允许用户飞回 box 内
                    this.targetConstraint.clampPoint(curPos, tmpTargetClamp);
                    const curDist = curPos.distance(tmpTargetClamp);
                    this.targetConstraint.clampPoint(desiredPos, tmpTargetClamp);
                    const nextDist = desiredPos.distance(tmpTargetClamp);

                    if (nextDist > curDist + 1e-5) {
                        // 继续远离：吃掉这次位移
                        this._targetPose.position.copy(curPos);
                    } else {
                        // 朝向 box 或保持：允许移动
                        this._targetPose.position.copy(desiredPos);
                    }
                }
            }
        } else if (this.constraint) {
            this.constraint.clampToHard(tmpPos, this._targetPose.position);
        } else {
            this._targetPose.position.copy(tmpPos);
        }

        // 阻尼插值朝本帧目标走；mesh 碰撞在插值之后从上一帧安全点扫掠，避免直线 lerp 穿薄墙。
        
        // Apply damping using Pose.lerp
        this._pose.lerp(
            this._pose,
            this._targetPose,
            damp(this.moveDamping, deltaTime),
            damp(this.rotateDamping, deltaTime),
            1
        );
        
        tmpPrevPos.copy(camera.position);

        camera.position.copy(this._pose.position);
        // 关键修复：由于 damping 插值，_pose 可能在“撞墙”后仍短暂处于盒外，
        // 这会导致后续输入在边界附近被误判/吃掉，表现为“触边后回不到盒内（卡死）”。
        // 在确实有位移输入时，强制把相机位置拉回到盒内，并同步回写内部状态。
        // 注意：纯旋转时不做这个 clamp，避免 orbit→fly 切换后仅旋转就发生 snap。
        if (hasTranslateInput && this.targetConstraint) {
            const clamped = this.targetConstraint.clampPoint(camera.position, tmpClamp);
            if (clamped) {
                camera.position.copy(tmpClamp);
                this._pose.position.copy(tmpClamp);
                this._targetPose.position.copy(tmpClamp);
            }
        }
        if (this.constraint && !this.targetConstraint) {
            // 没有 box 约束时，用球形硬边界兜底（防止飞到特别远）
            this.constraint.clampToHard(camera.position, camera.position);
            this._pose.position.copy(camera.position);
        }

        this._sweepCameraFrom(tmpPrevPos, camera.position);
        this._pose.position.copy(camera.position);
        this._targetPose.position.copy(camera.position);

        camera.angles.copy(this._pose.angles);
        camera.distance = this._pose.distance;
    }

    onExit(_camera: Camera): void {
        // No cleanup needed
    }

    goto(pose: Pose) {
        // goto 时应用“软边界回弹”
        if (this.targetConstraint) {
            // 与 Orbit 保持一致：约束 target/focus（而不是 position），再反解 position
            this.focusDistance = math.clamp(
                Math.max(0.5, pose.distance || this.focusDistance),
                this.focusDistanceRange.x,
                this.focusDistanceRange.y
            );

            rotation.setFromEulerAngles(pose.angles);
            rotation.transformVector(Vec3.FORWARD, forward);

            // target = pos + forward * focusDistance
            tmpTarget.copy(forward).mulScalar(this.focusDistance).add(pose.position);

            const clamped = this.targetConstraint.clampPoint(tmpTarget, tmpTarget);
            if (clamped) {
                // pos = target - forward * focusDistance
                tmpPos.copy(tmpTarget).sub(tmpDelta.copy(forward).mulScalar(this.focusDistance));
                this._targetPose.set(tmpPos, pose.angles, pose.distance);
            } else {
                this._targetPose.set(pose.position, pose.angles, pose.distance);
            }
        } else if (this.constraint) {
            this.constraint.clampToSoft(pose.position, tmpPos);
            this._targetPose.set(tmpPos, pose.angles, pose.distance);
        } else {
            this._targetPose.copy(pose);
        }
        this._pose.copy(this._targetPose);
        this._sphereMover.reset(this._pose.position);
    }

    resetToSpawn(camera: Camera): boolean {
        if (!this._hasSpawn) {
            return false;
        }

        this._targetPose.set(this._spawnPosition, this._spawnAngles, this._spawnDistance);
        this._pose.copy(this._targetPose);
        camera.position.copy(this._spawnPosition);
        camera.angles.copy(this._spawnAngles);
        camera.distance = this._spawnDistance;
        camera.fov = this.fov;
        this._sphereMover.reset(this._pose.position);
        return true;
    }

    /**
     * 从上一帧安全点扫掠到目标点；穿薄墙时停在表面或退回上次清空位置。
     * @param from - 上一帧相机位置
     * @param to - 本帧期望位置，成功后写回扫掠结果
     */
    private _sweepCameraFrom(from: Vec3, to: Vec3): void {
        this._sphereMover.collision = this._collision;
        tmpSweepMove.sub2(to, from);
        to.copy(from);
        this._sphereMover.move(to, tmpSweepMove);
        if (this._applySceneAssetSpherePush(to.x, to.y, to.z)) {
            to.x += pushOut.x;
            to.y += pushOut.y;
            to.z += pushOut.z;
        }
    }

    private _storeSpawn() {
        this._spawnPosition.copy(this._pose.position);
        this._spawnAngles.copy(this._pose.angles);
        this._spawnDistance = this._pose.distance;
        this._hasSpawn = true;
    }
}

export { FlyController };
