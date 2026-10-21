// SPZ container format: constants, header / TOC parsing and structural validation.
//
// Two on-disk layouts are supported:
//
// - v4 ("NGSP"): 32-byte plaintext header, optional extension records, a table of contents and
//   one ZSTD stream per attribute.
// - v2 / v3: the whole file is a gzip stream whose payload is a 16-byte header followed by the
//   attribute blocks in stream order.
//
// Reference implementation: https://github.com/nianticlabs/spz (src/cc/load-spz.cc,
// src/cc/splat-utils.h).

/** 'NGSP' read as a little-endian u32. */
export const SPZ_MAGIC = 0x5053474e;

// First two bytes of a gzip stream (legacy v2/v3 files).
const SPZ_GZIP_MAGIC_0 = 0x1f;
const SPZ_GZIP_MAGIC_1 = 0x8b;

export const SPZ_V4_VERSION = 4;
export const SPZ_MIN_SUPPORTED_VERSION = 2;
export const SPZ_MAX_SUPPORTED_VERSION = 4;

/** Number of bytes in the plaintext v4 header. */
export const SPZ_V4_HEADER_BYTES = 32;
/** Number of bytes in the legacy (gzip payload) header. */
export const SPZ_LEGACY_HEADER_BYTES = 16;
/** Number of bytes per TOC entry (compressedSize u64 + uncompressedSize u64). */
export const SPZ_TOC_ENTRY_BYTES = 16;

export const SPZ_FLAG_ANTIALIASED = 0x1;
export const SPZ_FLAG_HAS_EXTENSIONS = 0x2;

/** SPZ_ADOBE_coordinate_system extension record type. */
export const SPZ_EXTENSION_COORDINATE_SYSTEM = 0xadbe0003;

/** RDF ("Right Down Front") is the PLY convention this viewer treats as its source space. */
export const SPZ_COORDINATE_SYSTEM_RDF = 6;

/** Number of SH coefficients per colour channel for each degree (indexed by `shDegree`). */
export const SPZ_SH_DIM_BY_DEGREE = [0, 3, 8, 15, 24];

/** Stream names, in the order they appear in the file. */
export const SPZ_STREAM_NAMES = ['positions', 'alphas', 'colors', 'scales', 'rotations', 'sh'];

const INT32_MAX = 0x7fffffff;

export interface SpzHeader {
    /** 2, 3 or 4. */
    version: number;
    numPoints: number;
    shDegree: number;
    fractionalBits: number;
    flags: number;
    numStreams: number;
    /** Byte offset of the TOC (v4 only). */
    tocByteOffset: number;
    antialiased: boolean;
    hasExtensions: boolean;
    /** true for v3+, false for legacy v2 (xyz stored as int8, w reconstructed). */
    usesQuaternionSmallestThree: boolean;
    /** true for v1 (float16 positions). Never supported, kept for diagnostics. */
    usesFloat16: boolean;
    /** Number of SH coefficients per colour channel. */
    shDim: number;
    /** Coordinate system recorded in a SPZ_ADOBE_coordinate_system extension, if present. */
    coordinateSystem: number | null;
}

export interface SpzStream {
    index: number;
    name: string;
    /** Byte offset of the compressed payload inside the source file. */
    compressedOffset: number;
    compressedSize: number;
    uncompressedSize: number;
}

export interface SpzNgspLayout {
    kind: 'ngsp';
    header: SpzHeader;
    streams: SpzStream[];
    /** Total uncompressed bytes across every stream (useful for progress reporting). */
    totalUncompressedBytes: number;
}

export interface SpzGzipLayout {
    kind: 'gzip';
    /** Header is only available once the gzip payload has been inflated. */
    header: null;
}

export type SpzLayout = SpzNgspLayout | SpzGzipLayout;

const fail = (message: string): never => {
    throw new Error(`SPZ: ${message}`);
};

const hexByte = (value: number) => `0x${(value & 0xff).toString(16).padStart(2, '0')}`;

