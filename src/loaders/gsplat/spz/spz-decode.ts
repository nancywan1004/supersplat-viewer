// SPZ decoder: ZSTD stream decompression + per-attribute unpacking into a PlayCanvas
// GSplatData instance.
//
// Streams are processed one at a time: decompress → unpack straight into pre-allocated
// Float32Arrays → drop the decompression buffers before moving on. Yields to the event loop
// between point chunks so a 10M point file doesn't freeze the page.
//
// Sequential `await` is intentional (streams are decoded one at a time to bound peak memory).
/* eslint-disable no-await-in-loop */

import { gunzipSync } from 'fflate';
import { GSplatData } from 'playcanvas';
import { ZSTDDecoder } from 'zstddec';

import {
    SPZ_COORDINATE_SYSTEM_RDF,
    legacyBlockOffsets,
    parseLegacySpzHeader,
    parseSpzLayout,
    type SpzHeader,
    type SpzNgspLayout
} from './spz-format';

const COLOR_SCALE = 0.15;
const SQRT1_2 = Math.SQRT1_2;
const ROTATION_MASK = 511;

// Points unpacked per event-loop slice.
const CHUNK_POINTS = 512 * 1024;

// Attribute storage, one Float32Array per GSplatData property.
export interface SpzAttributeArrays {
    numPoints: number;
    shDim: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    fdc0: Float32Array;
    fdc1: Float32Array;
    fdc2: Float32Array;
    opacity: Float32Array;
    scale0: Float32Array;
    scale1: Float32Array;
    scale2: Float32Array;
    rot0: Float32Array;
    rot1: Float32Array;
    rot2: Float32Array;
    rot3: Float32Array;
    /** f_rest order: index = channel * shDim + coefficient. */
    fRest: Float32Array[];
}

export interface SpzDecodeOptions {
    /** Called with cumulative bytes unpacked and the total number of bytes to unpack. */
    onProgress?: (done: number, total: number) => void;
    /** Yield to the event loop between chunks. Disable for headless tests. */
    yieldToMainThread?: boolean;
}

export interface SpzDecodeResult {
    data: GSplatData;
    header: SpzHeader;
}

const delay = (): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, 0);
});

let decoderPromise: Promise<ZSTDDecoder> | null = null;

const getZstdDecoder = (): Promise<ZSTDDecoder> => {
    let promise = decoderPromise;
    if (!promise) {
        promise = (async () => {
            const decoder = new ZSTDDecoder();
            await decoder.init();
            return decoder;
        })().catch((err) => {
            decoderPromise = null;
            throw new Error(`SPZ: failed to initialize the WASM zstd decoder: ${err instanceof Error ? err.message : err}`);
        });
        decoderPromise = promise;
    }
    return promise;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const logCoordinateSystem = (header: SpzHeader) => {
    const coordinateSystem = header.coordinateSystem;
    if (coordinateSystem === null) {
        return;
    }
    if (coordinateSystem === SPZ_COORDINATE_SYSTEM_RDF) {
        console.log('[SPZ] SPZ_ADOBE_coordinate_system = RDF (matches the source PLY convention); no axis conversion applied');
        return;
    }
    if (coordinateSystem === 0) {
        console.warn('[SPZ] SPZ_ADOBE_coordinate_system = UNSPECIFIED (0): data is loaded as-is, no axis conversion applied');
        return;
    }
    // TODO: for non-RDF files rotate positions, quaternions and SH bands. Detection only for now.
    console.warn(
        `[SPZ] SPZ_ADOBE_coordinate_system = ${coordinateSystem}, expected RDF (6, the PLY convention). ` +
        'Data is loaded as-is (no axis conversion), so orientation may not match the source PLY.'
    );
};

const allocateAttributes = (header: SpzHeader): SpzAttributeArrays => {
    const { numPoints, shDim } = header;
    const fRestCount = shDim * 3;
    // 14 scalar properties per point plus 3 * shDim SH coefficients.
    const totalFloats = numPoints * (14 + fRestCount);
    try {
        const fRest: Float32Array[] = new Array(fRestCount);
        for (let i = 0; i < fRestCount; i++) {
            fRest[i] = new Float32Array(numPoints);
        }
        return {
            numPoints,
            shDim,
            x: new Float32Array(numPoints),
            y: new Float32Array(numPoints),
            z: new Float32Array(numPoints),
            fdc0: new Float32Array(numPoints),
            fdc1: new Float32Array(numPoints),
            fdc2: new Float32Array(numPoints),
            opacity: new Float32Array(numPoints),
            scale0: new Float32Array(numPoints),
            scale1: new Float32Array(numPoints),
            scale2: new Float32Array(numPoints),
            rot0: new Float32Array(numPoints),
            rot1: new Float32Array(numPoints),
            rot2: new Float32Array(numPoints),
            rot3: new Float32Array(numPoints),
            fRest
        };
    } catch (err) {
        const mb = Math.round((totalFloats * 4) / (1024 * 1024));
        throw new Error(
            `SPZ: failed to allocate ~${mb} MB for ${numPoints} points (SH degree ${header.shDegree}): ${errorMessage(err)}`
        );
    }
};

const unpackPositions = async (
    src: Uint8Array, dst: Float32Array[], header: SpzHeader, tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const numPoints = header.numPoints;
    const scale = Math.pow(2, -header.fractionalBits);
    const [x, y, z] = dst;
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start, s = start * 9; i < end; i++, s += 9) {
            let v = src[s] | (src[s + 1] << 8) | (src[s + 2] << 16);
            x[i] = (v & 0x800000 ? v | 0xff000000 : v) * scale;
            v = src[s + 3] | (src[s + 4] << 8) | (src[s + 5] << 16);
            y[i] = (v & 0x800000 ? v | 0xff000000 : v) * scale;
            v = src[s + 6] | (src[s + 7] << 8) | (src[s + 8] << 16);
            z[i] = (v & 0x800000 ? v | 0xff000000 : v) * scale;
        }
        progress((end - start) * 9);
        if (end < numPoints) {
            await tick();
        }
    }
};

