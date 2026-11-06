# 3DGS 点彩 NPR 渲染内核方案

## 双路径（互不干扰）

| 区域 | 路径 |
|------|------|
| **高斯/content** | modify + gsplatPS（3D 点涂）；post **原样透传** |
| **天空（depth=far）** | post `skyboxPointillism` 修拉式 2D 椭圆笔触 |

## 天空 2D 点涂（修拉式）

- 3×3 邻格重叠椭圆笔触，中心微扰，**整屏可见独立色点**
- 每点：天空盒原色 + 暖/冷/对比色并置（光学混色，非 blur）
- 缝隙：邻点色平均略暗；`paperStrength` 仅微调缝隙（不做大半径 blur）
- **仅** `backdropDepthMask` 判定天空，不混到高斯轮廓

## `paperStrength`

- **0**：天空 post 关闭
- **>0**：天空修拉式点涂开启
