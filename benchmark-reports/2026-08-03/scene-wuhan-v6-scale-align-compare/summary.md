# Wuhan-v6 lodScaleAlign A/B（warm，排除网速）— 2026-08-03

对比项：优化前 = `lodScaleAlign:false`；优化后 = `lodScaleAlign:true`。
content = `wuhan-v6`；**warm start**：丢弃预热 after 一遍后同 Chromium context 测 after→before（HTTP 缓存热）。

## 运行条件

- coldStart: false
- chromiumHttpCache: enabled-shared-after-warmup
- warmup: {"enabled":true,"discarded":true,"caseLabel":"wuhan-v6-scale-align-after","durationMs":46079}

## 总览

| 指标 | 优化前 (off) | 优化后 (on) | Δ |
|------|--------------|-------------|---|
| firstFrameMs | 1458 | 6872 | （顺序偏置，见下） |
| fpsP50 | 35 | 54 | 54.3% |
| gsplatsAvgM | 3.29 | 2.30 | - |
| blur mean (ms) | 12701 | 8100 | -36.2% |
| blur P50 (ms) | 15401 | 11001 | -28.6% |
| blur P90 (ms) | 21201 | 11400 | -46.2% |

> **firstFrame 不可比**：跑序为 warmup(after)→measure(after)→measure(before)，before 的首帧吃到更热缓存，故 firstFrame 偏快；**blur→clear 才是本轮主指标**。before 在缓存更有利的后位仍更慢，说明 scale-align 收益偏保守估计。

## 逐关键帧 blurToClearMs

| kf | 优化前 | 优化后 | Δ% | pending@到达前 | pending@到达后 | timedOut前 | timedOut后 |
|----|--------|--------|-----|----------------|----------------|-----------|-----------|
| kf-0 | 21201 | 11400 | -46.2% | 5 | 7 |  |  |
| kf-1 | 0 | 0 | -% | 0 | 0 |  |  |
| kf-2 | 15401 | 10000 | -35.1% | 21 | 12 |  |  |
| kf-3 | 14201 | 11001 | -22.5% | 25 | 10 |  |  |

## 原始报告

- suite：`benchmark-reports/2026-08-03/scene-wuhan-v6-scale-align-warm/`
