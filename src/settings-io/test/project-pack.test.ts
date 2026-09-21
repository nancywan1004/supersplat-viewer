import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import { path as enginePath } from 'playcanvas';
import { zipSettingsArchive } from '../pack';
import {
    findProjectSettingsPath,
    guessPackedContentPath,
    hasExplicitContentQueryParam,
    isLodMetaFilename,
    isPackedContentFilename,
    isPackedSceneFilename,
    lodChunkBasenameFromUrl,
    lodChunkPackRelativePath,
    packedContentRelativePath,
    parseProjectBlobs,
    parseProjectZipBytes
} from '../project-pack-parse';

const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
};

assert(hasExplicitContentQueryParam('?content=/a.sog'), 'query content');
assert(!hasExplicitContentQueryParam('?settings=/a.json'), 'no content query');
assert(packedContentRelativePath('flower.sog') === 'content/flower.sog', 'pack path');
assert(packedContentRelativePath('/assets/gsplat/flower.sog') === 'content/flower.sog', 'basename');

assert(findProjectSettingsPath(['proj/settings.json', 'proj/assets/a.glb']) === 'proj/settings.json', 'settings path');
assert(findProjectSettingsPath(['__MACOSX/settings.json', 'settings.json']) === 'settings.json', 'root settings');

const guessed = guessPackedContentPath(['content/flower.sog', 'assets/a.glb'], { content: 'content/flower.sog' });
assert(guessed === 'content/flower.sog', 'guess from settings');

const guessedFile = guessPackedContentPath(['content/scene.sog'], {});
assert(guessedFile === 'content/scene.sog', 'guess from files');

const settingsBlob = new Blob([JSON.stringify({ version: 2, content: 'content/flower.sog' })], { type: 'application/json' });
const sceneBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' });
const pack = await parseProjectBlobs([
    { path: 'demo/settings.json', blob: settingsBlob },
    { path: 'demo/content/flower.sog', blob: sceneBlob },
    { path: 'demo/assets/foo.glb', blob: new Blob(['glb']) }
]);
assert((pack.settings as { content?: string }).content === 'content/flower.sog', 'parsed settings');
assert(pack.files.get('content/flower.sog') === sceneBlob, 'parsed scene');
assert(pack.files.has('assets/foo.glb'), 'parsed asset');

const zipped = zipSync({
    'settings.json': strToU8(JSON.stringify({ version: 2, content: 'content/a.sog' })),
    'content/a.sog': new Uint8Array([9, 9])
});
const fromZip = await parseProjectZipBytes(zipped);
assert(fromZip.files.has('content/a.sog'), 'zip scene');

assert(isLodMetaFilename('content/lod-meta.json'), 'lod meta name');
assert(isLodMetaFilename('/x/LOD-META.JSON'), 'lod meta case');
assert(!isLodMetaFilename('content/meta.json'), 'plain meta is not lod');
assert(isPackedContentFilename('content/lod-meta.json'), 'lod meta is packed content');
assert(isPackedContentFilename('content/flower.sog'), 'sog is packed content');
assert(!isPackedSceneFilename('content/lod-meta.json'), 'lod meta is not single-file scene');

assert(lodChunkPackRelativePath('0.sog') === 'content/0.sog', 'lod chunk path');
assert(lodChunkPackRelativePath('lod-1/sub/0.sog') === 'content/lod-1/sub/0.sog', 'lod chunk subdir');
assert(lodChunkPackRelativePath('/abs/0.sog') === null, 'lod chunk absolute path rejected');
assert(lodChunkPackRelativePath('../0.sog') === null, 'lod chunk parent escape rejected');
assert(lodChunkPackRelativePath('https://cdn.x/0.sog') === null, 'lod chunk url rejected');
assert(lodChunkPackRelativePath('blob:http://x/uuid') === null, 'lod chunk blob rejected');
assert(lodChunkBasenameFromUrl('https://cdn.x/lod/0.sog') === '0.sog', 'lod chunk url basename');
assert(lodChunkBasenameFromUrl('blob:http://x/uuid') === null, 'lod chunk no basename for blob');

