# nanguangchang-v6-0.5 Ladder A/B

Source: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/benchmark-reports/2026-08-05/scene-nanguangchang-v6-0.5-ladder-ab/results.json`

| Strategy | blur mean | blur p50 | blur p90 | peak max | peak mean | firstFrame | fps p50 | timeouts | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ladder-1-2-3-current ✅ | 5200ms | 10400ms | 10400ms | 21 | 10.5 | 50628ms | 52.0 | 0 | 8152 |
| ladder-2-2-3-center2 | 9700ms | 19401ms | 19401ms | 26 | 13.0 | 52923ms | 57.0 | 0 | 12867 |
| ladder-2-3-target-aggressive | 10901ms | 21801ms | 21801ms | 29 | 14.5 | 50966ms | 58.0 | 0 | 14029 |
| ladder-1-3-target-edgeOnly | 14003ms | 15607ms | 15607ms | 21 | 11.5 | 54961ms | 48.0 | 0 | 17211 |

## Verdict

**Winner: `ladder-1-2-3-current`**

Winner is current baseline (1-2-3).

Scoring: `blurMean + timeouts*60s + peakMean*40 + firstFrame*0.05` (lower better).
