# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-jingdong_bootstrapPoll_before_v1.json

- 采样帧：113194；累计采样时间 ~29425 ms
- GC 占比：0.8%（~223 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 18246.8 | 70412 |
| viewer-bundle | 7569.1 | 29024 |
| playcanvas | 2704.3 | 10312 |
| octree-lod | 561.8 | 2168 |
| gc | 223.3 | 811 |
| gsplat-engine | 89.2 | 348 |
| refinement-controller | 30.3 | 119 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `findAllOctreeInstances` L101676 · index.js
- `getOctreeBootstrapLod` L101648 · index.js
- `getOctreeInstancesMap` L101657 · index.js
- `syncStreamingOctreePlacements` L103444 · index.js
- `syncOctreePendingPlacements` L103021 · index.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `worldOwnsOctree` L101663 · index.js
- `markSyncedOctreeThisFrame` L103006 · index.js
- `hasSyncedOctreeThisFrame` L103002 · index.js
- `runPriorityPrefetch` L103915 · index.js
- `buildPriorityFiles` L103450 · index.js
- `trackSyncOctreePendingPlacements` L103015 · index.js
- `ensureOctreeLeafSpatialIndex` L102037 · index.js
- `getOctreeUrlToFileIndex` L102539 · index.js
- `octree.ensureFileResource` L102386 · index.js
- `clearSyncedOctreesThisFrame` L102977 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
