# SaaS第三期 编辑模式交互职责划分

# UI层交互职责：

## 顶部菜单

*   进入编辑模式：发送 `EDIT_MODE_SET { value: true }`
    
*   退出编辑模式：父级点击「退出」时先发送 `EDIT_MODE_EXIT_REQUEST`；Viewer 回传 `EDIT_EXIT_NEEDS_SAVE { needsSave }`。若 needsSave 为 true，父级弹出确认弹窗（退出并保存 / 退出不保存 / 取消），选「退出并保存」则先 `SETTINGS_SAVE`（SaaS 缺省 `destination: 'universe'`）收到 `SETTINGS_UPDATED` 后再 `EDIT_MODE_SET { value: false }`，选「退出不保存」则 `EDIT_MODE_EXIT_DISCARD`；若 needsSave 为 false，父级直接发送 `EDIT_MODE_SET { value: false }`
    
*   撤销/重做：发送 `EDIT_UNDO` / `EDIT_REDO`；撤销/重做按钮的可用状态由 Viewer 回传的 `EDIT_HISTORY_STATE { canUndo, canRedo }` 更新
    
*   保存：发送 `SETTINGS_SAVE { destination?: 'host' | 'universe', requestId?: string }`，缺省 `universe`。postMessage 本地保存用 `host`：不上传、不触发下载，经 `SETTINGS_SAVE_RESULT` 把 settings 与资源 File 交回父级（父级自行打包下载或交给客户上传）。`universe` 仍由 Viewer 上传 OSS，成功 `SETTINGS_UPDATED`，失败 `SETTINGS_SAVE_FAILED`。
    

## 资产相关（Asset）

*   资产库管理：类型筛选、缩略图展示
    
*   资产放置触发：点击资产列表中的资产 → 发送 `ASSET_PLACE`（不再拖拽）。`value.src` 可为 http(s) 字符串或浏览器 File，不必先上 CDN；仅 http(s) 字符串不改写。跨域 iframe 不要只传父页 `blob:` 字符串。
    
*   底部栏（资产模块）：父级负责「移动」「旋转」「缩放」「复制」「删除」；变换模式→`ASSET_TRANSFORM_MODE`，复制→`ASSET_COPY`，删除→`ASSET_DELETE`
    
*   场景资产列表：展示已放置资产，支持选中
    

## 标注相关（Annotation）

*   新建标注：点击「新建」→ 发送 `ANNOTATION_PLACEMENT_START`，等待 Viewer 完成场景点击后接收 `ANNOTATION_PLACEMENT_UPDATE`
    
*   调整位置：确认放置前，用户可在场景中再次点击以改变占位标注位置；Viewer 派发 `ANNOTATION_PLACEMENT_UPDATE`（与首次创建共用同一事件，payload 含最新完整标注数据）
    
*   确认放置：收到 `ANNOTATION_PLACEMENT_UPDATE` 后，父级展示表单（标题、正文等）及「确认放置」「取消」按钮；用户填写后点击「确认放置」→ 发送 `ANNOTATION_CONFIRM { id, data }`；点击「取消」→ 发送 `ANNOTATION_PLACEMENT_CANCEL`
    
*   底部栏（标注模块）：父级负责「移动」「编辑」「删除」；移动→`ANNOTATION_SELECT` 显示 Gizmo，编辑→展示表单+`ANNOTATION_UPDATE`，删除→`ANNOTATION_DELETE`
    
*   标注列表：展示所有标注，支持选中、编辑、删除
    
*   编辑表单：标题、正文、图片/视频（`image` / `video` 为 `string | File`）、收起时显示标题等（一次性提交）。本地 File 与天空盒相同：跨域 iframe 传 File，不要只传父页 `blob:`。
    
*   移动端 2D 展示：根据 Viewer 推送的标注数据，在屏幕空间渲染 2D UI（列表/卡片），不依赖 3D 热点
    

## 环境设置

*   光照
    
    *   全局光照slider
        
    *   光照列表：选中光源，调节光照强度、光照颜色调节、是否为360度光源、Inner/Outer角度、Range
        
