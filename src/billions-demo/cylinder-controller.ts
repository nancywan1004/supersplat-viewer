import {
    DualGestureSource,
    KeyboardMouseSource,
    Mat4,
    Quat,
    Vec3,
    math,
    type AppBase,
    type Entity
} from 'playcanvas';

const damp = (damping: number, dt: number) => 1 - Math.pow(damping, dt * 1000);

const up = new Vec3();
const right = new Vec3();
const fwd = new Vec3();
const radial = new Vec3();
const levelUp = new Vec3();
const cross = new Vec3();
const disp = new Vec3();
const tmp = new Vec3();
const mat = new Mat4();
const qYaw = new Quat();
const qPitch = new Quat();
const qLevel = new Quat();
const qTmp = new Quat();

interface CylinderControllerOptions {
    radius?: number;
    axialStart?: number;
    startHeight?: number;
    moveSpeed?: number;
    moveFastSpeed?: number;
    lookSpeed?: number;
    touchLookSpeed?: number;
    moveDamping?: number;
    rotateDamping?: number;
    levelSpeed?: number;
}

class CylinderController {
    private readonly app: AppBase;
    private readonly camera: Entity;
    private readonly radius: number;
    private readonly moveSpeed: number;
    private readonly moveFastSpeed: number;
    private readonly lookSpeed: number;
    private readonly touchLookSpeed: number;
    private readonly moveDamping: number;
    private readonly rotateDamping: number;
    private readonly levelSpeed: number;
    private readonly posT: Vec3;
    private readonly pos: Vec3;
    private readonly rotT: Quat;
    private readonly rot: Quat;
    private readonly axis = new Vec3();
    private shift = 0;
    private readonly desktopInput: KeyboardMouseSource;
    private readonly mobileInput: DualGestureSource;

    constructor(app: AppBase, camera: Entity, options: CylinderControllerOptions = {}) {
        this.app = app;
        this.camera = camera;
        this.radius = options.radius ?? 1000;
        this.moveSpeed = options.moveSpeed ?? 40;
        this.moveFastSpeed = options.moveFastSpeed ?? 600;
        this.lookSpeed = options.lookSpeed ?? 0.2;
        this.touchLookSpeed = options.touchLookSpeed ?? 60;
        this.moveDamping = options.moveDamping ?? 0.99;
        this.rotateDamping = options.rotateDamping ?? 0.985;
        this.levelSpeed = options.levelSpeed ?? 3;

        const startHeight = options.startHeight ?? 2;
        this.posT = new Vec3(options.axialStart ?? 0, startHeight, 0);
        this.pos = this.posT.clone();

        mat.setLookAt(new Vec3(0, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 1, 0));
        this.rotT = new Quat().setFromMat4(mat);
        this.rot = this.rotT.clone();

        this.desktopInput = new KeyboardMouseSource({ pointerLock: false });
        this.mobileInput = new DualGestureSource();
        this.desktopInput.attach(app.graphicsDevice.canvas);
        this.mobileInput.attach(app.graphicsDevice.canvas);

        this.applyTransform();
    }

    update(dt: number) {
        const { keyCode } = KeyboardMouseSource;
        const { key, mouse } = this.desktopInput.read();
        const { leftInput, rightInput } = this.mobileInput.read();
        const r = this.radius;

        this.axis.x += (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]);
        this.axis.y += (key[keyCode.E] - key[keyCode.Q]) + (key[keyCode.SPACE] - key[keyCode.CTRL]);
        this.axis.z += (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN]);
        this.shift += key[keyCode.SHIFT];

        const moveX = math.clamp(this.axis.x + leftInput[0], -1, 1);
        const moveY = math.clamp(this.axis.y, -1, 1);
        const moveZ = math.clamp(this.axis.z - leftInput[1], -1, 1);

        const yawIn = mouse[0] * this.lookSpeed + rightInput[0] * this.touchLookSpeed * dt;
        const pitchIn = mouse[1] * this.lookSpeed + rightInput[1] * this.touchLookSpeed * dt;
        if (yawIn || pitchIn) {
            this.rotT.transformVector(Vec3.UP, up);
            this.rotT.transformVector(Vec3.RIGHT, right);
            qYaw.setFromAxisAngle(up, -yawIn);
            qPitch.setFromAxisAngle(right, -pitchIn);
            qTmp.mul2(qPitch, this.rotT);
            this.rotT.mul2(qYaw, qTmp);
        }

        const speed = (this.shift > 0 ? this.moveFastSpeed : this.moveSpeed) * dt;
        this.rotT.transformVector(Vec3.FORWARD, fwd);
        this.rotT.transformVector(Vec3.RIGHT, right);
        this.rotT.transformVector(Vec3.UP, up);
        disp.set(0, 0, 0);
        disp.add(tmp.copy(fwd).mulScalar(moveZ * speed));
        disp.add(tmp.copy(right).mulScalar(moveX * speed));
        disp.add(tmp.copy(up).mulScalar(moveY * speed));
        this.posT.add(disp);

        radial.set(0, this.posT.y - r, this.posT.z);
        let rlen = radial.length();
        const maxR = r * 1.1;
        if (rlen > maxR) {
            const k = maxR / rlen;
            this.posT.y = r + radial.y * k;
            this.posT.z = radial.z * k;
        }

        radial.set(0, this.posT.y - r, this.posT.z);
        rlen = radial.length();
        if (rlen > r * 1e-3) {
            this.rotT.transformVector(Vec3.FORWARD, fwd);
            this.rotT.transformVector(Vec3.UP, up);
            radial.mulScalar(-1 / rlen);
            levelUp.copy(radial).sub(tmp.copy(fwd).mulScalar(radial.dot(fwd)));
            const llen = levelUp.length();
            if (llen > 1e-4) {
                levelUp.mulScalar(1 / llen);
                const cosA = math.clamp(up.dot(levelUp), -1, 1);
                cross.cross(up, levelUp);
                const rollDeg = Math.atan2(cross.dot(fwd), cosA) * math.RAD_TO_DEG;
                const closeness = math.clamp(rlen / r, 0, 1);
                const frac = math.clamp(this.levelSpeed * dt, 0, 1) * closeness;
                if (frac > 0 && Math.abs(rollDeg) > 1e-3) {
                    qLevel.setFromAxisAngle(fwd, rollDeg * frac);
                    this.rotT.mul2(qLevel, this.rotT);
                    this.rot.mul2(qLevel, this.rot);
                }
            }
        }

        this.pos.lerp(this.pos, this.posT, damp(this.moveDamping, dt));
        this.rot.slerp(this.rot, this.rotT, damp(this.rotateDamping, dt));
        this.applyTransform();
    }

    destroy() {
        this.desktopInput.detach();
        this.mobileInput.detach();
    }

    private applyTransform() {
        this.camera.setPosition(this.pos);
        this.camera.setRotation(this.rot);
    }
}

export { CylinderController };
