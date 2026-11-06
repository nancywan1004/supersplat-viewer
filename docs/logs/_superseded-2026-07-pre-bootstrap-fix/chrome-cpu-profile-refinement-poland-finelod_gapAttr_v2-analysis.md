# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-poland-finelod_gapAttr_v2.json

- 采样帧：434713；累计采样时间 ~112370 ms
- GC 占比：1.5%（~1735 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| octree-lod | 47036.0 | 183717 |
| viewer-bundle | 31438.3 | 122834 |
| playcanvas | 20057.7 | 78354 |
| other | 5769.5 | 18944 |
| gsplat-engine | 5519.7 | 21461 |
| gc | 1735.2 | 6220 |
| refinement-controller | 813.7 | 3181 |
| profiler | 0.3 | 1 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101603 · index.js
- `findAllOctreeInstances` L101627 · index.js
- `getOctreeInstancesMap` L101608 · index.js
- `getOctreeBootstrapLod` L101599 · index.js
- `syncStreamingOctreePlacements` L103661 · index.js
- `syncOctreePendingPlacements` L103237 · index.js
- `requestOctreePlacementUpdate` L101718 · index.js
- `findGsplatWorldsForOctree` L101665 · index.js
- `hasSyncedOctreeThisFrame` L103218 · index.js
- `markSyncedOctreeThisFrame` L103222 · index.js
- `runPriorityPrefetch` L104154 · index.js
- `buildPriorityFiles` L103667 · index.js
- `ensureOctreeLeafSpatialIndex` L101988 · index.js
- `trackSyncOctreePendingPlacements` L103231 · index.js
- `getOctreeUrlToFileIndex` L102755 · index.js
- `buildPriorityFilesIncremental` L103443 · index.js
- `clearSyncedOctreesThisFrame` L103193 · index.js
- `octree.ensureFileResource` L102602 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