// SH coefficients per colour channel for a given degree.
export const shDimForDegree = (shDegree: number): number => {
    if (shDegree < 0 || shDegree >= SPZ_SH_DIM_BY_DEGREE.length) {
        fail(`unsupported SH degree ${shDegree} (expected 0..4)`);
    }
    return SPZ_SH_DIM_BY_DEGREE[shDegree];
};

// Uncompressed byte count of each stream, in file order.
// Positions are always int24 and v4 rotations are always 4 bytes (smallest-three).
export const expectedStreamSizes = (numPoints: number, shDegree: number): number[] => {
    const shDim = shDimForDegree(shDegree);
    const sizes = [
        numPoints * 9, // positions: 3 x int24
        numPoints, // alphas
        numPoints * 3, // colors
        numPoints * 3, // scales
        numPoints * 4 // rotations (smallest-three)
    ];
    if (shDim > 0) {
        sizes.push(numPoints * 3 * shDim);
    }
    return sizes;
};

// Validate a point count against the file size so a corrupt header can't drive a huge allocation.
const checkPointCount = (numPoints: number, fileSize: number, context: string) => {
    if (!Number.isFinite(numPoints) || numPoints <= 0) {
        fail(`${context}: invalid point count ${numPoints}`);
    }
    if (numPoints > INT32_MAX) {
        fail(`${context}: point count ${numPoints} exceeds INT32_MAX`);
    }
    // Generous upper bound (matches the reference loader): at most ~1024x compression and at
    // least 9 bytes per point (the positions stream).
    const maxPoints = Math.floor((fileSize * 1024) / 9);
    if (numPoints > maxPoints) {
        fail(`${context}: point count ${numPoints} is impossible for a ${fileSize} byte file (max ${maxPoints})`);
    }
};

const checkShDegree = (shDegree: number, context: string) => {
    if (shDegree < 0 || shDegree > 4) {
        fail(`${context}: unsupported SH degree ${shDegree} (expected 0..4)`);
    }
};

const checkFractionalBits = (fractionalBits: number, context: string) => {
    if (fractionalBits > 24) {
        fail(`${context}: invalid fractionalBits ${fractionalBits} (expected 0..24)`);
    }
};

// Parse the extension record stream: repeated [u32 type][u32 byteLength][payload].
export const parseSpzExtensions = (bytes: Uint8Array, start: number, end: number): { coordinateSystem: number | null } => {
    let offset = start;
    let coordinateSystem: number | null = null;
    while (offset + 8 <= end) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, end - offset);
        const type = view.getUint32(0, true);
        const byteLength = view.getUint32(4, true);
        const payloadOffset = offset + 8;
        if (payloadOffset + byteLength > end) {
            fail(`extension record 0x${type.toString(16)} overruns the extension area (${byteLength} bytes, ${end - payloadOffset} available)`);
        }
        if (type === SPZ_EXTENSION_COORDINATE_SYSTEM && byteLength >= 4) {
            coordinateSystem = new DataView(bytes.buffer, bytes.byteOffset + payloadOffset, 4).getUint32(0, true);
        }
        offset = payloadOffset + byteLength;
    }
    return { coordinateSystem };
};

