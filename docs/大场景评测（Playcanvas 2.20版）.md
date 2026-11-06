# 大场景评测（Playcanvas 2\.20版）

基于Playcanvas 2\.20更新后，体感视野内LOD调度更明显、更流畅。主要跟以下改动有关：

1. Streaming 与渲染解耦（\#8919）

    1. LOD 评估、文件下载在 `framerender` 独立跑，不绑定这一帧有没有 draw。

    2. 影响：解决了后台加载完毕但是画面迟迟不更新的问题；refine 可连续推进。

2. `GSplatWorld` \+ LOD 补跑（ \#8916）

    1. 高斯排序背压导致 LOD 周期被跳过时，下一帧补算。

    2. 影响：同样解决了“拉近后很久才突然变一次”的问题 —— 直接决定 LOD 调度是否跟得上相机。

# 当前管线（视野中心refinement优化版）：

## 南广场（4089\.2万点，benchmark✅）

- 街区级场景调度，共630个sog文件、11612个叶子节点

- 初始加载：5\-15秒✅

- FPS较高，中位数69，最低44✅

- 变清晰时间在正常网速下可控在**3秒内✅**

|**路径点**|段距（m）|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|
|---|---|---|---|---|---|---|---|
|kf\-0 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=Y2EwNzE0NGJhZGYxYzc1NGJmMzEzMzlkNjM2MDE5ZDNfMzZmY2Q4NTIwM2FmMzc5ODgzMmU0YjRkY2RhZjgzZTlfSUQ6NzY1NjI5OTkzMzgwMDE4ODg2OF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|\-<br>|1208|57\.0|44\.0|2\.67|413|257|
|kf\-1 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=M2Q2MDE5ODJmMjM1ODYwZTRjZWM4NGI3ODQ2NzI4OTFfMjgzOWMwZDJmZDQzNDAzZjA4M2E3MDEzYmVjNjdmZDVfSUQ6NzY1NjI5OTk2MzA4NDk5OTg3M18xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|12\.7|1401|54\.0|52\.0|3\.27|383|315|
|kf\-2 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZGJjN2U2OTNjOTA4YzRhMTkyYzVjZTFhN2E3MjdkYzJfYmM0ZjgzOWFhMDY0Zjk5NWZkZDhhZGE1MzQ2MDgzM2JfSUQ6NzY1NjI5OTk5MzA4Njc0MTQ1OF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|15\.4|812|57\.0|52\.0|3\.40|470|329|
|kf\-3 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZGJmNTI4NWNkZDU1NTI0ZTE5MTU3NjAxNDQ0N2QyZjZfOWUzZTRmNTFjNzMyMGQzYWIxMDU1NWE0YWViMGQ5NGJfSUQ6NzY1NjMwMDA1NTg1NDQ2ODA2M18xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|15\.8|1401|70\.0|57\.0|3\.35|484|343|
|kf\-4 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MzYyN2ZhZDdjMDg0ZTgwNDI0NjczMjA0ZjFmOWM4YTJfNjA4YmViZTIzMTIyZmZmNTNlMDA1OGNhOGI0Mjc0MDdfSUQ6NzY1NjMwMDA3OTM2MzYyMzkwNV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|24\.6|1605|79\.0|62\.0|3\.23|489|386|
|kf\-5 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YjBjMGJmNjkwNzkyMDMxMjIyOGVjYmUyODg0YzkyMzBfNDBmNzU4Zjk3ZTNmMjUyMGEyZGEzM2EyYTUyMTdhNTVfSUQ6NzY1NjMwMDExNTk3Mjk4NDAwNl8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|34\.6<br>|1001|86\.0|56\.0|2\.44|568|421|
|kf\-6 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NGJmMzZlMzFlMGYwOWYyNjdhZDQ0N2NjN2RlZWQ0OTZfYTc4NzM0NTAyMjg4NDVkMGIyNTFjZDM4N2U2ZTBjYzZfSUQ6NzY1NjMwMDI0Mjk0OTc4NjYxMV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|20\.4<br>|803|92\.0|69\.0|2\.53|546|444|
|kf\-7 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NjBjNDRiY2M5NzVlNzUzYTcxMWYzODc4MGNlNDc1ZjhfMDZhZmFiNDEzNmE1MWUzMzA3Y2YyMGE2MDY2YWRmOGNfSUQ6NzY1NjMwMDI2OTk2NTI0OTcyOV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|21\.6|1213|53\.0|50\.0|3\.63|657|493|

