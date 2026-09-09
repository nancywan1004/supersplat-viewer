/**
 * Fly 薄墙扫掠：整步位移后 querySphere 会穿面，SphereMover 应停在墙外。
 *
 *   npx --yes tsx src/cameras/sphere-mover.test.ts
 */
import { Vec3 } from 'playcanvas';

import { MeshCollision } from '../collision/mesh-collision';
import { SphereMover } from './sphere-mover';

const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
};

const wall = new MeshCollision(
    new Float32Array([
        -10, 0, 0,
        10, 0, 0,
        10, 10, 0,
        -10, 10, 0
    ]),
    new Uint32Array([0, 1, 2, 0, 2, 3])
);

const radius = 0.45;
const mover = new SphereMover(radius);
mover.collision = wall;

const pos = new Vec3(0, 1, 2);
mover.reset(pos);
mover.move(pos, new Vec3(0, 0, -8));

assert(pos.z > radius * 0.5, `sweep should stop in front of wall, z=${pos.z}`);
assert(pos.z < 2, `should have moved toward wall, z=${pos.z}`);

const push = { x: 0, y: 0, z: 0 };
assert(!wall.querySphere(pos.x, pos.y, pos.z, radius, push), 'final pose should be clear of the wall');

console.log('sphere-mover thin wall sweep ok');