const lodSettings = new Blob([JSON.stringify({ version: 1, content: 'content/lod-meta.json' })], { type: 'application/json' });
const lodPack = await parseProjectBlobs([
    { path: 'demo/settings.json', blob: lodSettings },
    { path: 'demo/content/lod-meta.json', blob: new Blob(['{"filenames":["0.sog"]}']) },
    { path: 'demo/content/0.sog', blob: sceneBlob }
]);
assert(
    guessPackedContentPath(lodPack.files.keys(), lodPack.settings) === 'content/lod-meta.json',
    'lod meta guessed from settings'
);
assert(lodPack.files.has('content/0.sog'), 'lod chunk parsed');

const zipProgress: Array<{ done: number; total: number; bytes: number }> = [];
const zipSettingsJson = JSON.stringify({ version: 2, content: 'content/lod-meta.json' });
const zipMetaText = '{"filenames":["0.sog"]}';
const zipBlob = await zipSettingsArchive(
    zipSettingsJson,
    [
        ['content/lod-meta.json', new Blob([zipMetaText])],
        ['content/lod-1/0.sog', new Blob([new Uint8Array([1, 2, 3])])]
    ],
    { onProgress: progress => zipProgress.push({ ...progress }) }
);
assert(zipBlob.type === 'application/zip', 'zip mime');
const unzipped = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
assert(strFromU8(unzipped['settings.json']).includes('lod-meta.json'), 'zip settings.json');
assert(unzipped['content/lod-meta.json'] !== undefined, 'zip lod meta');
assert(unzipped['content/lod-1/0.sog'] !== undefined, 'zip lod chunk subdir');
assert(zipProgress[0].done === 0 && zipProgress[0].total === 3, 'zip progress start');
assert(
    zipProgress[zipProgress.length - 1].done === 3 && zipProgress[zipProgress.length - 1].total === 3,
    'zip progress end'
);
assert(
    zipProgress[zipProgress.length - 1].bytes === zipSettingsJson.length + zipMetaText.length + 3,
    'zip progress bytes'
);

let badPathRejected = false;
try {
    await zipSettingsArchive('{}', [['../evil.sog', new Blob(['x'])]]);
} catch {
    badPathRejected = true;
}
assert(badPathRejected, 'zip rejects escaping path');

// 中途取消：写完第一个文件后 abort，打包应停下并抛错
const abortController = new AbortController();
let zipAborted = false;
try {
    await zipSettingsArchive('{}', [['content/a.sog', new Blob([new Uint8Array(1024)])]], {
        signal: abortController.signal,
        onProgress: (progress) => {
            if (progress.done === 1) abortController.abort();
        }
    });
} catch {
    zipAborted = true;
}
assert(zipAborted, 'zip stops on abort signal');

// 注入的 blob 分块 URL 必须带 `#<文件名>`：
// 引擎 GSplatHandler._getParser 按 URL basename 的扩展名选解析器，而分块 Asset 由
// GSplatAssetLoader 创建（`new Asset(url, 'gsplat', { url })`，没有 filename），只能用 URL 本身，
// 无扩展名会落到 PLY 兜底 → "Invalid ply header"。`_getUrlWithoutParams` 只截 `?`，故扩展名必须放 `#`。
// 下面是引擎 `_getParser` 的等价复刻（playcanvas: framework/handlers/gsplat.js）。
const parserForGsplatUrl = (url: string): string => {
    const withoutParams = url.indexOf('?') >= 0 ? url.split('?')[0] : url;
    const basename = enginePath.getBasename(withoutParams).toLowerCase();
    if (basename === 'lod-meta.json') return 'octree';
    const ext = enginePath.getExtension(basename).replace('.', '');
    const parsers: Record<string, string> = { ply: 'ply', sog: 'sog', json: 'json', octree: 'octree' };
    return parsers[ext] || 'ply';
};
assert(parserForGsplatUrl('blob:http://h/uuid') === 'ply', '无扩展名 blob 分块落到 ply 兜底');
assert(parserForGsplatUrl('blob:http://h/uuid#0.sog') === 'sog', '带 #文件名 的 blob 分块按扩展名解析');
assert(parserForGsplatUrl('blob:http://h/uuid#lod-1/0.ply') === 'ply', '子目录分块同样按扩展名解析');
assert(parserForGsplatUrl('content/0.sog') === 'sog', '服务端相对路径分块不受影响');

console.log('project-pack.test.ts: ok');