## Finland场景（5518\.3万点）

- 城镇级场景调度，覆盖约1\.3km × 1\.4km区域，共1113个sog文件、98450个叶子节点

- 初始加载：约11秒✅

- FPS较低，中位数为10，最低为6❌，初步猜测与节点过于精细和多有关

- 变清晰时间在正常网速下可控在5秒内✅

|**路径点**|段距（m）|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|
|---|---|---|---|---|---|---|---|
|kf\-0 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MGZiNjU0ZGVmYmNlMWVkOTcwNmZiMTYyN2I0ZjljYjFfNjhkNmJiZGQ5MmMxNDE1YWEzODBlNzBiNDcwYjViMjNfSUQ6NzY1NjMwNjgwOTg0NTY0ODMzNV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|\-|1097|10\.0|6\.0|1\.66|592|188|
|kf\-1 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZWNhOTI2OGVkNTAwMGIyNTA2ODVmNTMzMmRiYzgyYTVfMjdmMzRiNDRlZGJmYTc2YmNmY2I4NjM4OTg4M2U0YzlfSUQ6NzY1NjMwNjg0MjI2MzYyMDU3MF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|346|3125|11\.0|8\.0|2\.15|795|237|
|kf\-2 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZjVhNzI1YzViNzBlZDhjMzc0NDllZTFhNTJmODJkODVfMGY0MGJjYjgxYzFiZGM3MDA1NjNjMGM5NGYxMWUzZGJfSUQ6NzY1NjMwNjk0MDY0OTE5Njc2NV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|172|2385|13\.0|8\.0|2\.28|867|250|
|kf\-3 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=M2RiZDU1MjQyMjZmMTgwOGUxZDJhZjQ4NzM0ZGM2NjdfMGQyZDJjMGM2YjM0ZmY1YTQ1ZjIyNWI5ZmU4YmVhNmVfSUQ6NzY1NjMwNjk3ODE4NDA3MjM4OF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|182|1500|12\.0|8\.0|2\.42|817|256|
|kf\-4 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NDQ4NjY4NGZlZTRhNDRjNmRlYTg5NWY0ODU2MTQ0NWVfOTA3MmQ0NWE3MTY4MGFkOTFlOTRhZjMyY2U4ODZmYWJfSUQ6NzY1NjMwNzAxNTcyMzMzODk3Nl8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|189|1497|9\.0|7\.0|2\.18|664|263|
|kf\-5<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OTNmN2EwNmY3MDg4MGFlZjhhOWYxNjAyNzZlNjk5ZmNfY2MzYmFhY2Y4NWUxZDA4ZTY0ZjE4NmNhZThhMWJiMjBfSUQ6NzY1NjMwNzA1NjQ1ODQwMzA1NF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|191|1552|10\.0|7\.0|2\.01|889|269|
|kf\-6<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NzUzODEyOGY4ZWUzZDJjNGNjODRkNzc0MGMzYjAwNjdfZWNkOTUxMThmYzcwZGJjMmQxZmVjZTg2YWEyODlmNjVfSUQ6NzY1NjMwNzA4NTUwMzc5NDM3NV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|189|3061|13\.0|7\.0|1\.90|919|284|
|kf\-7<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZGI4ZTRmN2RkMTM1OWExNWE4YjFlN2RlMzgzZDJlYWRfMDI4NTU4YjRmYTYyMDE2YTM5YWMyM2EzNDg1MGZiMTdfSUQ6NzY1NjMwNzExODQ4MzQ5MTc5N18xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|182|2298|10\.0|7\.0|2\.08|931|308|
|kf\-8<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MWM1ODkzNmI3YTcxZWI0NDAzNDNhNzk1NGVjYTJlYzFfM2YzOWEzM2I3MGI1ZGRiNGU4MzJlNDRkYTI5MDYzZDVfSUQ6NzY1NjMwNzE0ODEwMzk3ODE3MF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|172|3052|15\.0|8\.0|2\.17|936|329|
|kf\-9<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OGUyMjM5OWNiZmY2NTI1MjIxZWQzZjc3NzEzYjY2ZTdfNzc0MDU4N2U3M2E4MTU4ODRhMTlmMTMwYmIxMzc3ZjJfSUQ6NzY1NjMwNzE3OTk5MzEyNDA3M18xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|159|3064|15\.0|10\.0|2\.24|1004|355|