const unpackAlphas = async (
    src: Uint8Array, dst: Float32Array, numPoints: number, tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const lo = 1 / 255;
    const hi = 254 / 255;
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start; i < end; i++) {
            let p = src[i] / 255;
            if (p < lo) {
                p = lo;
            } else if (p > hi) {
                p = hi;
            }
            dst[i] = Math.log(p / (1 - p));
        }
        progress(end - start);
        if (end < numPoints) {
            await tick();
        }
    }
};

const unpackColors = async (
    src: Uint8Array, dst: Float32Array[], numPoints: number, tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const [r, g, b] = dst;
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start, s = start * 3; i < end; i++, s += 3) {
            r[i] = (src[s] / 255 - 0.5) / COLOR_SCALE;
            g[i] = (src[s + 1] / 255 - 0.5) / COLOR_SCALE;
            b[i] = (src[s + 2] / 255 - 0.5) / COLOR_SCALE;
        }
        progress((end - start) * 3);
        if (end < numPoints) {
            await tick();
        }
    }
};

const unpackScales = async (
    src: Uint8Array, dst: Float32Array[], numPoints: number, tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const [s0, s1, s2] = dst;
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start, s = start * 3; i < end; i++, s += 3) {
            s0[i] = src[s] / 16 - 10;
            s1[i] = src[s + 1] / 16 - 10;
            s2[i] = src[s + 2] / 16 - 10;
        }
        progress((end - start) * 3);
        if (end < numPoints) {
            await tick();
        }
    }
};

const unpackRotationsSmallestThree = async (
    src: Uint8Array, dst: Float32Array[], numPoints: number, tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const [r0, r1, r2, r3] = dst;
    // scratch quaternion in xyzw order
    const q = new Float64Array(4);
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start, s = start * 4; i < end; i++, s += 4) {
            let comp = (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) >>> 0;
            const iLargest = comp >>> 30;
            let sum = 0;
            for (let j = 3; j >= 0; --j) {
                if (j !== iLargest) {
                    const mag = comp & ROTATION_MASK;
                    const neg = (comp >>> 9) & 1;
                    comp >>>= 10;
                    let value = SQRT1_2 * mag / ROTATION_MASK;
                    if (neg) {
                        value = -value;
                    }
                    q[j] = value;
                    sum += value * value;
                }
            }
            q[iLargest] = Math.sqrt(Math.max(0, 1 - sum));
            // PLY order: rot_0 = w, rot_1 = x, rot_2 = y, rot_3 = z
            r0[i] = q[3];
            r1[i] = q[0];
            r2[i] = q[1];
            r3[i] = q[2];
        }
        progress((end - start) * 4);
        if (end < numPoints) {
            await tick();
        }
    }
};

