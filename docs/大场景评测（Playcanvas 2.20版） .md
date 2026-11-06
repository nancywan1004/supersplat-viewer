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
|kf\-0 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OGVlNTRlZGMwMmE3ZDZlMmNiNjIxOWM4ODk5ZjVkMmZfOTJjNzRmYTU4NDczYTI3YWZlNmYyMDFiMzgzNjY0YTVfSUQ6NzY1NjI5OTkzMzgwMDE4ODg2OF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|\-<br>|1208|57\.0|44\.0|2\.67|413|257|
|kf\-1 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ODBiYWYzOTE5ODYwMzAyYTA5ZTcyYzYzMTNkYTM3MGFfZmMyOWI5MjM0ODkxYjk4YTc1YjE2M2JlMmUwMjE0NjBfSUQ6NzY1NjI5OTk2MzA4NDk5OTg3M18xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|12\.7|1401|54\.0|52\.0|3\.27|383|315|
|kf\-2 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=Y2ViNzY5N2E0Zjg0YmYzNDgwNTMzZmQ3NTczODRiMzlfYjg2NjQyNzlkZWQ5OWY0ZWYxMWI0MjY5YWFmMWM5MTZfSUQ6NzY1NjI5OTk5MzA4Njc0MTQ1OF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|15\.4|812|57\.0|52\.0|3\.40|470|329|
|kf\-3 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MjE4YTdmYzg2MWQ0OGU0ZTExYzU0ZjM3YzAxYTYyNjJfMmEyZGQ0ZDYxN2Y3ZmRhNjJiNzcyYmZlOTViNWY5YWZfSUQ6NzY1NjMwMDA1NTg1NDQ2ODA2M18xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|15\.8|1401|70\.0|57\.0|3\.35|484|343|
|kf\-4 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZDJkN2NiYjBhZTQ1OTA3NjM5MWE2ZDFhZmJmNDEwM2NfZTE1ZGFhNWMyZGE2YjQ5MGIzYjY3YzAzY2Y5YzI0OGJfSUQ6NzY1NjMwMDA3OTM2MzYyMzkwNV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|24\.6|1605|79\.0|62\.0|3\.23|489|386|
|kf\-5 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YTVjMjM3MDU2ZGIwYzk0Zjk0MTFmMDg1OGU3NTZmMjlfZDdjMGNjZTIwZTUwYjM0MmI0ZGM2NTY5ZWJhMjQ4N2FfSUQ6NzY1NjMwMDExNTk3Mjk4NDAwNl8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|34\.6<br>|1001|86\.0|56\.0|2\.44|568|421|
|kf\-6 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MmU3MjlkYTA4ZDNkZmY2NThkZjRmZTY3NjUyZDJhMzVfYWY0NDhkZjdlOWI3N2QyODRkYTA1ZmEyZjUxZTg2MzJfSUQ6NzY1NjMwMDI0Mjk0OTc4NjYxMV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|20\.4<br>|803|92\.0|69\.0|2\.53|546|444|
|kf\-7 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OTAyYTA0ZmIwZGMwMTY3YWFiODkzMjNkY2EyYjlmZDFfYmQzMDhhNGVjOWEzMGYzNTY4MjhlZmExYWVmNzBmMDlfSUQ6NzY1NjMwMDI2OTk2NTI0OTcyOV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|21\.6|1213|53\.0|50\.0|3\.63|657|493|

## Finland场景（5518\.3万点）

- 城镇级场景调度，覆盖约1\.3km × 1\.4km区域，共1113个sog文件、98450个叶子节点

- 初始加载：约11秒✅

- FPS较低，中位数为10，最低为6❌，初步猜测与节点过于精细和多有关

- 变清晰时间在正常网速下可控在5秒内✅