*   后处理
    
    *   阴影开启/关闭、阴影深度slider调节
        
    *   辉光开启/关闭、辉光强度slider、辉光阈值slider（超过阈值才进行辉光）
        
    
    ## 特效
    
*   特效
    
    *   不同特效切换菜单
        
    *   重新播放
        
*   视频导出
    
    *   是否包含特效
        

# Viewer层交互职责：

## 资产相关

*   场景内选中
    
*   Gizmo变换
    

## 标注相关

*   PC端：3D 空间标注，Picker 拾取点击位置，创建占位标注，Gizmo 移动，热点 + tooltip 展示
    
*   调整位置：确认放置前，场景点击持续监听；若已有占位标注，则更新其位置
    
*   移动端：不渲染 3D 热点，仅将标注数据推送给父级，由父级以 2D UI 展示
    

## 环境设置相关

*   光照：更新光照位置、旋转，根据UI层提供的参数可视化光照
    

# UI与Viewer层通讯

## 父级->Viewer (postMessage下发)

### 顶部菜单

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 进入编辑模式 | EDIT\_MODE\_SET | {value: true} |  |
| 请求退出编辑模式 | EDIT\_MODE\_EXIT\_REQUEST |  | 父级在用户点击「退出」时发送；Viewer 回传 `EDIT_EXIT_NEEDS_SAVE`，父级根据 `needsSave` 决定是否弹窗及后续发送 `EDIT_MODE_SET` 或 `EDIT_MODE_EXIT_DISCARD` |
| 退出编辑模式无改动 | EDIT\_MODE\_SET | {value: false} | 当 Viewer 回传 `needsSave` 为 false 时父级直接发送；或用户选「退出并保存」完成保存流程后发送 |
| 退出编辑模式并保存改动 | EDIT\_MODE\_SET | {value: false} | 先发送 `SETTINGS_SAVE`（上传用缺省 `universe`，本地保存发 `destination: 'host'`）。`universe` 等 `SETTINGS_UPDATED`；`host` 等 `SETTINGS_SAVE_RESULT` 后再 `EDIT_MODE_SET { value: false }` |
| 退出编辑模式不保存改动 | EDIT\_MODE\_EXIT\_DISCARD | / | 用户选「退出不保存」时发送；Viewer 回滚到上次保存快照并退出 |
| 撤销 | EDIT\_UNDO | / |  |
| 重做 | EDIT\_REDO | / |  |
| 保存 | SETTINGS\_SAVE | { destination?: 'host' \| 'universe', requestId?: string } | 缺省 `universe`。postMessage 本地保存发 `host`：不上传不下载，回 `SETTINGS_SAVE_RESULT`。`universe` 上传 OSS，成功 `SETTINGS_UPDATED`，失败 `SETTINGS_SAVE_FAILED { message, requestId? }` |
| 预览 - 编辑模式下显隐调试组件（操作轴、线框） | PREVIEW\_MODE\_SET | {value: boolean} | true为隐藏这些组件，false为显示这些组件 |

#### Viewer模式

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 显示/隐藏已放置资产 | ASSETS\_SHOW\_HIDE\_SET | {value: boolean} |  |
| 所有光照开关 | LIGHT\_TOGGLE\_ALL | {value: boolean} |  |
| 单个光照开关 | LIGHT\_TOGGLE | { id: string, value: boolean } | 编辑模式下同样可采取此方式显隐光源 |
| 相机移动步长系数 | CAMERA\_MOVE\_SPEED\_SCALE\_SET | { value: number } | 乘在场景尺寸自适应速度（`max(1, sceneSize×0.05)`）之上；缺省 **1**；范围 **(0, 10]**（运行时夹到 \[0.001, 10\]）；大场景小步可取 **0.1～0.5**。写入 **`settings.cameras[0].moveSpeedScale`**，随 **`SETTINGS_SAVE`** 持久化。非法值 `console.warn` 后忽略。本地编辑 UI：右侧「相机设置 → 移动步长」滑条（0.05～2） |