const unpackRotationsFirstThree = async (
    src: Uint8Array, dst: Float32Array[], numPoints: number, tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const [r0, r1, r2, r3] = dst;
    const scale = 1 / 127.5;
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start, s = start * 3; i < end; i++, s += 3) {
            const x = src[s] * scale - 1;
            const y = src[s + 1] * scale - 1;
            const z = src[s + 2] * scale - 1;
            r0[i] = Math.sqrt(Math.max(0, 1 - (x * x + y * y + z * z)));
            r1[i] = x;
            r2[i] = y;
            r3[i] = z;
        }
        progress((end - start) * 3);
        if (end < numPoints) {
            await tick();
        }
    }
};

const unpackSh = async (
    src: Uint8Array, dst: Float32Array[], shDim: number, numPoints: number,
    tick: () => Promise<void>, progress: (bytes: number) => void
) => {
    const shPerPoint = shDim * 3;
    const scale = 1 / 128;
    for (let start = 0; start < numPoints; start += CHUNK_POINTS) {
        const end = Math.min(start + CHUNK_POINTS, numPoints);
        for (let i = start, s = start * shPerPoint; i < end; i++, s += shPerPoint) {
            for (let k = 0; k < shDim; k++) {
                const b = s + k * 3;
                // file layout is coefficient-major / channel-minor, f_rest is channel-major
                dst[k * 3][i] = (src[b] - 128) * scale;
                dst[k * 3 + 1][i] = (src[b + 1] - 128) * scale;
                dst[k * 3 + 2][i] = (src[b + 2] - 128) * scale;
            }
        }
        progress((end - start) * shPerPoint);
        if (end < numPoints) {
            await tick();
        }
    }
};

// Map `dst[k * 3 + c]` onto f_rest_{c * shDim + k}.
const createShTargets = (attributes: SpzAttributeArrays): Float32Array[] => {
    const targets = new Array<Float32Array>(attributes.shDim * 3);
    for (let c = 0; c < 3; c++) {
        for (let k = 0; k < attributes.shDim; k++) {
            targets[k * 3 + c] = attributes.fRest[c * attributes.shDim + k];
        }
    }
    return targets;
};

const rotationTargets = (a: SpzAttributeArrays) => [a.rot0, a.rot1, a.rot2, a.rot3];

const decodeNgspStreams = async (
    bytes: Uint8Array, layout: SpzNgspLayout, attributes: SpzAttributeArrays, options: SpzDecodeOptions
) => {
    const header = layout.header;
    const decoder = await getZstdDecoder();
    const tick: () => Promise<void> = options.yieldToMainThread === false ? () => Promise.resolve() : delay;
    const total = layout.totalUncompressedBytes;
    const numPoints = header.numPoints;
    let done = 0;
    const progress = (delta: number) => {
        done += delta;
        options.onProgress?.(Math.min(done, total), total);
    };

    const shTargets = header.shDim > 0 ? createShTargets(attributes) : [];

    for (const stream of layout.streams) {
        const compressed = bytes.subarray(stream.compressedOffset, stream.compressedOffset + stream.compressedSize);

        let decompressed: Uint8Array | null = null;
        try {
            decompressed = decoder.decode(compressed, stream.uncompressedSize);
        } catch (err) {
            throw new Error(
                `SPZ: failed to zstd-decompress stream ${stream.index} (${stream.name}): ${errorMessage(err)} ` +
                `(${stream.compressedSize} -> ${stream.uncompressedSize} bytes)`
            );
        }
        if (decompressed.byteLength !== stream.uncompressedSize) {
            throw new Error(
                `SPZ: stream ${stream.index} (${stream.name}) decompressed to ${decompressed.byteLength} bytes, ` +
                `expected ${stream.uncompressedSize}`
            );
        }

        switch (stream.index) {
            case 0:
                await unpackPositions(decompressed, [attributes.x, attributes.y, attributes.z], header, tick, progress);
                break;
            case 1:
                await unpackAlphas(decompressed, attributes.opacity, numPoints, tick, progress);
                break;
            case 2:
                await unpackColors(decompressed, [attributes.fdc0, attributes.fdc1, attributes.fdc2], numPoints, tick, progress);
                break;
            case 3:
                await unpackScales(decompressed, [attributes.scale0, attributes.scale1, attributes.scale2], numPoints, tick, progress);
                break;
            case 4:
                await unpackRotationsSmallestThree(decompressed, rotationTargets(attributes), numPoints, tick, progress);
                break;
            case 5:
                await unpackSh(decompressed, shTargets, header.shDim, numPoints, tick, progress);
                break;
        }

        // release this stream's decompression buffer before the next one
        decompressed = null;
    }
};

