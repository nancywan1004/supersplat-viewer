// SPZ 解码自检（纯 Node，无需浏览器）。
//
//   npx --yes tsx src/loaders/gsplat/spz/spz-decode.test.ts
//
// 默认跑全部 4 个样本；跳过 9.8M 点大文件：SPZ_TEST_SKIP_LARGE=1
// 样本目录可用 SPZ_SAMPLES_DIR / SPZ_ASSETS_DIR 覆盖（相对 repo 根目录）。
/* global Buffer, process */
/* eslint-disable no-await-in-loop */

import fs from 'node:fs';
import path from 'node:path';

import { decodeSpz } from './spz-decode';
import { parseSpzLayout } from './spz-format';

const SAMPLES_DIR = process.env.SPZ_SAMPLES_DIR ?? '../spz/samples';
const ASSETS_DIR = process.env.SPZ_ASSETS_DIR ?? '../splat-transform/assets/baxi-2';

interface Expectation {
    label: string;
    file: string;
    /** 'gzip' = legacy v2/v3 single stream, 'ngsp' = v4 container. */
    kind: 'gzip' | 'ngsp';
    version: number;
    numPoints: number;
    shDegree: number;
    /** Quantization step (bucket size) for the degree-1 coefficients (sh1Bits). */
    sh1Bucket?: number;
    /** Quantization step for the remaining coefficients (shRestBits). */
    shRestBucket?: number;
    /** Expected number of distinct rest-coefficient bytes on a bucketed lattice. */
    shRestDistinct?: number;
    /** Full 8-bit range expected (8/8 quantization). */
    shFullRange?: boolean;
    aabb?: { min: [number, number, number]; max: [number, number, number] };
    /** Skip when the file is missing. */
    optional?: boolean;
}

const EXPECTATIONS: Expectation[] = [
    {
        label: 'legacy v2 gzip',
        file: path.join(SAMPLES_DIR, 'hornedlizard.spz'),
        kind: 'gzip',
        version: 2,
        numPoints: 786233,
        shDegree: 3
    },
    {
        label: 'SPZ 5/4 (287 MB)',
        file: path.join(ASSETS_DIR, 'splat-90.spz'),
        kind: 'ngsp',
        version: 4,
        numPoints: 9830867,
        shDegree: 3,
        sh1Bucket: 8,
        shRestBucket: 16,
        shRestDistinct: 17,
        aabb: {
            min: [-2020.49, -598.26, -351.19],
            max: [1857.23, 1039.21, 1560.46]
        }
    },
    {
        label: 'SPZ 6/6 (367 MB)',
        file: path.join(ASSETS_DIR, 'splat-90-sh66.spz'),
        kind: 'ngsp',
        version: 4,
        numPoints: 9830867,
        shDegree: 3,
        sh1Bucket: 4,
        shRestBucket: 4,
        shRestDistinct: 65,
        aabb: {
            min: [-2020.49, -598.26, -351.19],
            max: [1857.23, 1039.21, 1560.46]
        }
    },
    {
        label: 'SPZ 8/8 (475 MB)',
        file: path.join(ASSETS_DIR, 'splat-90-sh88.spz'),
        kind: 'ngsp',
        version: 4,
        numPoints: 9830867,
        shDegree: 3,
        shFullRange: true,
        aabb: {
            min: [-2020.49, -598.26, -351.19],
            max: [1857.23, 1039.21, 1560.46]
        }
    }
];

const failures: string[] = [];

const check = (condition: boolean, message: string) => {
    if (!condition) {
        throw new Error(message);
    }
};

const checkClose = (actual: number, expected: number, tolerance: number, message: string) => {
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error(`${message}: expected ${expected} ±${tolerance}, got ${actual}`);
    }
};

const fmt = (value: number) => value.toFixed(2);

// Positions bounding box over the decoded GSplatData.
const computeAabb = (x: Float32Array, y: Float32Array, z: Float32Array) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < x.length; i++) {
        const px = x[i], py = y[i], pz = z[i];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
};

// Distinct quantized SH byte values over a sparse sample of splats, split into the degree-1
// group (f_rest_0..2, quantized with sh1Bits) and the remaining coefficients (shRestBits).
const sampleShBytes = (getProp: (name: string) => Float32Array, numSplats: number, shDim: number) => {
    const props: Float32Array[] = [];
    for (let i = 0; i < shDim * 3; i++) {
        props.push(getProp(`f_rest_${i}`));
    }
    const deg1 = new Set<number>();
    const rest = new Set<number>();
    const step = 97;
    for (let i = 0; i < numSplats; i += step) {
        for (let c = 0; c < 3; c++) {
            for (let k = 0; k < shDim; k++) {
                const value = Math.round(props[c * shDim + k][i] * 128 + 128);
                (k < 3 ? deg1 : rest).add(value);
            }
        }
    }
    return { deg1, rest };
};

