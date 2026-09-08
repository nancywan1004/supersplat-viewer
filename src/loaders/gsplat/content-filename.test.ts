import { contentFilenameFromUrl } from './content-filename';

const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
};

assert(contentFilenameFromUrl('https://x/a/flower.sog') === 'flower.sog', 'http path');
assert(contentFilenameFromUrl('blob:https://x/abc-def#flower.sog') === 'flower.sog', 'blob hash');
assert(contentFilenameFromUrl('blob:https://x/abc-def#content%2Fflower.sog') === 'content/flower.sog', 'encoded hash');
assert(contentFilenameFromUrl('/assets/gsplat/a.splat') === 'a.splat', 'root path');

console.log('content-filename.test.ts: ok');
