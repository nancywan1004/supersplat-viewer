# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-jinanqiao-v3-x10_bootstrapPoll_before_v1.json

- 采样帧：129647；累计采样时间 ~33295 ms
- GC 占比：0.7%（~224 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| viewer-bundle | 14470.7 | 56690 |
| octree-lod | 9729.6 | 38092 |
| playcanvas | 6348.4 | 24982 |
| other | 2257.8 | 7982 |
| gsplat-engine | 246.0 | 975 |
| gc | 223.7 | 848 |
| refinement-controller | 19.2 | 77 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `findAllOctreeInstances` L101676 · index.js
- `getOctreeInstancesMap` L101657 · index.js
- `getOctreeBootstrapLod` L101648 · index.js
- `syncStreamingOctreePlacements` L103444 · index.js
- `markSyncedOctreeThisFrame` L103006 · index.js
- `syncOctreePendingPlacements` L103021 · index.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `worldOwnsOctree` L101663 · index.js
- `hasSyncedOctreeThisFrame` L103002 · index.js
- `runPriorityPrefetch` L103915 · index.js
- `buildPriorityFiles` L103450 · index.js
- `trackSyncOctreePendingPlacements` L103015 · index.js
- `getOctreeUrlToFileIndex` L102539 · index.js
- `buildPriorityFilesIncremental` L103227 · index.js
- `isFileBoundToOctreeInstance` L102553 · index.js
- `octree.ensureFileResource` L102386 · index.js
- `clearSyncedOctreesThisFrame` L102977 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
