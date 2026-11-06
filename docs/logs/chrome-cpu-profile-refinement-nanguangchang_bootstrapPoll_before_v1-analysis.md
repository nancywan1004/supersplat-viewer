# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-nanguangchang_bootstrapPoll_before_v1.json

- 采样帧：114102；累计采样时间 ~29476 ms
- GC 占比：1.0%（~284 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 12219.5 | 46813 |
| viewer-bundle | 10726.9 | 41867 |
| playcanvas | 5198.9 | 20287 |
| octree-lod | 839.8 | 3270 |
| gc | 284.0 | 1048 |
| gsplat-engine | 157.4 | 623 |
| refinement-controller | 49.3 | 193 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `findAllOctreeInstances` L101676 · index.js
- `getOctreeBootstrapLod` L101648 · index.js
- `createOctreeRefinementController` L103713 · index.js
- `ensureOctreeLeafSpatialIndex` L102037 · index.js
- `runPriorityPrefetch` L103915 · index.js
- `buildPriorityFiles` L103450 · index.js
- `syncStreamingOctreePlacements` L103444 · index.js
- `syncOctreePendingPlacements` L103021 · index.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `worldOwnsOctree` L101663 · index.js
- `hasSyncedOctreeThisFrame` L103002 · index.js
- `markSyncedOctreeThisFrame` L103006 · index.js
- `trackSyncOctreePendingPlacements` L103015 · index.js
- `getOctreeUrlToFileIndex` L102539 · index.js
- `buildPriorityFilesIncremental` L103227 · index.js
- `isFileBoundToOctreeInstance` L102553 · index.js
- `clearSyncedOctreesThisFrame` L102977 · index.js
- `octree.ensureFileResource` L102386 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