|**路径点**|段距（m）|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|
|---|---|---|---|---|---|---|---|
|kf\-0 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YjA4ZDdkZTEwOWUyYzk3MjI0NDA1YjRmYWIwODIzYTFfOWQzOThjZGEzNTZlNThmZjQxZjc2NjY5MTM5OTQ0ZmZfSUQ6NzY1NjMwNjgwOTg0NTY0ODMzNV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|\-|1097|10\.0|6\.0|1\.66|592|188|
|kf\-1 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NWM0MzYzYWIxZTNhMGJjNTYwYzQwOWM0YjcxYzllNTdfMDA4NTU0Y2JhOWNlNjQ4ZDc2YzAwYzVkYTExMWYzYWVfSUQ6NzY1NjMwNjg0MjI2MzYyMDU3MF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|346|3125|11\.0|8\.0|2\.15|795|237|
|kf\-2 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NTJiNmVlMmVlMjQwMjU2ZTdhYmJlZmNmNGU2NjAxZGZfMGNjNjA3MDg4MDE3ZDI5NjFiYzYwZjFkOTkxZDA4NDhfSUQ6NzY1NjMwNjk0MDY0OTE5Njc2NV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|172|2385|13\.0|8\.0|2\.28|867|250|
|kf\-3 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NTBkYzdjNmJmYTEwYzg5OGE3NTg0MmFiY2QzYmIwMmNfODdhNTYwMTFlZDI5NzQwM2RiMTdmZjcxNDMxZDQ4NzdfSUQ6NzY1NjMwNjk3ODE4NDA3MjM4OF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|182|1500|12\.0|8\.0|2\.42|817|256|
|kf\-4 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YTdkZTNmMTYwN2Q4ZDkwNmUwZDFjMGY4MWMzYmZkNzNfNTRlMjJmOTc3ZDI3NzAxZDcxM2RjNzg2Y2Y2YTM4OTJfSUQ6NzY1NjMwNzAxNTcyMzMzODk3Nl8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|189|1497|9\.0|7\.0|2\.18|664|263|
|kf\-5<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZjA2YTgzOTg4YzEyYTdlZjQ2YjE1Zjc3OTdjN2MyYTdfNTJkNDU2MzhhNjM3NWFjMmUwOTYyMjIzNDYyYWM4MTNfSUQ6NzY1NjMwNzA1NjQ1ODQwMzA1NF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|191|1552|10\.0|7\.0|2\.01|889|269|
|kf\-6<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YjRhODc3OTk2YjMxNTViNWViZWUxM2UyNGM0NjNjMDhfZmY1MjQwNzcwZjU3NTBkNDExMzljMTdiOTlkOTA2YTZfSUQ6NzY1NjMwNzA4NTUwMzc5NDM3NV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|189|3061|13\.0|7\.0|1\.90|919|284|
|kf\-7<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NWQ1YmZjYWIwMWQ4ZmM2YWYyZDYxOWU4NWQ0YjQ0NWRfMmU0Nzc1YzIxMjhhNjhlNTIzMWRlZGI3YWFmZmQ2YjRfSUQ6NzY1NjMwNzExODQ4MzQ5MTc5N18xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|182|2298|10\.0|7\.0|2\.08|931|308|
|kf\-8<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=Y2QwOWY3N2ZkZjljMTAzZmJiYmY3YzZkODM2NDU1MzVfZWFlODQ1YTFmMjBlMmZlNDkwZWViYzljMTg3NWJhMzBfSUQ6NzY1NjMwNzE0ODEwMzk3ODE3MF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|172|3052|15\.0|8\.0|2\.17|936|329|
|kf\-9<br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NDM0NWU5NGI0MDRjYmFlM2ZiYmE0MzY3Mjg5NjFjOWRfZDRjNTJhODBkYzU4MzE2MWQ5NzQxYzc3YTljNmI0NGNfSUQ6NzY1NjMwNzE3OTk5MzEyNDA3M18xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|159|3064|15\.0|10\.0|2\.24|1004|355|

## Poland场景亿级调度（1\.04亿点）

- 城镇级场景调度，覆盖约 4 km × 1\.8 km 区域

- 初始加载需要30秒左右

- 关于帧率和由粗变细时长：

    - 细粒度（现有分块策略）：由粗变清晰速度快（5秒左右），但节点多且密、调度频率高计算量大，内存占用大、并会导致帧率大幅下降

    - 粗粒度（官方分块策略）：由粗变清晰速度较慢，但节点粗和少，帧率能保持较高水平

### 结果对比

### 各关键帧 blur→清晰 \(ms\)

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

- Billions 官方示例用 Poland 村内低空路径 benchmark 验证：1 / 5 / 10 个 instance 时，可见 splats 约 2\.2M → 3\.2M → 3\.7M，**FPS 仍可维持 \~60**；**理论总点数已达 billions 量级，但每帧上屏点数被 LOD 曲线牢牢压住，但由粗变细时间仍受制于分块粒度（native版本采取的是粗粒度分块策略故而慢）**。

## Poland场景亿级调度（1\.04亿点）

