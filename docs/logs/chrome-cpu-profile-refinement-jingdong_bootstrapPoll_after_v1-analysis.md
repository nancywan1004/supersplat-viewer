# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-jingdong_bootstrapPoll_after_v1.json

- 采样帧：111777；累计采样时间 ~28925 ms
- GC 占比：0.5%（~145 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 24779.1 | 95884 |
| playcanvas | 2127.3 | 8229 |
| viewer-bundle | 1713.0 | 6551 |
| gc | 144.7 | 488 |
| gsplat-engine | 96.7 | 379 |
| refinement-controller | 36.3 | 139 |
| octree-lod | 27.6 | 106 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `findAllOctreeInstances` L101676 · index.js
- `runPriorityPrefetch` L103915 · index.js
- `buildPriorityFiles` L103450 · index.js
- `trackSyncOctreePendingPlacements` L103015 · index.js
- `syncOctreePendingPlacements` L103021 · index.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `hasSyncedOctreeThisFrame` L103002 · index.js
- `markSyncedOctreeThisFrame` L103006 · index.js
- `getOctreeUrlToFileIndex` L102539 · index.js
- `ensureOctreeLeafSpatialIndex` L102037 · index.js
- `octree.ensureFileResource` L102386 · index.js
- `clearSyncedOctreesThisFrame` L102977 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
