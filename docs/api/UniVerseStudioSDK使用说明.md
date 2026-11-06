# UniVerse Studio SDK 使用说明

适用于 SDK `0.1.0`，更新日期：2026-10-20。Studio 和在线 Demo 地址见交付说明。

## 1. 接入前准备

将交付包解压到客户网站可访问的目录。页面应通过 HTTPS 或本机 HTTP 服务打开，不能使用 `file://`。

填写 Studio 地址和有效的原始 token，即可接入，无需提前登记网站地址。客户负责申请和刷新 token；拿到新 token 后销毁旧实例并重新创建。SDK 没有申请、刷新或动态更新 token 的方法。

`accessId`、`secretKey` 应由客户服务端保管，不要写入网页或前端环境变量。客户网页只向 SDK 传入当前有效的原始 token，不加 `Bearer `。Token 有效期以申请或刷新响应中的 `expiresIn` 为准。

模型和资源跨域配置应设置在**提供文件的服务器**上，而不是仅设置在客户页面服务器：

- 配置文件允许 `https://universe-api.bdnrc.org.cn` 读取。
- 模型、配置及关联资源允许 `https://3dgs-viewer-api.bdnrc.org.cn` 读取。
- 使用模型或路径编辑时，相应文件还需允许 `https://3dgs_editor.bdnrc.org.cn` 读取。
- 自定义预览素材还需允许 Studio 读取；视频服务需支持 Range 请求。LOD 描述文件及每个分片都要可访问。

允许来源应包含协议和完整域名。SDK 不会自动给文件请求附加客户的 HTTP 请求头，需要鉴权的文件可使用有效的签名 URL，不要随意解码或改写签名参数。

## 2. 最小接入

包内 `examples/index.html` 已提供 token、模式、URL 和本地文件输入，可直接放到客户静态网站中使用。

自建页面时，给容器设置高度，并使用下面的代码。`accessToken` 由客户系统提供，示例地址替换为实际文件地址：

```html
<div id="studio" style="height: 600px"></div>
<script type="module">
  import { createStudio } from './dist/studio-sdk.js'

  const accessToken = '替换为当前有效的原始token'
  const client = createStudio({
    container: document.querySelector('#studio'),
    url: 'https://universe-api.bdnrc.org.cn/',
    accessToken,
    mode: 'edit',
    onExitRequested() { client.destroy() },
  })
  try {
    await client.ready
    await client.load({
      kind: 'url',
      modelUrl: 'https://files.example.com/project/model.sog',
      // 不需要配置时，省略这一行。
      settingsUrl: 'https://files.example.com/project/settings.json',
    })
  } catch (error) {
    document.querySelector('#studio').textContent = error.message
    client.destroy()
  }
</script>
```

不用 ESM 的页面可以先引入 `<script src="./dist/studio-sdk.global.js"></script>`，再调用 `UniverseStudio.createStudio(options)`；参数相同。已有 iframe 时使用 `connectStudio({ iframe, url, accessToken, mode })`，由 SDK 设置其地址，示例见 `examples/integration.ts`。

## 3. 加载模型

`mode: 'edit'` 为默认编辑模式；`mode: 'view'` 只浏览，不能保存或进入 Editor。模式固定，切换模式需销毁并重建实例。

普通 URL 使用上面的 `load()`。`settingsUrl` 可省略，提供时须返回有效的配置 JSON；`transform.json` 等旧配置是否能用由 Viewer 判断，文件名本身不能保证兼容。

LOD 使用完整描述文件地址，不要把它填到配置地址：

```js
await client.load({
  kind: 'url',
  modelUrl: 'https://files.example.com/project/lod-meta.json',
})
```

本地模型或目录使用原始 `File[]`：

```html
<input id="files" type="file" multiple>
<input id="folder" type="file" webkitdirectory multiple>
```

```js
// 在文件选择完成后执行；files 也可以换成 folder。
const input = document.querySelector('#files')
await client.load({ kind: 'files', files: Array.from(input.files) })
```

本地普通模型支持 `.sog/.splat/.ply`，可带配套文件，无需强制提供 settings。提供 `settings.json` 时需保留它指向的主模型和资源，不能选择多份配置造成歧义。LOD 请选择包含唯一 `lod-meta.json` 和全部分片的完整目录。保留目录层级，不把不同目录的同名文件合并。SDK 不直接读取 ZIP，先解压再选择目录。

本地选择文件不等于上传到我方服务器；需要持久保存时，由客户保存回调完成上传。

## 4. 保存、下载和退出

