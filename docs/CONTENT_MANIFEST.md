# Content Manifest（Phase 3）

亿级多 piece 加载的配置约定，类型见 [`src/loaders/gsplat/lod/content-manifest.ts`](../src/loaders/gsplat/lod/content-manifest.ts)。

## 示例

```json
{
  "contentManifest": {
    "pieces": [
      { "url": "https://code.playcanvas.com/examples_data/downtown_01/ssog0/lod-meta.json", "label": "ssog0" },
      { "url": "https://code.playcanvas.com/examples_data/downtown_01/ssog1/lod-meta.json", "label": "ssog1" },
      { "url": "https://code.playcanvas.com/examples_data/downtown_01/ssog2/lod-meta.json", "label": "ssog2" },
      { "url": "https://code.playcanvas.com/examples_data/downtown_01/ssog3/lod-meta.json", "label": "ssog3" }
    ],
    "sceneRotation": [0, 0, 180]
  }
}
```

在 settings JSON 中配置 `contentManifest` 后，**无需** URL `content` 参数；各 piece 的 `lod-meta.json` 会并行下载，进度合并后由 octree bootstrap 接管 50% 之后的 streaming 进度。

## 加载与 bootstrap

| 模块 | 职责 |
|------|------|
| `loaders/gsplat/lod/gsplat-scene-load.ts` | 并行创建 piece entity，可选 `sceneRotation` / 每 piece `rotation` |
| `loaders/gsplat/lod/multi-piece-bootstrap.ts` | 每片 `bootstrapOctreeLod`，合并 progress / firstFrame / progressThresholdReached |
| `loaders/gsplat/lod/gsplat-aabb.ts` | 合并多 entity 世界 AABB → 相机边界 / reveal |

Reveal 与 NightMode 仍绑定 **首片**（`pieces[0]`）entity。

## 资产侧建议

- SSog bundled + CDN
- universe pack 与 permanent/base 文件对齐现有 [`LOD_UNIVERSE_PACK_LOADING.md`](LOD_UNIVERSE_PACK_LOADING.md)

## 本地调试

```
/index.html?settings=/assets/settings/settings-downtown-like.json&noui
```

**Billions P1（Finland 双 tile，共享 asset + Region 调度）**

```
/index.html?settings=/assets/settings/settings-finland-p0-test.json&noui
```

云端 `lod-meta`：`https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/finland/lod-meta.json`

Benchmark（profile 轴）见 [SCENE_PROFILE_BENCHMARK.md](SCENE_PROFILE_BENCHMARK.md)。
