import { zipSync, strToU8 } from 'fflate';
import {
    findProjectSettingsPath,
    guessPackedContentPath,
    hasExplicitContentQueryParam,
    packedContentRelativePath,
    parseProjectBlobs,
    parseProjectZipBytes
} from './project-pack-parse';

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

console.log('project-pack.test.ts: ok');