const runCase = async (exp: Expectation) => {
    if (!fs.existsSync(exp.file)) {
        if (exp.optional) {
            console.log(`SKIP ${exp.label}: ${exp.file} not found`);
            return;
        }
        throw new Error(`missing test file: ${exp.file}`);
    }

    const buf = fs.readFileSync(exp.file);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    console.log(`\n=== ${exp.label} (${(bytes.byteLength / 1048576).toFixed(1)} MB) ===`);

    const layout = parseSpzLayout(bytes);
    check(layout.kind === exp.kind, `container kind: expected ${exp.kind}, got ${layout.kind}`);

    if (layout.kind === 'ngsp') {
        const h = layout.header;
        check(h.version === exp.version, `version: expected ${exp.version}, got ${h.version}`);
        check(h.numPoints === exp.numPoints, `numPoints: expected ${exp.numPoints}, got ${h.numPoints}`);
        check(h.shDegree === exp.shDegree, `shDegree: expected ${exp.shDegree}, got ${h.shDegree}`);
        check(h.fractionalBits === 12, `fractionalBits: expected 12, got ${h.fractionalBits}`);
        check(h.numStreams === 6, `numStreams: expected 6, got ${h.numStreams}`);
        check(h.tocByteOffset === 32, `tocByteOffset: expected 32, got ${h.tocByteOffset}`);
        check(h.antialiased === false, 'antialiased: expected false');
        console.log(
            `header: magic=NGSP version=${h.version} points=${h.numPoints} shDegree=${h.shDegree} ` +
            `fractionalBits=${h.fractionalBits} streams=${h.numStreams} toc=${h.tocByteOffset}`
        );
    }

    const start = performance.now();
    const result = await decodeSpz(bytes, { yieldToMainThread: false });
    const elapsed = performance.now() - start;

    const { data, header } = result;
    check(header.numPoints === exp.numPoints, `decoded numPoints: expected ${exp.numPoints}, got ${header.numPoints}`);
    check(data.numSplats === exp.numPoints, `GSplatData.numSplats: expected ${exp.numPoints}, got ${data.numSplats}`);
    check(data.shBands === exp.shDegree, `GSplatData.shBands: expected ${exp.shDegree}, got ${data.shBands}`);

    const prop = (name: string) => data.getProp(name) as Float32Array;
    const x = prop('x');
    const y = prop('y');
    const z = prop('z');
    const opacity = prop('opacity');
    const rot0 = prop('rot_0');
    const fdc0 = prop('f_dc_0');
    check(!!x && !!y && !!z && !!opacity && !!rot0 && !!fdc0, 'missing core properties');
    check(!!data.getProp('scale_0') && !!data.getProp('rot_3'), 'missing scale/rotation properties');

    // every splat must be finite and inside a plausible range
    for (let i = 0; i < data.numSplats; i += 1013) {
        check(Number.isFinite(x[i]) && Number.isFinite(y[i]) && Number.isFinite(z[i]), `non-finite position at ${i}`);
        check(Number.isFinite(opacity[i]), `non-finite opacity at ${i}`);
        check(opacity[i] >= -6 && opacity[i] <= 6, `opacity out of logit range at ${i}: ${opacity[i]}`);
        check(Math.abs(fdc0[i]) < 8, `f_dc out of range at ${i}: ${fdc0[i]}`);
    }

    // rotations: smallest-three renormalizes exactly, legacy v2 stores xyz in 8 bits and clamps w
    const rot1 = prop('rot_1');
    const rot2 = prop('rot_2');
    const rot3 = prop('rot_3');
    for (let i = 0; i < data.numSplats; i += 1013) {
        const len = rot0[i] * rot0[i] + rot1[i] * rot1[i] + rot2[i] * rot2[i] + rot3[i] * rot3[i];
        if (header.usesQuaternionSmallestThree) {
            checkClose(len, 1, 1e-3, `quaternion not unit length at ${i}`);
        } else {
            check(len > 0 && len < 1.01, `quaternion length out of range at ${i}: ${len}`);
        }
    }

    const shProps: number[] = [];
    for (let i = 0; i < 45; i++) {
        if (data.getProp(`f_rest_${i}`)) {
            shProps.push(i);
        }
    }

    if (exp.shDegree > 0) {
        check(shProps.length === 45, `f_rest property count: expected 45, got ${shProps.length}`);
        const { deg1, rest } = sampleShBytes(prop, data.numSplats, Math.floor(shProps.length / 3));
        console.log(`SH bytes (sampled): degree-1 ${deg1.size} distinct, rest ${rest.size} distinct`);

        // quantizeSH rounds to bucket centers (multiples of `bucketSize`) and clamps to 0/255,
        // so a 16-step lattice shows up as 17 distinct values (0,16,...,240) plus 255.
        const checkLattice = (values: Set<number>, bucket: number, group: string) => {
            const bad = Array.from(values).filter(v => v !== 255 && v % bucket !== 0);
            check(bad.length === 0, `${group} SH bytes are not ${bucket}-step quantized, e.g. ${bad.slice(0, 5).join(',')}`);
        };
        if (exp.sh1Bucket !== undefined) {
            checkLattice(deg1, exp.sh1Bucket, 'degree-1');
        }
        if (exp.shRestBucket !== undefined) {
            checkLattice(rest, exp.shRestBucket, 'rest');
            const lattice = rest.size;
            check(Math.abs(lattice - exp.shRestDistinct) <= 1, `rest SH distinct count: expected ~${exp.shRestDistinct}, got ${lattice}`);
        }
        if (exp.shFullRange) {
            check(rest.size === 256, `8-bit SH expected 256 distinct values, got ${rest.size}`);
        }
    }

    const aabb = computeAabb(x, y, z);
    console.log(
        `aabb: X ${fmt(aabb.min[0])} ~ ${fmt(aabb.max[0])}, ` +
        `Y ${fmt(aabb.min[1])} ~ ${fmt(aabb.max[1])}, ` +
        `Z ${fmt(aabb.min[2])} ~ ${fmt(aabb.max[2])}`
    );
    if (exp.aabb) {
        for (let axis = 0; axis < 3; axis++) {
            checkClose(aabb.min[axis], exp.aabb.min[axis], 0.05, `aabb min[${axis}]`);
            checkClose(aabb.max[axis], exp.aabb.max[axis], 0.05, `aabb max[${axis}]`);
        }
    }

    console.log(`decoded ${data.numSplats} splats in ${Math.round(elapsed)} ms`);
};

