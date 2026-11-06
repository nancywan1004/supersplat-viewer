# UniVerse 场景编辑器接入说明

适用版本：SDK `0.1.0`

## 交付内容

- `dist/studio-sdk.js`：通过 `import` 引入。
- `dist/studio-sdk.global.js`：通过普通 `<script>` 标签引入，使用 `UniverseStudio.createStudio()`。
- `dist/*.d.ts`：TypeScript 类型。
- `examples/`：接入示例。

SDK 用于在客户网站中打开我方托管的编辑器，无需客户部署 Studio、Editor 或 Viewer。

## 接入编辑器

将 SDK 文件放到客户网站，通过 HTTPS 或本机 HTTP 服务打开页面。填写编辑器地址和有效的原始 token，无需登记网站地址。

```html
<div id="studio" style="height: 600px"></div>

<script type="module">
  import { createStudio } from './dist/studio-sdk.js'

  const client = createStudio({
    container: document.querySelector('#studio'),
    url: 'https://universe-api.bdnrc.org.cn/',
    accessToken: '替换为客户系统取得的原始token',
    mode: 'edit',
    onExitRequested() {
      client.destroy()
    },
  })

  try {
    await client.ready
    await client.load({
      kind: 'url',
      modelUrl: 'https://files.example.com/model.sog',
      // 有场景配置时填写，没有时省略。
      settingsUrl: 'https://files.example.com/settings.json',
    })
  } catch (error) {
    console.error(error.message)
  }
</script>
```

示例中的模型和配置地址需替换为客户实际文件地址。

token 由客户系统申请和刷新，不要添加 `Bearer `。取得新 token 后，需要关闭旧实例并重新创建；重新创建前请先保存需要保留的修改。

## 模型与模式

- `mode: 'edit'`：编辑模式，默认值。
- `mode: 'view'`：浏览模式，不提供编辑和保存。切换模式需重新创建实例。
- URL 加载：填写模型地址，配置地址选填；LOD 项目将 `lod-meta.json` 地址填写到 `modelUrl`。
- 本地加载：支持 `.sog/.splat/.ply`；通过 `load({ kind: 'files', files })` 传入文件选择器取得的 `File[]`。项目和 LOD 文件应保留完整目录；ZIP 先解压。

文件服务器需要允许以下地址跨网站读取模型、配置及相关文件：

- Studio：`https://universe-api.bdnrc.org.cn`
- Viewer：`https://3dgs-viewer-test-api.bdnrc.org.cn`
- Editor：`https://3dgs_editor-dev.bdnrc.org.cn`

跨网站读取配置应设置在提供文件的服务器上。LOD 描述文件和全部分片都需要可访问；视频文件服务需要支持分段读取。

## 保存、下载和关闭

调用 `await client.save()` 保存项目：

- 未配置客户保存回调时，生成项目 ZIP 并发起下载。
- 配置 `saveArtifacts` 时，客户回调收到场景配置、文件及引用关系，由客户完成上传、配置文件及版本保存，再返回 `{ status: 'success' }`。
- 需要重新打开时，可额外返回 `reopen: { modelUrl, settingsUrl }`；两个地址都必须有效。没有地址仍表示保存成功。
- 保存失败时，回调可以抛出异常，或返回 `{ status: 'failure', message: '保存失败' }`。

Studio 工具栏的“下载”始终生成项目 ZIP，不调用客户保存回调。下载包保留已有远程资源地址，不保证完全离线使用。

用户在 Studio 中确认退出后，会触发 `onExitRequested`。客户页面关闭时调用 `client.destroy()`；销毁实例不会自动保存。

## 可选配置

客户资产库通过 `assets.getAssetList()` 和 `assets.getAssetDetail()` 接入；未配置时资产库不可用。

天空盒和特效预览可通过 `materials` 提供，未配置时使用内置公开素材。回调参数和返回类型见包内 TypeScript 声明及示例。

## 常见问题

- 初始化失败：检查 token 是否有效、编辑器地址是否可访问。
- 文件读取失败：检查文件地址，以及文件服务器是否允许上述地址跨网站读取。
- 保存结果未确认：先核对客户系统中的实际保存结果，再决定是否重试。
