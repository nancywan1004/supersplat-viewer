# Chrome CPU/Performance 分析 — chrome-cpu-profile-refinement-wuhan.json

- 采样帧：114176；累计采样时间 ~29495 ms
- GC 占比：0.4%（~117 ms）

## 按模块（采样时间占比）

| 模块 | 采样 ms | hits |
|---|---:|---:|
| other | 27460.1 | 106228 |
| playcanvas | 1063.3 | 4192 |
| viewer-bundle | 783.1 | 3080 |
| gc | 116.7 | 391 |
| gsplat-engine | 30.1 | 121 |
| octree-lod | 24.8 | 97 |
| refinement-controller | 17.0 | 67 |

## refinement / octree 符号

- `findAllOctreeInstances` L101676 · index.js
- `isOctreeBootstrapPlaceableNode` L101652 · index.js
- `syncStreamingOctreePlacements` L103468 · index.js
- `syncOctreePendingPlacements` L103045 · index.js
- `markSyncedOctreeThisFrame` L103030 · index.js
- `requestOctreePlacementUpdate` L101767 · index.js
- `findGsplatWorldsForOctree` L101714 · index.js
- `hasSyncedOctreeThisFrame` L103026 · index.js
- `runPriorityPrefetch` L103939 · index.js
- `buildPriorityFiles` L103474 · index.js
- `trackSyncOctreePendingPlacements` L103039 · index.js
- `buildPriorityFilesIncremental` L103251 · index.js
- `isFileBoundToOctreeInstance` L102577 · index.js
- `worldOwnsOctree` L101663 · index.js
- `octree.ensureFileResource` L102410 · index.js
- `clearSyncedOctreesThisFrame` L103001 · index.js

## 结论

- **refinement-controller** 在 CPU profile 中可见，需结合 sync 触发统计优化。