## Poland场景亿级调度（1\.04亿点）

- 城镇级场景调度，覆盖约 4 km × 1\.8 km 区域

- 初始加载需要30秒左右

- 关于帧率和由粗变细时长：

    - 细粒度（现有分块策略）：由粗变清晰速度快（5秒左右），但节点多且密、调度频率高计算量大，内存占用大、并会导致帧率大幅下降

    - 粗粒度（官方分块策略）：由粗变清晰速度较慢，但节点粗和少，帧率能保持较高水平

### 结果对比

### 各关键帧 blur→清晰 \(ms\)

## **小结**：当前分块与视野中心refinement调度策略对于3\-4000万场景比较使用，后续会针对5000万\+至亿级场景做分块策略的进一步优化。

# Playcanvas native版本：

- 针对十亿级场景，Playcanvas 2\.20中采取了多entity共享同一asset的机制。证明了引擎层的 instance 级调度 \+ resource 级共享所带来的性能不受scale量级影响。

    - 共享的部分（十亿级理论总点数可以很大，但下载与驻留不会按 instance 数线性膨胀）：

        - 网络请求与 octree meta 解析

        - 物理 LOD 文件缓存与 Resource 驻留

        - work buffer 中与 file 相关的底层数据

    - 不共享的部分（因此性能仍与「当前视野里有多少 instance、各自离相机多远」相关）：

        - 世界 Transform 与 per\-instance 视锥关系

        - 每个 instance 独立的 `updateLod(camera)` 结果

        - 2\.20 起 per\-component 的 `lodRangeMin / lodRangeMax`

    - 每帧引擎在 `GSplatWorld.updateStreaming()` 中，对每个 GSplat Entity 独立执行：

        - 将该 instance 的 local octree 变换到世界空间，结合相机计算视锥与距离；

        - 对每个 octree 节点求 optimal LOD（距离曲线 \+ FOV \+ 屏幕占比）；

        - 受 `lodRangeMin/Max` 约束，超出范围的档不下载、不参与上屏；

        - 近处 instance 可停留在细档，远处快速落到粗档 → active splats 随 instance 数次线性增长。

- Billions 官方示例用 Poland 村内低空路径 benchmark 验证：1 / 5 / 10 个 instance 时，可见 splats 约 2\.2M → 3\.2M → 3\.7M，**FPS 仍可维持 \~120**；**理论总点数已达 billions 量级，但每帧上屏点数被 LOD 曲线牢牢压住**。

## Poland场景亿级调度（1\.04亿点）

- 分块策略采取native粗粒度分块（512k、16米）

- 由粗变精细时间较慢，在30秒左右❌

- 帧率高达60✅