const parseNgsp = (bytes: Uint8Array): SpzNgspLayout => {
    const fileSize = bytes.byteLength;
    if (fileSize < SPZ_V4_HEADER_BYTES) {
        fail(`v4 header truncated: file is ${fileSize} bytes, need ${SPZ_V4_HEADER_BYTES}`);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, fileSize);
    const version = view.getUint32(4, true);
    if (version !== SPZ_V4_VERSION) {
        fail(`unsupported NGSP version ${version} (expected ${SPZ_V4_VERSION})`);
    }

    const numPoints = view.getUint32(8, true);
    const shDegree = view.getUint8(12);
    const fractionalBits = view.getUint8(13);
    const flags = view.getUint8(14);
    const numStreams = view.getUint8(15);
    const tocByteOffset = view.getUint32(16, true);

    checkPointCount(numPoints, fileSize, 'v4 header');
    checkShDegree(shDegree, 'v4 header');
    checkFractionalBits(fractionalBits, 'v4 header');

    const expectedStreams = shDegree === 0 ? 5 : 6;
    if (numStreams !== expectedStreams) {
        fail(`v4 header: numStreams is ${numStreams}, expected ${expectedStreams} for SH degree ${shDegree}`);
    }
    if (tocByteOffset < SPZ_V4_HEADER_BYTES) {
        fail(`v4 header: tocByteOffset ${tocByteOffset} is inside the ${SPZ_V4_HEADER_BYTES} byte header`);
    }

    const tocEnd = tocByteOffset + numStreams * SPZ_TOC_ENTRY_BYTES;
    if (tocEnd > fileSize) {
        fail(`v4 header: TOC ends at ${tocEnd}, past end of ${fileSize} byte file`);
    }

    const sizes = expectedStreamSizes(numPoints, shDegree);
    const streams: SpzStream[] = [];
    let compressedOffset = tocEnd;
    let totalUncompressed = 0;

    for (let i = 0; i < numStreams; i++) {
        const entry = tocByteOffset + i * SPZ_TOC_ENTRY_BYTES;
        const compressedSize = Number(view.getBigUint64(entry, true));
        const uncompressedSize = Number(view.getBigUint64(entry + 8, true));
        const name = SPZ_STREAM_NAMES[i];
        const expectedSize = sizes[i];

        if (uncompressedSize !== expectedSize) {
            fail(`stream ${i} (${name}) uncompressed size mismatch: expected ${expectedSize}, got ${uncompressedSize}`);
        }
        if (compressedOffset + compressedSize > fileSize) {
            fail(`stream ${i} (${name}) extends past end of file: offset ${compressedOffset}, size ${compressedSize}, file size ${fileSize}`);
        }

        streams.push({
            index: i,
            name,
            compressedOffset,
            compressedSize,
            uncompressedSize
        });
        compressedOffset += compressedSize;
        totalUncompressed += uncompressedSize;
    }

    if (compressedOffset !== fileSize) {
        fail(`compressed streams end at ${compressedOffset}, expected end of file (${fileSize}); ${fileSize - compressedOffset} trailing bytes`);
    }

    const hasExtensions = (flags & SPZ_FLAG_HAS_EXTENSIONS) !== 0;
    let coordinateSystem: number | null = null;
    if (hasExtensions && tocByteOffset > SPZ_V4_HEADER_BYTES) {
        coordinateSystem = parseSpzExtensions(bytes, SPZ_V4_HEADER_BYTES, tocByteOffset).coordinateSystem;
    }

    return {
        kind: 'ngsp',
        header: {
            version,
            numPoints,
            shDegree,
            fractionalBits,
            flags,
            numStreams,
            tocByteOffset,
            antialiased: (flags & SPZ_FLAG_ANTIALIASED) !== 0,
            hasExtensions,
            usesQuaternionSmallestThree: true,
            usesFloat16: false,
            shDim: shDimForDegree(shDegree),
            coordinateSystem
        },
        streams,
        totalUncompressedBytes: totalUncompressed
    };
};