- 分块策略采取native粗粒度分块（512k、16米）

- 由粗变精细时间较慢，在30秒左右❌

- 帧率高达60✅

|**路径点**|**变清晰时间（ms）**|**FPS （95%）**|**最低FPS**|**实际渲染高斯点（百万）**|**内存占用峰值**|**vram占用峰值**|
|---|---|---|---|---|---|---|
|kf\-0 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=OGYyOWMzMTA1ZGNkN2EzYjU0N2FiYzk2Njg4NmI2OWNfZWMwY2Y2MGU0ODU3OGQwZDUxMTczOTk3ZjFlMzJhNjBfSUQ6NzY1NjY1Nzc0MjMyMDc5ODY1MF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|26800|60|59|1\.48|201|178|
|kf\-1 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YjRkNDYwYWI2ZjcwYWM3MzdkZWVjNzU1NTk1Y2U3OTZfYTJmMTcyODdlM2JhZjQ3Y2Q1YmNmOTk1NDk1MTg5NGRfSUQ6NzY1NjY1Nzc2NjQ5Njk2MzU1Ml8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|34000|60|59|2\.33|332|281|
|kf\-2 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NWQ0Y2UxOTFkM2YxMGY4MzczYjhkMmQ5ODliNjY5MzBfYjY5ODllYTBlM2Y2ZTJmN2RiNTI0NDRmMjc3MDYxMTJfSUQ6NzY1NjY1Nzc5NTg2NTg4OTk3MF8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|16601|60|59|2\.78|371|298|
|kf\-3 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=YjgwMTBhYzVlZTlmYmMyYTc4MjA3NzE4YzJjNGQ4YzVfYjRjMTYwODM2NTM2YmY2YTlmN2I2OTcwMjEyMzFjOGFfSUQ6NzY1NjY1NzgxOTM3NzI5MDQzM18xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|11400|60|59|2\.10|367|267|
|kf\-4 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NGQ3ZDc2NTQyYTJjZmZjZGFjY2IxYWEzZjliOThiZjBfOTBhOWIwYTEzNWRjYWQyYzAyNzcxNjVkMGIzNDM0YzJfSUQ6NzY1NjY1Nzg1NTg4MTQ0ODY2Nl8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|18600|60|59|1\.72|330|278|
|kf\-5 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=NjBiMThhN2ZjNWE2MGQ3MGI4MGI0NTQwZTlkMzgxYTRfNGIzOTFiYWNhMjkwZTJlMjg4ZDYwM2Y5MWFhZjFkMDdfSUQ6NzY1NjY1Nzg5MDYzMzQwMzU5OV8xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|29200|60|59|2\.43|351|257|
|kf\-6 <br>![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZDUxMWNmYTAxMmFjZDI2ZTU3ZDc1ZGQ0MjZkN2EyY2NfZjdiNzA5OTVhOTYwNGE2YTVmMTg5OWY3ZTJjZjc5ZjJfSUQ6NzY1NjY1NzkxNzUyMTYyODEwN18xNzgyOTc5OTY1OjE3ODMwNjYzNjVfVjM)|28601|60|59|2\.26|346|289|

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



# Spark版本：

## Poland场景亿级调度（1\.04亿点）

- 初始加载速度可以保持在15秒内✅

- 由粗变细时间较快，约在5\-10秒✅

- 帧率可以保证相对平稳，在30\-40

## 小结：

1. 当前分块与视野中心refinement调度策略对于3\-4000万场景比较适用，后续会针对5000万\+至亿级场景做分块策略的进一步优化，但由粗变细速度和帧率会**存在取舍问题**。

2. 十亿级调度在现有Playcanvas的多entity共用resource的基础上基本可以做到无限scale up，帧率依旧可以相对稳定；但由粗变细时间依旧会存在瓶颈。

3. 针对于由粗变细加载慢，主要在于多个sog文件整包解析下载和调度的延迟，故而后续也会考虑引入Spark中的单容器 \+ header 索引 \+ 64K 分块 \+ HTTP Range，把 splat\-transform 产出的成百上千个小文件收成「一个 RAD 式容器」，Viewer侧做相应适配，理论上帧率上和调度时间上会平衡较多。

4. 更多管线介绍可以参考：[大场景 LOD 现有管线分析](https://gcnsyy5mri7p.feishu.cn/docx/RMkedtTF6oBhq6x38ZfcO5ZRnxb?from=from_copylink)

