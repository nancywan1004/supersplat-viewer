import {
    httpStatusFromUnknown,
    isMainSceneModifiedForHostSave,
    outboundLoadRequestId,
    readHostRequestId,
    readInboundRequestId,
    resolveSettingsSaveDestination,
    toViewerLoadError,
    ViewerLoadError
} from './host-protocol';

const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
};

assert(resolveSettingsSaveDestination('host') === 'host', 'host dest');
assert(resolveSettingsSaveDestination('local') === 'host', 'postMessage local is host');
assert(resolveSettingsSaveDestination('universe') === 'universe', 'universe dest');
assert(resolveSettingsSaveDestination(undefined) === 'universe', 'default dest');
assert(resolveSettingsSaveDestination('other') === 'universe', 'invalid dest');

assert(readHostRequestId('?requestId=load-1') === 'load-1', 'url requestId');
assert(readHostRequestId('?settings=/a.json') === undefined, 'no requestId');
assert(readInboundRequestId({ requestId: 'save-2' }) === 'save-2', 'inbound requestId');
assert(readInboundRequestId({ requestId: '  ' }) === undefined, 'blank requestId');
assert(outboundLoadRequestId('load-cfg') === 'load-cfg', 'config requestId');

const tagged = new ViewerLoadError('加载主场景失败: HTTP 404', { stage: 'content', status: 404, url: 'https://cdn/a.sog' });
assert(tagged.stage === 'content', 'tagged stage');
assert(httpStatusFromUnknown(tagged) === 404, 'tagged status');
assert(httpStatusFromUnknown(new Error('Failed 404')) === 404, 'parse status');
assert(toViewerLoadError('bad json', 'settings').stage === 'settings', 'wrap stage');

assert(isMainSceneModifiedForHostSave({
    contentUrl: 'https://cdn/a.sog',
    originalContentUrl: 'https://cdn/a.sog'
}) === false, 'unchanged remote');

assert(isMainSceneModifiedForHostSave({
    contentUrl: 'blob:https://viewer/1#scene.sog',
    originalContentUrl: 'blob:https://viewer/1#scene.sog'
}) === true, 'blob owned');

assert(isMainSceneModifiedForHostSave({
    contentUrl: 'blob:https://viewer/2#edited.sog',
    originalContentUrl: 'https://cdn/a.sog'
}) === true, 'replaced model');

console.log('host-save.test.ts: ok');