- `await client.save()`：编辑模式下保存；未配置客户保存回调时，生成项目 ZIP 并发起下载。
- Studio 工具栏“下载”：始终下载项目 ZIP，即使配置了客户保存回调也不调用该回调。进度与取消在弹窗中操作，SDK 没有单独的 `download()` 或 `cancelSave()` 方法。
- ZIP 包含完整配置和 Viewer 返回的模型、资源文件，保留目录；已有远程 URL 继续保留。解压后通过目录加载重新打开。
- `save()` 返回 `status: 'download-started'` 只表示浏览器已开始下载，不表示文件已落盘；`status: 'saved'` 表示客户保存回调已报告成功，`reopen` 地址可选。
- `await client.cancelLoad()`：取消仍在加载的场景；不会取消保存，也不会清空已经就绪的场景。
- 用户点击 Studio“退出”并确认后触发 `onExitRequested`，客户页面可在其中关闭弹窗或调用 `destroy()`。
- 页面离开时调用 `client.destroy()` 清理实例。它不自动保存；主动销毁或加载其他项目之前，请先处理需要保留的修改。

客户保存成功后，只有返回了地址才可通过 SDK 重新打开：

```js
const result = await client.save()
if (result.status === 'saved' && result.reopen) {
  await client.load({ kind: 'url', ...result.reopen })
}
```

没有地址仍表示保存成功，Demo 的“重新打开客户保存”按钮保持不可用。

## 5. 客户回调（选用）

这些函数在创建实例时配置，代码由客户实现，SDK 不规定客户接口地址。完整类型见 `dist/types.d.ts`，可编译的接入示例见 `examples/integration.ts`。

| 配置 | 参数 | 返回 |
| --- | --- | --- |
| `assets.getAssetList(query, signal)` | `query` 含 `type/name/pageNum/pageSize` | `{ items, total }` |
| `assets.getAssetDetail(id, signal)` | 所选资源 ID | 含 `id/type/name/resourceUrl` 的详情 |
| `materials.getSkyboxPresets(signal)` | 可取消信号 | `[{ name, url }]` |
| `materials.getEffectPreviews(signal)` | 可取消信号 | `[{ effectType, url }]` |
| `saveArtifacts(artifacts, { signal })` | 配置、文件和引用关系 | 最终成功或失败结果 |

资产类型为 `object3dmodel/gs/img/video/audio`。列表项至少含 `id/type/name`，可附 `thumbnailUrl`。未配置资产库时显示不可用；未配置素材来源时使用内置公开 CDN 天空盒和特效预览。配置了某一素材回调后，该来源以客户结果为准。

左侧编辑目录按客户权限显示。本地模型没有 `settings.collision.url` 时，物理碰撞和阴影开关关闭且不可操作，悬浮提示使用模型 URL；已有碰撞资源的本地项目可以使用现成资源。仅本地选择配置文件，不会将 URL 模型认定为本地模型。

保存回调收到以下数据：

| 字段 | 含义 |
| --- | --- |
| `saveId` | 本次保存标识，可用于防止重复写入 |
| `settings` | 完整场景配置 |
| `files` | `{ path, file }[]`，项目相对路径及 File |
| `references` | `{ path, field }[]`，文件路径与配置字段的对应关系 |
| `contentChanged` | 主模型是否变化 |

客户先上传 `files`，按 `references` 更新配置中的文件地址，再保存完整 settings 和版本。`field` 使用点号与数组下标，例如 `annotations[0].imageUrl`；仅更新指定字段，保留其他配置，不批量替换所有字符串。LOD 上传保持分片目录与描述文件引用有效。

全部保存成功后，返回以下结果即可，不必生成重新打开地址：

```js
return { status: 'success' }
```

需要通过 SDK 重新打开时，可额外返回 `reopen`；提供时模型和配置两个地址都必须有效：

```js
return {
  status: 'success',
  reopen: {
    modelUrl: 'https://files.example.com/project/model.sog',
    settingsUrl: 'https://files.example.com/project/settings.json',
  },
  versionId: '客户版本号', // 可选
}
```

失败时抛出异常或返回 `{ status: 'failure', message: '保存失败' }`。如提供 `reopen`，其中地址须能重新访问，不能使用临时 `blob:` 地址；地址不完整或无效时会报错。编辑器内部的“完成”只返回修改，不等于客户保存成功。

## 6. 常见问题

| 情况 | 检查方式 |
| --- | --- |
| 初始化失败或一直等待 | 检查 token 是否有效、Studio 是否可访问 |
| 配置读取失败 | 检查文件服务器 CORS、HTTP 状态及实际 JSON 内容 |
| 文件或目录加载失败 | 保留完整目录与资源，确认配置指向的模型存在，再查看实际错误 |
| 调用返回 `UNCONFIRMED` | 当前结果不确定；保存时先确认客户后台结果，不自动重复提交 |
| 浏览模式保存失败 | `view` 不提供保存；需要编辑时重建为 `edit` |
| token 已过期 | 客户取得新 token 后重建实例，重建前处理未保存修改 |