// Header validation must fail loudly instead of returning empty data.
const runErrorCases = () => {
    const exp = EXPECTATIONS[2];
    if (fs.existsSync(exp.file)) {
        const fd = fs.openSync(exp.file, 'r');
        // 128 KiB is enough that the header's point-count sanity check passes but still tiny to copy
        const headBuffer = Buffer.alloc(128 * 1024);
        fs.readSync(fd, headBuffer, 0, headBuffer.length, 0);
        fs.closeSync(fd);
        const head = new Uint8Array(headBuffer.buffer, headBuffer.byteOffset, headBuffer.byteLength);

        const expectError = (mutate: (bytes: Uint8Array) => void, needle: string, label: string) => {
            const copy = new Uint8Array(head);
            mutate(copy);
            let message = '';
            try {
                parseSpzLayout(copy);
            } catch (err) {
                message = (err as Error).message;
            }
            check(message.includes(needle), `${label} validation message: "${message}"`);
            return message;
        };

        console.log('\n=== error cases ===');
        console.log(`ok: ${expectError((b) => {
            b[15] = 5;
        }, 'numStreams is 5, expected 6', 'numStreams')}`);
        console.log(`ok: ${expectError((b) => {
            new DataView(b.buffer).setBigUint64(40, 123n, true);
        }, 'uncompressed size mismatch', 'TOC')}`);
        console.log(`ok: ${expectError((b) => {
            new DataView(b.buffer).setUint32(4, 3, true);
        }, 'unsupported NGSP version 3', 'version')}`);
    }

    let message = '';
    try {
        parseSpzLayout(new Uint8Array([1, 2, 3, 4, 5]));
    } catch (err) {
        message = (err as Error).message;
    }
    check(message.includes('unrecognized file signature'), `signature validation message: "${message}"`);
    console.log(`ok: "${message}"`);
};

const main = async () => {
    const skipLarge = process.env.SPZ_TEST_SKIP_LARGE === '1';
    const results: { label: string; ok: boolean; numPoints: number; note: string }[] = [];

    for (const exp of EXPECTATIONS) {
        const isLarge = exp.numPoints > 5_000_000;
        if (skipLarge && isLarge) {
            console.log(`SKIP ${exp.label}: SPZ_TEST_SKIP_LARGE=1`);
            continue;
        }
        try {
            await runCase(exp);
            results.push({ label: exp.label, ok: true, numPoints: exp.numPoints, note: 'PASS' });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failures.push(`${exp.label}: ${msg}`);
            results.push({ label: exp.label, ok: false, numPoints: exp.numPoints, note: msg });
        }
    }

    try {
        runErrorCases();
    } catch (err) {
        failures.push(`error cases: ${err instanceof Error ? err.message : err}`);
    }

    console.log('\n=== Summary ===');
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(20)} points=${r.numPoints}  ${r.note}`);
    }

    if (failures.length > 0) {
        console.error(`\n${failures.length} failure(s):`);
        failures.forEach(f => console.error(`- ${f}`));
        process.exitCode = 1;
    } else {
        console.log('\nALL PASS');
    }
};

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
