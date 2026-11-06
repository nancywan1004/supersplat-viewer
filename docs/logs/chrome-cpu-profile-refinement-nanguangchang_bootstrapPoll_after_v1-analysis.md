# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-nanguangchang_bootstrapPoll_after_v1.json

- 采样帧：113240；累计采样时间 ~29169 ms
- GC 占比：0.7%（~193 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 19726.4 | 76290 |
| viewer-bundle | 5182.6 | 20360 |
| playcanvas | 3513.8 | 13728 |
| octree-lod | 367.5 | 1428 |
| gc | 193.1 | 699 |
| gsplat-engine | 147.6 | 587 |
| refinement-controller | 37.9 | 148 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `findAllOctreeInstances` L101676 · index.js
- `createOctreeRefinementController` L103713 · index.js
- `ensureOctreeLeafSpatialIndex` L102037 · index.js
- `runPriorityPrefetch` L103915 · index.js
- `buildPriorityFiles` L103450 · index.js
- `syncStreamingOctreePlacements` L103444 · index.js
- `syncOctreePendingPlacements` L103021 · index.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `worldOwnsOctree` L101663 · index.js
- `markSyncedOctreeThisFrame` L103006 · index.js
- `hasSyncedOctreeThisFrame` L103002 · index.js
- `isFileBoundToOctreeInstance` L102553 · index.js
- `trackSyncOctreePendingPlacements` L103015 · index.js
- `buildPriorityFilesIncremental` L103227 · index.js
- `getOctreeUrlToFileIndex` L102539 · index.js
- `octree.ensureFileResource` L102386 · index.js
- `clearSyncedOctreesThisFrame` L102977 · index.js
- `getOctreeBootstrapLod` L101648 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
