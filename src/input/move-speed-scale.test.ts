/**
 * 移动步长系数纯函数自检。
 *
 *   npx --yes tsx src/input/move-speed-scale.test.ts
 */

import {
    computeAdaptiveMoveSpeed,
    computePanProjectionDistance,
    DEFAULT_MOVE_SPEED_SCALE,
    parseMoveSpeedScale,
    readMoveSpeedScale,
    writeMoveSpeedScale
} from './move-speed-scale';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

function assertClose(actual: number, expected: number, eps: number, msg: string): void {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
        throw new Error(`${msg}: expected ${expected} ± ${eps}, got ${actual}`);
    }
}

assert(parseMoveSpeedScale(undefined) === null, 'undefined → null');
assert(parseMoveSpeedScale(0) === null, '0 → null');
assert(parseMoveSpeedScale(-1) === null, 'negative → null');
assert(parseMoveSpeedScale(NaN) === null, 'NaN → null');
assert(parseMoveSpeedScale('0.5' as unknown) === null, 'string → null');
assertClose(parseMoveSpeedScale(1) ?? -1, 1, 1e-9, '1');
assertClose(parseMoveSpeedScale(0.2) ?? -1, 0.2, 1e-9, '0.2');
assertClose(parseMoveSpeedScale(0.0001) ?? -1, 0.001, 1e-9, 'below min clamps');
assertClose(parseMoveSpeedScale(100) ?? -1, 10, 1e-9, 'above max clamps');

assertClose(readMoveSpeedScale({}), DEFAULT_MOVE_SPEED_SCALE, 1e-9, 'missing defaults to 1');
assertClose(readMoveSpeedScale({ cameras: [] }), DEFAULT_MOVE_SPEED_SCALE, 1e-9, 'empty cameras defaults to 1');
assertClose(
    readMoveSpeedScale({ cameras: [{ moveSpeedScale: 0.3 }] }),
    0.3,
    1e-9,
    'reads cameras[0]'
);
const written = { cameras: [{}] };
assert(writeMoveSpeedScale(written, 0.2) === true, 'write to cameras[0]');
assertClose(readMoveSpeedScale(written), 0.2, 1e-9, 'write then read');
assert(writeMoveSpeedScale({ cameras: [] }, 0.2) === false, 'empty cameras write fails');

const unscaled = computeAdaptiveMoveSpeed(2000, 1);
assertClose(unscaled.moveSpeed, 100, 1e-9, 'adaptive speed sceneSize*0.05');
assertClose(unscaled.minPanDistance, 200, 1e-9, 'adaptive minPan sceneSize*0.1');

const scaled = computeAdaptiveMoveSpeed(2000, 0.1);
assertClose(scaled.moveSpeed, 10, 1e-9, 'scale multiplies adaptive speed');
assertClose(scaled.minPanDistance, 20, 1e-9, 'scale multiplies minPan');

const smallScene = computeAdaptiveMoveSpeed(10, 1);
assertClose(smallScene.moveSpeed, 1, 1e-9, 'adaptive floors at 1');

const smallScaled = computeAdaptiveMoveSpeed(10, 0.1);
assertClose(smallScaled.moveSpeed, 0.1, 1e-9, 'scale applies after floor');

const flyPan = computePanProjectionDistance({
    cameraDistance: 80,
    moveSpeed: scaled.moveSpeed,
    minPanDistance: scaled.minPanDistance,
    scale: 0.1,
    firstPerson: true
});
assertClose(flyPan, scaled.moveSpeed, 1e-9, 'fly pan uses moveSpeed not leftover orbit distance');

const orbitFar = computePanProjectionDistance({
    cameraDistance: 500,
    moveSpeed: scaled.moveSpeed,
    minPanDistance: scaled.minPanDistance,
    scale: 0.1,
    firstPerson: false
});
assertClose(orbitFar, 50, 1e-9, 'orbit far pan multiplies cameraDistance by scale');

const orbitNear = computePanProjectionDistance({
    cameraDistance: 5,
    moveSpeed: scaled.moveSpeed,
    minPanDistance: scaled.minPanDistance,
    scale: 0.1,
    firstPerson: false
});
assertClose(orbitNear, scaled.minPanDistance, 1e-9, 'orbit near pan keeps scaled min floor');

console.log('move-speed-scale.test.ts: ok');