const decodeLegacyPayload = async (
    payload: Uint8Array, header: SpzHeader, attributes: SpzAttributeArrays, options: SpzDecodeOptions
) => {
    const tick: () => Promise<void> = options.yieldToMainThread === false ? () => Promise.resolve() : delay;
    const numPoints = header.numPoints;
    const offsets = legacyBlockOffsets(header);
    const rotationBytes = header.usesQuaternionSmallestThree ? 4 : 3;
    const total = numPoints * (9 + 1 + 3 + 3 + rotationBytes + 3 * header.shDim);
    let done = 0;
    const progress = (delta: number) => {
        done += delta;
        options.onProgress?.(Math.min(done, total), total);
    };

    await unpackPositions(payload.subarray(offsets.positions), [attributes.x, attributes.y, attributes.z], header, tick, progress);
    await unpackAlphas(payload.subarray(offsets.alphas), attributes.opacity, numPoints, tick, progress);
    await unpackColors(payload.subarray(offsets.colors), [attributes.fdc0, attributes.fdc1, attributes.fdc2], numPoints, tick, progress);
    await unpackScales(payload.subarray(offsets.scales), [attributes.scale0, attributes.scale1, attributes.scale2], numPoints, tick, progress);
    if (header.usesQuaternionSmallestThree) {
        await unpackRotationsSmallestThree(payload.subarray(offsets.rotations), rotationTargets(attributes), numPoints, tick, progress);
    } else {
        await unpackRotationsFirstThree(payload.subarray(offsets.rotations), rotationTargets(attributes), numPoints, tick, progress);
    }
    if (header.shDim > 0) {
        await unpackSh(payload.subarray(offsets.sh), createShTargets(attributes), header.shDim, numPoints, tick, progress);
    }
};

const buildGSplatData = (attributes: SpzAttributeArrays): GSplatData => {
    const properties = [
        { type: 'float', name: 'x', storage: attributes.x, byteSize: 4 },
        { type: 'float', name: 'y', storage: attributes.y, byteSize: 4 },
        { type: 'float', name: 'z', storage: attributes.z, byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: attributes.fdc0, byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: attributes.fdc1, byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: attributes.fdc2, byteSize: 4 },
        { type: 'float', name: 'opacity', storage: attributes.opacity, byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: attributes.scale0, byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: attributes.scale1, byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: attributes.scale2, byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: attributes.rot0, byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: attributes.rot1, byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: attributes.rot2, byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: attributes.rot3, byteSize: 4 }
    ];

    for (let i = 0; i < attributes.fRest.length; i++) {
        properties.push({ type: 'float', name: `f_rest_${i}`, storage: attributes.fRest[i], byteSize: 4 });
    }

    return new GSplatData([{
        name: 'vertex',
        count: attributes.numPoints,
        properties
    }]);
};

// Decode an entire .spz file (v2 / v3 gzip or v4 NGSP) into PlayCanvas GSplatData.
// Throws a descriptive Error on any malformed input; never returns empty data.
export const decodeSpz = async (bytes: Uint8Array, options: SpzDecodeOptions = {}): Promise<SpzDecodeResult> => {
    const layout = parseSpzLayout(bytes);

    let header: SpzHeader;
    let legacyPayload: Uint8Array | null = null;

    if (layout.kind === 'ngsp') {
        header = layout.header;
    } else {
        try {
            legacyPayload = gunzipSync(bytes);
        } catch (err) {
            throw new Error(`SPZ: failed to gunzip legacy (v2/v3) payload: ${errorMessage(err)}`);
        }
        header = parseLegacySpzHeader(legacyPayload);
    }

    logCoordinateSystem(header);

    if (header.shDegree > 3) {
        throw new Error(
            `SPZ: SH degree ${header.shDegree} (${header.shDim} coefficients per channel) is not supported; ` +
            'PlayCanvas GSplatData supports at most degree 3 (45 f_rest properties)'
        );
    }

    const attributes = allocateAttributes(header);

    if (layout.kind === 'ngsp') {
        await decodeNgspStreams(bytes, layout, attributes, options);
    } else {
        await decodeLegacyPayload(legacyPayload!, header, attributes, options);
        legacyPayload = null;
    }

    return {
        data: buildGSplatData(attributes),
        header
    };
};
