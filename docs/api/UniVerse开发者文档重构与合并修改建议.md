# UniVerse 开发者文档重构与合并修改建议

## 1. 总体建议

当前文档存在较多内容重复，主要集中在 Token、CORS、模型加载、LOD、本地文件、保存下载、资产库和 Editor/Viewer 关系等主题。

建议采用“职责单一、唯一事实来源”的结构：

- 总览文档负责导航和能力边界；
- REST 文档负责三维重建后端接口；
- Studio SDK 文档负责 Studio/Viewer 接入细节；
- Editor 文档负责 Editor 专题能力；
- 快速接入内容合并到 SDK 文档中。

## 2. 推荐的最终文件结构

```text
docs/api/
├── UniVerse企业版API交付说明.md
├── UniVerse三维重建REST接入说明.md
├── UniVerseStudioSDK使用说明.md
└── UniVerseEditor能力与接入说明.md
```

建议移除：

```text
UniVerseStudio快速接入.md
```

如果开发者平台已经使用 `quickstart` 作为固定入口，不建议直接让旧链接失效。可以将其改为跳转到 `UniVerseStudioSDK使用说明.md`，或者保留一个只包含跳转提示的兼容页面。

## 3. 各文档职责

### 3.1 企业版 API 交付说明：总览和导航

文件：`UniVerse企业版API交付说明.md`

保留内容：

- UniVerse 能力总览；
- 三维重建、场景浏览编辑、Editor 三类能力；
- 各专项文档入口；
- 最小接入流程；
- 重要限制和待确认事项摘要。

建议删除或改为链接的内容：

- Token 的详细申请和刷新流程；
- CORS 的完整配置规则；
- SDK 保存和下载细节；
- LOD、本地文件和 ZIP 细节；
- Editor 的详细输入输出契约。

该文档应定位为平台首页或开发者入口，不再承担完整 API 参考职责。

### 3.2 三维重建 REST 接入说明：REST 唯一事实来源

文件：`UniVerse三维重建REST接入说明.md`

集中维护以下内容：

- 测试和生产服务地址；
- 签名算法；
- Token 申请和刷新；
- 任务提交、查询和列表接口；
- 请求参数和响应字段；
- 轮询、错误和服务限制；
- 重建结果进入 Studio 的方式；
- 尚未确认的后端事项。

企业版 API 交付说明只需要介绍 REST 能力并链接到本文，不要复制 REST 参数和鉴权细节。

### 3.3 Studio SDK 使用说明：Studio/Viewer 完整参考

文件：`UniVerseStudioSDK使用说明.md`

该文档应作为 Studio 接入的主文档，集中维护：

- `createStudio()` 和 `connectStudio()`；
- SDK 初始化参数；
- URL、本地文件和 LOD 加载；
- `view` / `edit` 模式；
- `load()`、`save()`、取消加载和 `destroy()`；
- `saveArtifacts` 客户保存回调；
- 资产库和素材回调；
- CORS 规则；
- Token 的使用方式；
- 保存返回值和错误处理；
- Viewer 支持的主场景格式和项目目录规则。

原“快速接入”文档中的最小可运行示例应放在本文开头，作为快速开始章节。

当前 SDK 文档后半部分另有一段“Studio SDK 交付说明”。建议将其合并到本文的“接入前准备”或“SDK 交付信息”章节，避免同一文件中存在两套重复的介绍。

如果交付清单内容较多，也可以拆分为单独文件：

```text
UniVerseStudioSDK交付清单.md
```

用于记录 SDK 版本、ZIP 文件清单、Demo 地址、类型声明、示例目录和校验文件。

### 3.4 Editor 能力与接入说明：Editor 专题

文件：`UniVerseEditor能力与接入说明.md`

只保留 Editor 特有内容：

- Editor 与 Studio 的关系；
- 高斯模型编辑；
- 相机轨道编辑；
- Editor 输入和输出格式；
- “完成”和“取消”的行为；
- 编辑结果交回 Studio 的流程；
- Editor 会话、安全和消息边界；
- Editor 特有的模型格式限制。

以下内容建议删除或改为链接：

- Studio SDK 初始化；
- 通用 Token 说明；
- Studio 保存和下载流程；
- Viewer 的完整模型加载规则；
- 资产库、天空盒和特效回调；
- 通用 CORS 说明。

Editor 文档应明确区分 Editor 自身支持的格式和 Studio/Viewer 项目加载格式，避免将两者混为一谈。

## 4. 建议移除的重复文档

### `UniVerseStudio快速接入.md`

建议移除，原因如下：

- SDK 引入和 `createStudio()` 示例与 SDK 使用说明重复；
- Token 说明重复；
- URL、本地文件和 LOD 加载说明重复；
- 保存、下载、退出说明重复；
- 资产库、天空盒和特效回调说明重复；
- CORS 和碰撞说明重复。

删除前应将其中唯一有价值的内容——最小接入示例——合并到 SDK 使用说明开头。

## 5. 唯一事实来源

以下内容应只在一个文档中完整定义，其他文档只做摘要并提供链接：

| 内容 | 唯一维护位置 |
| --- | --- |
| REST Token 申请和刷新 | 三维重建 REST 接入说明 |
| SDK 如何传入 Token | Studio SDK 使用说明 |
| Studio、Viewer、Editor 地址 | 企业版 API 交付说明或 Studio SDK 使用说明 |
| CORS 配置规则 | Studio SDK 使用说明 |
| Viewer 主场景格式 | Studio SDK 使用说明 |
| Editor 模型格式 | Editor 能力与接入说明 |
| Studio 保存和下载行为 | Studio SDK 使用说明 |
| Editor“完成”行为 | Editor 能力与接入说明 |
| 资产类型枚举 | Studio SDK 类型/接口说明 |
| 编辑模块名称 | 能力总览或 Studio SDK 说明 |
| REST 待确认事项 | 三维重建 REST 接入说明 |

## 6. 推荐引用关系

```text
企业版 API 交付说明
├── 三维重建 REST 接入说明
├── Studio SDK 使用说明
└── Editor 能力与接入说明
```

职责关系应保持如下：

- 总览文档负责导航；
- REST 文档负责后端接口；
- SDK 文档负责 Studio/Viewer 接入；
- Editor 文档负责 Editor 专题；
- 快速接入内容合并进 SDK 文档。

## 8. 重构后的验收标准

完成文档合并后，应满足：

1. 同一个参数、枚举或能力只存在一个完整定义；
2. 总览文档不再复制完整接口细节；
3. 快速接入示例可以直接运行；
4. Editor、Studio、Viewer 的格式边界清晰；
5. Token、CORS、保存和下载行为没有多套表述；
6. 旧的 `quickstart` 链接有跳转或兼容页面；
