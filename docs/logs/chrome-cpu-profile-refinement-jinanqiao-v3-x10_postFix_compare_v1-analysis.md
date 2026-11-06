# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-jinanqiao-v3-x10_postFix_compare_v1.json

- 采样帧：116296；累计采样时间 ~29900 ms
- GC 占比：0.5%（~162 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 16625.9 | 64126 |
| viewer-bundle | 5071.9 | 19853 |
| playcanvas | 4842.6 | 19195 |
| octree-lod | 2979.7 | 11659 |
| gsplat-engine | 197.8 | 784 |
| gc | 161.5 | 597 |
| refinement-controller | 21.0 | 82 |

## refinement / octree 符号

- `isOctreeBootstrapPlaceableNode` L101603 · index.js
- `findAllOctreeInstances` L101627 · index.js
- `getOctreeBootstrapLod` L101599 · index.js
- `syncStreamingOctreePlacements` L103395 · index.js
- `syncOctreePendingPlacements` L102972 · index.js
- `requestOctreePlacementUpdate` L101718 · index.js
- `findGsplatWorldsForOctree` L101665 · index.js
- `worldOwnsOctree` L101614 · index.js
- `hasSyncedOctreeThisFrame` L102953 · index.js
- `runPriorityPrefetch` L103866 · index.js
- `buildPriorityFiles` L103401 · index.js
- `trackSyncOctreePendingPlacements` L102966 · index.js
- `ensureOctreeLeafSpatialIndex` L101988 · index.js
- `getOctreeUrlToFileIndex` L102490 · index.js
- `buildPriorityFilesIncremental` L103178 · index.js
- `isFileBoundToOctreeInstance` L102504 · index.js
- `octree.ensureFileResource` L102337 · index.js
- `clearSyncedOctreesThisFrame` L102928 · index.js

## 结论

- 主线程采样以 **gsplat 引擎**（buffer copy / inst.update）为主，refinement tick 本身占比小。