// Parse the header of a gzip-inflated legacy (v2/v3) payload.
export const parseLegacySpzHeader = (payload: Uint8Array): SpzHeader => {
    const size = payload.byteLength;
    if (size < SPZ_LEGACY_HEADER_BYTES) {
        fail(`legacy header truncated: inflated payload is ${size} bytes, need ${SPZ_LEGACY_HEADER_BYTES}`);
    }

    const view = new DataView(payload.buffer, payload.byteOffset, size);
    const magic = view.getUint32(0, true);
    if (magic !== SPZ_MAGIC) {
        fail(`legacy header magic mismatch: expected 0x${SPZ_MAGIC.toString(16)} (NGSP), got 0x${magic.toString(16)}`);
    }

    const version = view.getUint32(4, true);
    if (version < SPZ_MIN_SUPPORTED_VERSION) {
        if (version === 1) {
            fail('legacy version 1 (float16 positions) is not supported');
        }
        fail(`unsupported legacy version ${version} (expected ${SPZ_MIN_SUPPORTED_VERSION}..${SPZ_MAX_SUPPORTED_VERSION})`);
    }
    if (version > SPZ_MAX_SUPPORTED_VERSION) {
        fail(`unsupported legacy version ${version} (expected ${SPZ_MIN_SUPPORTED_VERSION}..${SPZ_MAX_SUPPORTED_VERSION})`);
    }

    const numPoints = view.getUint32(8, true);
    const shDegree = view.getUint8(12);
    const fractionalBits = view.getUint8(13);
    const flags = view.getUint8(14);

    checkPointCount(numPoints, size, `legacy v${version} header`);
    checkShDegree(shDegree, `legacy v${version} header`);
    checkFractionalBits(fractionalBits, `legacy v${version} header`);

    const shDim = shDimForDegree(shDegree);
    const usesQuaternionSmallestThree = version >= 3;
    const rotationBytes = usesQuaternionSmallestThree ? 4 : 3;
    const expectedBytes =
        SPZ_LEGACY_HEADER_BYTES +
        numPoints * 9 +
        numPoints +
        numPoints * 3 +
        numPoints * 3 +
        numPoints * rotationBytes +
        numPoints * 3 * shDim;

    if (size < expectedBytes) {
        fail(`legacy v${version} payload is ${size} bytes, expected at least ${expectedBytes} for ${numPoints} points (SH degree ${shDegree})`);
    }

    const hasExtensions = (flags & SPZ_FLAG_HAS_EXTENSIONS) !== 0;
    let coordinateSystem: number | null = null;
    if (hasExtensions && size > expectedBytes) {
        coordinateSystem = parseSpzExtensions(payload, expectedBytes, size).coordinateSystem;
    }

    return {
        version,
        numPoints,
        shDegree,
        fractionalBits,
        flags,
        numStreams: shDegree === 0 ? 5 : 6,
        tocByteOffset: 0,
        antialiased: (flags & SPZ_FLAG_ANTIALIASED) !== 0,
        hasExtensions,
        usesQuaternionSmallestThree,
        usesFloat16: false,
        shDim,
        coordinateSystem
    };
};

// Detect the container layout by inspecting the first bytes of the file.
// Throws (via parseNgsp) when a recognized v4 header is structurally invalid.
export const parseSpzLayout = (bytes: Uint8Array): SpzLayout => {
    if (bytes.byteLength >= 4) {
        const magic = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
        if ((magic >>> 0) === SPZ_MAGIC) {
            return parseNgsp(bytes);
        }
    }
    if (bytes.byteLength >= 2 && bytes[0] === SPZ_GZIP_MAGIC_0 && bytes[1] === SPZ_GZIP_MAGIC_1) {
        return { kind: 'gzip', header: null };
    }

    const head = Array.from(bytes.subarray(0, Math.min(4, bytes.byteLength))).map(hexByte).join(' ');
    return fail(`unrecognized file signature (first bytes: ${head}); expected "NGSP" or a gzip stream (1f 8b)`);
};

// Byte offsets of the legacy attribute blocks inside the inflated payload.
export const legacyBlockOffsets = (header: SpzHeader) => {
    const numPoints = header.numPoints;
    const rotationBytes = header.usesQuaternionSmallestThree ? 4 : 3;
    return {
        positions: SPZ_LEGACY_HEADER_BYTES,
        alphas: SPZ_LEGACY_HEADER_BYTES + numPoints * 9,
        colors: SPZ_LEGACY_HEADER_BYTES + numPoints * 10,
        scales: SPZ_LEGACY_HEADER_BYTES + numPoints * 13,
        rotations: SPZ_LEGACY_HEADER_BYTES + numPoints * 16,
        sh: SPZ_LEGACY_HEADER_BYTES + numPoints * (16 + rotationBytes)
    };
};
