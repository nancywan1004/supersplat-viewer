import {
    annotationMediaFromUnknown,
    annotationDataToSettings,
    writeAnnotationMediaToSettingsRecord
} from './media-fields';

const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
};

const fromUrl = annotationMediaFromUnknown({ imageUrl: 'assets/annotation.png' });
assert(fromUrl.imageUrl === 'assets/annotation.png', 'imageUrl');

const fromSlot = annotationMediaFromUnknown({ image: 'assets/annotation.png' });
assert(fromSlot.imageUrl === 'assets/annotation.png', 'image slot');

const videoWins = annotationMediaFromUnknown({
    imageUrl: 'assets/a.png',
    videoUrl: 'assets/b.mp4'
});
assert(videoWins.videoUrl === 'assets/b.mp4' && !videoWins.imageUrl, 'video wins');

const rec: Record<string, unknown> = { id: 'a1', image: 'assets/annotation.png' };
writeAnnotationMediaToSettingsRecord(rec);
assert(rec.imageUrl === 'assets/annotation.png', 'hoist imageUrl');
assert(!('image' in rec), 'drop image slot');

const settings = annotationDataToSettings({
    id: 'a1',
    position: [0, 0, 0],
    title: 't',
    text: 'b',
    image: 'assets/annotation.png',
    showTitleWhenCollapsed: false,
    collapsed: false
});
assert(settings.imageUrl === 'assets/annotation.png', 'settings imageUrl');
assert(!('image' in settings), 'settings has no image slot');

console.log('media-fields.test.ts: ok');
