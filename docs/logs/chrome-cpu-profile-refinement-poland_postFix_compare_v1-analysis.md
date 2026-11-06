# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-poland_postFix_compare_v1.json

- 采样帧：125102；累计采样时间 ~32774 ms
- GC 占比：1.5%（~489 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 19669.1 | 73719 |
| playcanvas | 5842.7 | 23026 |
| viewer-bundle | 4811.2 | 18858 |
| octree-lod | 996.2 | 3911 |
| gsplat-engine | 947.0 | 3724 |
| gc | 488.6 | 1790 |
| refinement-controller | 18.9 | 74 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101603 · index.js
- `getOctreeBootstrapLod` L101599 · index.js
- `runPriorityPrefetch` L103866 · index.js
- `buildPriorityFiles` L103401 · index.js
- `findAllOctreeInstances` L101627 · index.js
- `trackSyncOctreePendingPlacements` L102966 · index.js
- `syncOctreePendingPlacements` L102972 · index.js
- `requestOctreePlacementUpdate` L101718 · index.js
- `findGsplatWorldsForOctree` L101665 · index.js
- `hasSyncedOctreeThisFrame` L102953 · index.js
- `ensureOctreeLeafSpatialIndex` L101988 · index.js
- `getOctreeUrlToFileIndex` L102490 · index.js
- `requestOctreePlacementUpdate` L13312 · playcanvas-2.20.0.js
- `isFileBoundToOctreeInstance` L102504 · index.js
- `buildPriorityFilesIncremental` L103178 · index.js
- `octree.ensureFileResource` L102337 · index.js
- `clearSyncedOctreesThisFrame` L102928 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