文件用途和服务地址见 [交付说明](./交付说明.md)，在线界面操作见 [Demo界面操作说明](./Demo界面操作说明.md)。


---

# UniVerse Studio SDK 交付说明

## 版本与用途

| 项目 | 内容 |
| --- | --- |
| SDK 版本 | `@proj/studio-sdk` `0.1.0` |
| 文档更新日期 | 2026-10-20 |
| 使用环境 | 桌面网页，建议使用最新版 Chrome 或 Edge |
| 交付方式 | ZIP，包含 ESM、普通 script 和 TypeScript 类型；未发布 npm |

本包用于在客户网页内打开场景浏览和编辑界面。客户引入 SDK，连接我方托管的 Studio；模型与相机路径编辑由 Studio 打开 SuperSplat Editor。客户无需分别部署 Studio、Viewer 和 Editor。

## 服务地址

| 服务 | 地址 |
| --- | --- |
| Studio | <https://universe-api.bdnrc.org.cn/> |
| 在线 Demo | <https://universe-apidemo.bdnrc.org.cn/demo/index.html> |
| Viewer | <https://3dgs-viewer-api.bdnrc.org.cn/> |
| Editor | <https://3dgs_editor.bdnrc.org.cn/> |
| OpenAPI | <https://unicity3-api.bdnrc.org.cn/openapi> |

客户初始化 SDK 时只需填写 Studio 地址和有效的原始 `accessToken`，不需要登记网站地址，也不需要填写 Viewer 或 Editor 地址。后两者列在此处，用于配置客户文件服务器的跨域读取许可。

## 包内文件

| 文件 | 用途 |
| --- | --- |
| `dist/studio-sdk.js` | 通过 `import` 引入 |
| `dist/studio-sdk.global.js` | 普通 script 标签引入，使用 `UniverseStudio` |
| `dist/*.d.ts` | TypeScript 类型声明 |
| `examples/index.html`、`example.js` | 填写 token，加载 URL 或本地文件的示例 |
| `examples/integration.ts` | 客户回调和已有 iframe 的接入示例 |
| `客户接入说明.md` | 最小接入步骤 |
| `使用说明.md` | 参数、方法、保存和客户回调 |
| `Demo界面操作说明.md` | 在线 Demo 的界面操作 |
| `文档.html` | 可直接打开的离线说明 |
| `package.json`、`manifest.json` | SDK 版本和文件信息 |
| `SHA256SUMS` | 包内文件校验值；ZIP 校验值另附在压缩包旁 |

## 接入前准备

1. 客户服务端保管 `accessId`、`secretKey`，负责申请和刷新 Token；网页只向 SDK 传入当前有效的 `accessToken`，不要添加 `Bearer `。
2. 准备可访问的模型和可选配置文件，按使用说明配置文件服务器的跨域读取许可。
3. 需要客户资产库或保存服务时，实现相应回调。示例不包含上传和存储服务。

SDK 不提供申请、刷新或动态更新 Token 的方法。更换 Token 或浏览/编辑模式时，需要先保存修改，再销毁并重新创建实例。在线 Demo 的授权表单仅便于演示，不是客户网站的接入要求。

## 使用范围

- 左侧编辑目录按当前客户的菜单权限显示。
- 支持模型 URL、本地模型和项目目录。LOD URL 使用 `lod-meta.json`；本地 LOD 需要描述文件和全部分片。ZIP 先解压再导入。
- 未配置客户资产库时，资产库不可用；天空盒和特效预览默认使用公开 CDN 素材，也可由客户配置。
- 本地模型没有 `settings.collision.url` 时，物理碰撞和阴影开关不可用；本地项目已有碰撞资源时可以使用现成资源。URL 模型保留生成流程，实际结果取决于相应服务。
- 未配置 `saveArtifacts` 时，“保存”下载项目 ZIP；配置后由客户回调上传文件和保存配置。“下载”始终生成项目 ZIP。
- 项目 ZIP 包含完整配置及 Viewer 返回的模型、资源文件，并保留已有远程 URL；它不会自动下载所有远程资源。重新打开仍可能需要联网。

包内文档可以离线阅读，SDK 示例和场景编辑器需要 HTTP(S) 页面及网络连接。本包不包含重建任务 REST 客户端，也不是编辑器离线安装包。
