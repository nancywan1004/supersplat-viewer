# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-jinanqiao-v3-x10_bootstrapPoll_after_v1.json

- 采样帧：111989；累计采样时间 ~29307 ms
- GC 占比：0.5%（~134 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 19973.5 | 76586 |
| viewer-bundle | 4534.5 | 16993 |
| playcanvas | 4236.2 | 16267 |
| gsplat-engine | 254.9 | 996 |
| octree-lod | 137.2 | 526 |
| gc | 134.5 | 480 |
| refinement-controller | 36.2 | 140 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `findAllOctreeInstances` L101676 · index.js
- `syncStreamingOctreePlacements` L103444 · index.js
- `syncOctreePendingPlacements` L103021 · index.js
- `requestOctreePlacementUpdate` L13312 · playcanvas-2.20.0.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `runPriorityPrefetch` L103915 · index.js
- `buildPriorityFiles` L103450 · index.js
- `trackSyncOctreePendingPlacements` L103015 · index.js
- `hasSyncedOctreeThisFrame` L103002 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `markSyncedOctreeThisFrame` L103006 · index.js
- `buildPriorityFilesIncremental` L103227 · index.js
- `getOctreeUrlToFileIndex` L102539 · index.js
- `isFileBoundToOctreeInstance` L102553 · index.js
- `getOctreeInstancesMap` L101657 · index.js
- `octree.ensureFileResource` L102386 · index.js
- `clearSyncedOctreesThisFrame` L102977 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