|**路径点**|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|
|---|---|---|---|---|---|---|
|kf\-0 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YjhlNDc5ODM5Yjg2MjI0MWNlYmZjOTkwOGE4YWYzYWZfZDZlOGJjMWJiNDI2NDhiZjY2ZjdjMTU4MzAyOWQ3NWZfSUQ6NzY1NjY1Nzc0MjMyMDc5ODY1MF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|26800|60|59|1\.48|201|178|
|kf\-1 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NzczNWNkMmU2ZjNlODdlYjg2YmE4MjJhOWNjNjAyZjhfNGIyN2VhYTg4ODk5ZWE2NzVmMTk4MzRmZTg1NGY2YjNfSUQ6NzY1NjY1Nzc2NjQ5Njk2MzU1Ml8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|34000|60|59|2\.33|332|281|
|kf\-2 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OGJmYTQzYzQ1ZWI3ZjQxNDI3ZmI2OTEyMDdmYmRmYWRfY2M1MWRkYjc1MjFkYTc4YWE4NjEzOGFmMTU2NmMxNDlfSUQ6NzY1NjY1Nzc5NTg2NTg4OTk3MF8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|16601|60|59|2\.78|371|298|
|kf\-3 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MWUyMWM5NWNlOWRkNmExNjk0YzVmODZkMDliNTU1MGZfYWJlZTJmOTkxZjU2YjZmMzMwMjZhYWJhNjhiNjYzMDNfSUQ6NzY1NjY1NzgxOTM3NzI5MDQzM18xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|11400|60|59|2\.10|367|267|
|kf\-4 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MDZkMDVmZjUxYmFkZWIzZGI0YjdmNmY4YmM5MjQ1MWFfNDdkNGRiMTFhOGVhOTdmOTcyOTQ3OTkxMjk2MGI2MGVfSUQ6NzY1NjY1Nzg1NTg4MTQ0ODY2Nl8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|18600|60|59|1\.72|330|278|
|kf\-5 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZTZkOWE2NWQzOGMzMTgyODQ5Y2E3ZjllODFiMzdiZDBfOWVjM2EyNzJlZTExNWU4MWY0ZWYzOGIzMmM5NjFiNDVfSUQ6NzY1NjY1Nzg5MDYzMzQwMzU5OV8xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|29200|60|59|2\.43|351|257|
|kf\-6 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OGZjNTY5ZjA1Yjc0NWQwOGE2NDQ4ODAxOGEwOWVkZGVfZGMyNDJkZDYyYTY2Yzk4OWY4ZTVkMGM4ZTY2NWJhNWJfSUQ6NzY1NjY1NzkxNzUyMTYyODEwN18xNzgyNzI5MzA4OjE3ODI4MTU3MDhfVjM)|28601|60|59|2\.26|346|289|

## Poland场景亿级调度（1\.04亿点 x 5）

|**路径点**|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|vram@clear|jsHeapPeak|vramPeak|timeout|
|---|---|---|---|---|---|---|---|---|---|---|
|kf\-0|27201|60\.0|60\.0|59\.0|2\.48|207|202|215|202|N|
|kf\-1|4201|60\.0|60\.0|60\.0|2\.29|231|223|249|223|N|
|kf\-2|3801|60\.0|60\.0|59\.0|2\.30|248|244|274|244|N|
|kf\-3|4601|59\.0|60\.0|59\.0|2\.45|235|239|296|239|N|
|kf\-4|2601|60\.0|60\.0|60\.0|1\.93|208|208|264|208|N|
|kf\-5|5400|60\.0|60\.0|59\.0|2\.10|257|241|287|250|N|
|kf\-6|10200|60\.0|60\.0|59\.0|2\.32|247|240|271|240|N|

## Poland场景亿级调度（1\.04亿点 x 10）

|**路径点**|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|vram@clear|jsHeapPeak|vramPeak|timeout|
|---|---|---|---|---|---|---|---|---|---|---|
|kf\-0|27200|60\.0|59\.0|208|215||||||
|kf\-1|8401|60\.0|59\.0|281|257||||||
|kf\-2|2601|60\.0|59\.0|284|235||||||
|kf\-3|17801|60\.0|59\.0|330|293||||||
|kf\-4|35800|60\.0|59\.0|357|335||||||
|kf\-5|31601|60\.0|59\.0|376|330||||||
|kf\-6|33001|60\.0|59\.0|381|298||||||

## 小结：十亿级调度在现有Playcanvas的多entity共用resource的基础上基本可以做到无限scale up，帧率依旧可以相对稳定；后续会持续完成多个不同region调度的适配，而不是同一场景进行无限复制。