### 左侧工具栏

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 切换左侧工具栏模块 | EDIT\_MODULE\_SET | { value: 'gs' \| asset' \| 'annotation' \| 'environment' \| 'camera' \| 'effects' \| null } |  |

### 资产相关

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 开始放置资产 | ASSET\_PLACE | { value: AssetLibraryItem } | `value.src` 为 `string \| File`（与天空盒 `value`、标注 `image`/`video` 相同）。File 写入会话表并改成 `assets/<basename>`（重名加 assetId 前缀），会话保留原始字节。仅 http(s) 字符串不改写（绝对 URL、不打包）。不要只传父页 `blob:` 字符串（跨域 iframe 无法 fetch）；可选兜底：同源 blob: 能 fetch 则转成 File。内置面板粘贴仍拒绝 blob:。`blob:` 不写入 settings。不认独立 `url`/`file` 字段。<br>type AssetLibraryType = 'image' \| 'mesh' \| 'gaussian' \| 'video' \| 'audio';<br>interface AssetLibraryItem {<br>id: string;<br>type: AssetLibraryType;<br>name: string;<br>filename?: string;<br>src?: string \| File;<br>asset?: Asset;<br>thumbnailUrl?: string;<br>} |
| 音视频热区全局参数（`settings.sceneMediaHotspot`） | MEDIA\_HOTSPOT\_SET | `{ value: { video?: { hotspotAutoplayEnabled?, coneHalfDeg? }, audio?: { hotspotAutoplayEnabled?, showCalloutInViewer? } } }` | **嵌套 patch**：`video.hotspotAutoplayEnabled` 视频热区自动播（缺省 true）、`video.coneHalfDeg` 视频视锥半角；`audio.hotspotAutoplayEnabled` 音频热区自动播（缺省 true，音频无视锥）；`audio.showCalloutInViewer` 浏览（Viewer / 编辑预览）模式下是否显示音频 callout 与手动播放按钮（缺省 true，显式 false 入库）；冷却等为 Viewer 内部常量，不入库 |
| 单条 video/audio 触发距离 | ASSET\_MEDIA\_HOTSPOT\_RANGE\_SET | `{ id: string, value: number }` | **`id`** = 场景已放置 video/audio 实例 id；写入 **`settings.sceneAssets[id].triggerDistanceM`**（米）；**不回传** |
| 从当前视角设该资产热区基准距离 | ASSET\_MEDIA\_HOTSPOT\_SET\_BASELINE | `{ id: string }` | **`id`** = 场景已放置 **video 或 audio** 实例 id（与 **`ASSET_SELECT`** 一致）；Viewer 按资产 **type** 计算距离（video=视轴深度，audio=欧氏）并写入该条 **`triggerDistanceM`**；成功后出站 **`SCENE_ASSET_MEDIA_TRIGGER_DISTANCE_CHANGED`** |
| 指定选中资产（可选，用于列表点击选中 | ASSET\_SELECT | { id: string \| null } |  |
| 复制选中资产 | ASSET\_COPY | { id: string, copyId: string } | 副本复用源实例的 `file` 引用（同一用户文件） |
| 删除选中资产 | ASSET\_DELETE | { id: string } |  |
| 切换Gizmo模式 | ASSET\_TRANSFORM\_MODE | { value: 'move' \| 'rotate' \| 'scale' \| null } |  |
| 单个资产显示/隐藏 | ASSET\_SHOW\_HIDE\_SET | { id: string, value: boolean } |  |

### 标注相关

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 进入标注放置模式 | ANNOTATION\_PLACEMENT\_START | { id: string } | id由父页面创建 |
| 取消放置 | ANNOTATION\_PLACEMENT\_CANCEL | / |  |
| 提交标注数据。Viewer 根据 id：占位标注→固化并退出放置；已有标注→更新内容。 | ANNOTATION\_CONFIRM | { id: string, value: Partial<AnnotationData> } | `value.image` / `value.video` 为 `string \| File`（与天空盒 `value` 相同）。File 写入会话表并改成 `assets/<basename>`。仅 http(s) 字符串不改写。image 与 video 互斥，同时存在时以视频为准。不要只传父页 `blob:`。<br>interface AnnotationData {<br>id: string;<br>title: string;<br>text: string;<br>image?: string \| File;<br>video?: string \| File;<br>showTitleWhenCollapsed: boolean;<br>} |
| 实时编辑更新场景标注内容 | ANNOTATION\_UPDATE | { id: string, value: Partial<AnnotationData> } | 与 CONFIRM 相同，`image` / `video` 可为 File |
| 编辑标注 | ANNOTATION\_EDIT | { id: string } |  |
| 删除标注 | ANNOTATION\_DELETE | { id: string } |  |
| 切换Gizmo模式 | ANNOTATION\_TRANSFORM\_MODE | { value: 'move' \| null } |  |

### 环境设置相关

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 设置当前天空盒 | SKYBOX\_SET | { value?: string \| File } | `value` 为 File 时写入 `assets/<basename>` 并设为 currentUrl（同时记入 uploadUrls）。为 http(s) 字符串则不改写。空串清除当前天空盒。不要只传父页 `blob:`。 |
| 添加并应用天空盒 | SKYBOX\_ADD | { value?: string \| File } | 与 SET 相同，追加到 `uploadUrls` 并立即应用。 |
| 全局光照 | LIGHT\_GLOBAL\_SET | { value: number } | <0为夜间、>0为日间模式；**范围\[-1,1\]** |
| 新增光源 | LIGHT\_ADD | { id: string, isThreeSixty: boolean, name: string } | id由父页面创建，isThreeSixty为true的时候是点光源，false的时候为聚光灯 |
| 复制光源 | LIGHT\_COPY | { id: string, copyId: string, copyName: string } |  |
| 更新光源信息 | LIGHT\_UPDATE | { id: string, value: Partial<PointLightConfig \| SpotLightConfig>} | 现在使用此接口主要用于更新光源名称，直接传**{ id: string, value: { name: string }}**即可 |
| 删除光源 | LIGHT\_DELETE | { id: string } |  |
| 选中光源 | LIGHT\_SELECT | { id: string \| null } |  |
| 切换Gizmo模式 | LIGHT\_TRANSFORM\_MODE | 点光源：{ value: 'move' \| null }<br>聚光灯：{ value: 'move' \| 'rotate' \| null } |  |
| 更新光强 | LIGHT\_INTENSITY\_UPDATE | { id: string, value: number } | 默认1，范围\[0,10\] |
| 更新光颜色 | LIGHT\_COLOR\_UPDATE | { id: string, value: number\[\] } |  |
| 更新Inner角 | LIGHT\_INNER\_ANGLE\_SET | { id: string, value: number } | 范围\[0, 180\], 只适用于非360度光源 |
| 更新Outer角 | LIGHT\_OUTER\_ANGLE\_SET | { id: string, value: number } | 范围\[0, 180\]，只适用于非360度聚光灯光源 |
| 更新Range | LIGHT\_RANGE\_SET | { id: string, value: number } | 范围\[0, 20\]，只适用于非360度聚光灯光源 |
| 开始绘制亮灯区域 | LIGHT\_BRUSH\_START |  |  |
| 开始擦除绘制区域 | LIGHT\_ERASER\_START |  |  |
| 清除当前绘制区域 | LIGHT\_BRUSH\_CLEAR |  |  |
| 更新亮灯区域颜色 | LIGHT\_BRUSH\_COLOR\_UPDATE | {id: string, value: { tintColor: number\[\], tintBlend: number} } | tintColor 为 sRGB:\[0,1\]；tintBlend 范围:\[0,1\] |
| 更新亮灯区域光照强度 | LIGHT\_BRUSH\_INTENSITY\_UPDATE | { id: string, value: number } | **默认1**，范围\[0,10\] |
| 更新亮灯区域Inner角 | LIGHT\_BRUSH\_INNER\_ANGLE\_SET | { id: string, value: number } | 范围\[0, 180\], 只适用于非360度聚光灯光源 |
| 更新亮灯区域Outer角 | LIGHT\_BRUSH\_OUTER\_ANGLE\_SET | { id: string, value: number } | 范围\[0, 180\], 只适用于非360度聚光灯光源 |
| 更新亮灯区域纵向范围 | LIGHT\_BRUSH\_RANGE\_SET | { id: string, value: number } | 范围\[0, 20\]，只适用于非360度聚光灯光源 |
| 结束绘制亮灯区域 | LIGHT\_BRUSH\_FINISH | { id: string } |  |
| 删除已有亮灯区域 | LIGHT\_BRUSH\_DELETE | { id: string } |  |
| 更新亮灯区域信息 | LIGHT\_REGION\_UPDATE | { id: string, value: Partial<LocalLightRegion> } | 现在主要用于更新亮灯区域名称，直接传**{ id: string, value: { name: string }}**即可 |
| 更新辉光强度 | ~~BLOOM\_BLUR\_SET~~ BLOOM\_INTENSITY\_UPDATE | { value: number } | **默认0**，范围\[0,0.3\],步长0.01 |
| 更新辉光阈值 | BLOOM\_THRESHOLD\_UPDATE | { value: number } | 范围\[0,5\] |
| 辉光仅作用局部亮灯区域 | BLOOM\_IS\_LOCAL\_SET | { value: boolean } |  |
| 开启/关闭阴影 | SHADOW\_SET | {value:boolean} | mesh 接影需 `?collision=*.glb`；仅 voxel/无 collision 时仍为平面接影 |
| 更新阴影深度 | SHADOW\_INTENSITY\_UPDATE | {value:number} | 范围\[0,1\], 0为最暗1为不压暗 |
| 更新阴影方向 | SHADOW\_DIRECTION\_SET | { value: number } | 范围\[0,360\] |

### 特效与视频导出

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| reveal 参数增量更新 | EFFECT\_PARAMS\_PATCH | { module: 'effect', effectId: 'scene.gsplat-reveal', params: { type?, totalDuration?, autoStart?, effectParams? } } | reveal 轨；`effectParams` 为扁平专参或 `null` 清空，键白名单见 `reveal-effect-params.ts` |
| persistent 类型设置 | EFFECT\_PERSISTENT\_SET | { module: 'effect', effectId: 'scene.gsplat-persistent', persistentType?: PersistentEffectType \| 'none' } | persistent 轨命令；effectId 必须是 `scene.gsplat-persistent` |
| 停止当前 reveal 播放 | EFFECT\_STOP | { module: 'effect', effectId: 'scene.gsplat-reveal' } | 仅停播，不改已保存 reveal 配置 |
| 重新播放 reveal | EFFECT\_REPLAY | { module: 'effect', effectId: 'scene.gsplat-reveal', restartAnim?: boolean } | restartAnim 默认为 true |
| 开始导出 | VIDEO\_EXPORT\_START | {includeVfx?:boolean, projectName?: string} | includeVfx默认为true |
| 取消导出 | VIDEO\_EXPORT\_CANCEL |  |  |

## Viewer->父级（postMessage上报）

### 编辑模式相关

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 响应“请求退出” | EDIT\_EXIT\_NEEDS\_SAVE | {value: boolean} | 收到父级 `EDIT_MODE_EXIT_REQUEST` 后回传；`needsSave` 为 true 时父级弹出「退出并保存/退出不保存/取消」弹窗，为 false 时父级直接发送 `EDIT_MODE_SET { value: false }` |
| 撤销/重做按钮状态 | EDIT\_HISTORY\_STATE | {canUndo: boolean, canRedo: boolean} | 编辑历史变化时（及进入编辑模式、加载完成时）上报，供父级更新撤销/重做按钮的可用状态 |
| 配置已保存 | SETTINGS\_UPDATED | { requestId?: string } | 仅 `destination: 'universe'`（已上传 OSS）。`host` **不发**本事件 |
| 保存失败 | SETTINGS\_SAVE\_FAILED | { message: string, requestId?: string } | 仅 `universe`。`host` 失败走 `SETTINGS_SAVE_RESULT { ok: false }` |
| 交回保存产物 | SETTINGS\_SAVE\_RESULT | `{ ok: true, requestId?, settings, files: [{ path, file }], references: [{ path, field }], contentChanged }` 或 `{ ok: false, requestId?, message }` | postMessage 本地保存（`destination: 'host'`）。不自动下载、不上传。父级用产物打包下载或交给客户上传。主模型未改时 `contentChanged: false`、不带回主模型；Viewer 改过才带回修改后的文件 |
| 主场景首帧 | VIEWER\_READY | { requestId?: string } | 主 splat 已出第一帧，可以展示 Viewer。此时场景内资产可能仍在加载。对应失败是 `VIEWER_LOAD_FAILED`。URL `?requestId=` 有值时回传 |
| 配置或主场景加载失败 | VIEWER\_LOAD\_FAILED | `{ requestId?, stage: 'settings' \| 'content', message, status?, url? }` | `settings` = settings.json；`content` = 主模型。发生后不再发 `VIEWER_READY`。不含场景内资产（那是 `VIEWER_ASSETS_LOAD_FAILED`）。同一加载最多一次 |
| 场景资产就绪，可开始编辑 | VIEWER\_ASSETS\_READY | { requestId?: string } | 启动期 settings 场景资产 restore 完成且当前无在途 gaussian/mesh 加载。每个加载会话只发一次。有开场 reveal 时会等到 reveal 结束再 restore。失败对子是 `VIEWER_ASSETS_LOAD_FAILED` |
| 场景资产加载失败 | VIEWER\_ASSETS\_LOAD\_FAILED | `{ requestId?, message, status?, url?, failedCount }` | 启动期场景内资产未能全部就绪（含 mesh/gaussian HTTP 失败、缺 URL、放置失败）。发生后不再发 `VIEWER_ASSETS_READY`。每个加载会话最多一次 |

### 资产相关

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 场景点击选中资产变化 | SCENE\_ASSET\_SELECTED | { module: 'asset', id: string \| null, assetType?: 'image' \| 'mesh' \| 'gaussian' \| 'video' \| 'audio' } | `module` 与第四期出站约定一致；`assetType` 与 `AssetLibraryType` 一致；在可解析时附带（优先运行态 `scenePlacedEntities`，否则回退 `settings.sceneAssets`），便于父级区分 mesh / 高斯等 |
| 点击放置资产结束 | SCENE\_ASSET\_PLACED | { module: 'asset', id: string } | `module` 与第四期出站约定一致 |
| 单条资产热区触发距离已更新（仅 baseline） | SCENE\_ASSET\_MEDIA\_TRIGGER\_DISTANCE\_CHANGED | { module: 'asset', id, value: { triggerDistanceM } } | **仅**在 **`ASSET_MEDIA_HOTSPOT_SET_BASELINE` 成功**后回传；**`MEDIA_HOTSPOT_SET` / `ASSET_MEDIA_HOTSPOT_RANGE_SET` 入站均不回传** |

### 标注相关

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| ~~占位标注创建或位置变更时上报~~ | ~~ANNOTATION\_PLACEMENT\_UPDATE~~ | ~~{ id: string, value: AnnotationData }~~ | 暂时不需要上报了 |
| 场景中点击选中标注 | SCENE\_ANNOTATION\_SELECTED | { module: 'annotation', id: string } | `module` 与第四期出站约定一致，详见 **docs/SaaS第四期编辑模式接口文档.md** §5.1 |
| 场景中标注进入编辑模式 | SCENE\_ANNOTATION\_EDIT\_START | { module: 'annotation', id: string, value: Partial<AnnotationData> } | 同上；value 含 `title` / `text` / `image?: string` / `video?: string` / `showTitleWhenCollapsed`（image 与 video 互斥；出站只带 URL 字符串，不含 File） |

### 环境设置

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 场景中点击选中光源 | SCENE\_LIGHT\_SELECTED | { module: 'environment', id: string \| null } | `module` 与第四期出站约定一致，详见 **docs/SaaS第四期编辑模式接口文档.md** §5.1 |
| 点击放置光源结束 | SCENE\_LIGHT\_PLACED | { module: 'environment', id: string } | 同上 |

### 特效与视频导出

| 功能 | 事件名（type） | payload | 补充说明 |
| --- | --- | --- | --- |
| 视频导出开始 | VIDEO\_EXPORT\_STARTED | { module: 'effects' } | `module` 与第四期出站约定一致，详见 **docs/SaaS第四期编辑模式接口文档.md** §5.1 |
| 视频导出被中断 | VIDEO\_EXPORT\_CANCELLED | { module: 'effects' } | 同上 |
| 视频导出结束 | VIDEO\_EXPORT\_END | { module: 'effects' } | 同上 |