# 三维重建 REST API 接入说明

更新日期：2026-10-20。参考接口材料：`OpenAPI-接口-v1.0.1-20260909.pdf`。本页整理已有接口，不替代后端完整参数契约；文末列出尚未确认的口径。

[下载原始接口 PDF](/developer/openapi-v1.0.1-20260909.pdf)。PDF 中包含历史示例，与本页标注有差异的内容需后端确认后再接入。

## 1. 环境与请求约定

| 项目         | 现有 PDF 列示值                                                  |
| ------------ | ---------------------------------------------------------------- |
| 测试服务域名 | `https://unicity3dev-api.bdnrc.org.cn`                           |
| 生产服务域名 | `https://unicity3-api.bdnrc.org.cn`                              |
| 示例网关前缀 | `/openapi`                                                       |
| 请求格式     | JSON 请求体按接口定义传递；业务请求使用 Bearer Token             |
| 业务响应     | `code`、`message`、`data`；PDF 定义 `code: 1` 为成功，`0` 为失败 |

PDF 的接口表写 `/api/v1/...`，示例完整地址带 `/openapi/api/v1/...`。请使用平台为客户开通的完整网关地址，不能直接把 UniVerse SaaS 网站地址当作 REST 服务地址。

## 2. 服务端申请 Token

密钥由客户服务端保管。`AccessSecret` 在 REST 文档中称为 `secretKey`，不能放入浏览器页面或前端构建环境变量。

现有签名规则：

```text
plain = secretKey + String(timestamp) + random
signature = SHA256(plain) 的小写十六进制字符串
```

`timestamp` 为毫秒时间戳，`random` 建议使用 UUID。请求体为：

```json
{
  "accessId": "替换为平台开通的AccessId",
  "timestamp": 0,
  "random": "每次请求生成的新UUID",
  "signature": "按本次时间戳和随机串计算的SHA256小写hex"
}
```

示例值不能原样提交；签名必须由服务端按当前值计算。申请接口为 `POST /api/v1/oauth/token`，成功的 `data` 包含 `accessToken`、`tokenType`、`expiresIn` 和 `refreshToken`。

其他 REST 请求带上：

```http
Authorization: Bearer <accessToken>
```

有效期按 `expiresIn`（秒）处理，PDF 示例是 7200 秒。客户服务端应保存 Token 对和到期时间，避免把 Token 写入公开日志。

## 3. 刷新 Token

调用 `POST /api/v1/oauth/refresh/token`，请求头带上一次取得的 `accessToken`，请求体传上一次取得的 `refreshToken`：

```json
{ "refreshToken": "上一次申请或刷新得到的RefreshToken" }
```

成功后保存新的 Access Token 与 Refresh Token。Refresh Token 会轮换，旧值不能再次续期；刷新失败或已过期时，按接口结果重新申请。PDF 建议提前刷新，并列示刷新频率限制为 60 秒内最多 30 次，此限制不代表任务查询的轮询频率。

Studio SDK 只接收原始 Token，不替客户申请/刷新，也不提供动态更新 Token 的方法。重建与 Studio 的最新 Token 共用范围仍待后端确认，按客户实际开通的产品范围接入。

## 4. 提交和查询任务

| 方法 | 接口路径                         | 作用                     |
| ---- | -------------------------------- | ------------------------ |
| POST | `/api/v1/external/task/submit`   | 提交训练任务             |
| GET  | `/api/v1/external/task/{taskId}` | 查询进度、错误和模型结果 |
| GET  | `/api/v1/external/task/list`     | 查询当前 AK 的任务列表   |
| GET  | `/api/v1/resource/menus`         | 查询当前 AK 可用菜单资源 |

### 提交参数

| 字段               | 已有含义                                                       |
| ------------------ | -------------------------------------------------------------- |
| `name`             | 项目名称                                                       |
| `type`             | `1` 物体，`2` 场景                                             |
| `sceneType`        | 场景类型：`1` 室内，`2` 室外；具体必填条件见 PDF               |
| `files`            | 源文件列表；`url` 为重建服务能从互联网访问的完整路径           |
| `files[].name`     | 文件名                                                         |
| `files[].fileSize` | 文件大小，字节                                                 |
| `files[].type`     | 源文件使用 `src`                                               |
| `removePerson`     | `0` 不抠除人物，`1` 抠除人物                                   |
| `deviceType`       | `1` 普通相机、`2` 全景相机、`3` 无人机、`4` 鱼眼相机、`5` 手机 |

必填性和场景条件按 PDF 参数表及后端最新确认结果执行。文件实际允许的类型、ZIP 要求、大小/时长/数量限制仍见文末待确认项，不以示例代替验收规则。

提交成功后保存 `data.taskId`、`data.requestId`，用任务 ID 查询详情。此操作会真正启动重建，接入前需确认业务配额和计费规则。

### 查询结果

| 字段                              | 含义                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `status`                          | `1` 初始、`2` 训练中、`3` 成功、`4` 失败                                    |
| `progress`                        | 进度，0–100                                                                 |
| `errorMsg`                        | 失败原因                                                                    |
| `models`                          | 模型文件列表，含 `fileName/fileUrl/fileSize/fileType`；PDF 定义非成功时为空 |
| `startTime/finishTime/createTime` | 训练和任务时间                                                              |

查询到成功或失败后停止轮询；允许的轮询频率待后端确认，不在本页写死。网络失败与业务失败应按实际响应分别处理，不凭缺失的 `models` 判定任务已失败。

任务列表支持 `status/startTime/endTime/pageNum/pageSize`，PDF 列示默认每页 10 条、最大 100 条。完整返回字段和请求示例请下载原始 PDF。

## 5. 从重建结果进入 Studio

Studio 的 URL 加载需要可用的 SOG、PLY、SPLAT 或 `lod-meta.json`，场景配置地址可选。请在后端明确可浏览产物字段和格式后，再将对应地址交给 `client.load()`。

现有 REST 示例使用 `model_result.pth`，不能因此承诺它可直接被 Studio 加载，也不能把任意 `models[0].fileUrl` 当作可浏览入口。最终可浏览模型、配置地址和相关资源的对应关系待后端确认。

## 6. 待后端确认

| 问题           | 未对齐之处                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- |
| 图片输入       | 初稿说必须 ZIP、不支持单张图片；现有 PDF 则有 JPG 示例。需确认实际类型、ZIP 结构和采集类型约束  |
| URL 编码       | 初稿要求还原中文 URL，PDF 未定义对应限制。需明确特殊要求及签名 URL 的正确处理方式，不能统一解码 |
| 可浏览结果     | 需明确 `models` 中可交给 Viewer/Studio 的产物及配置字段，不能使用 `.pth` 示例推定               |
| Token 适用范围 | PDF 说明 Token 仅适用于该文档接口；初稿描述与 Studio 共用，需最新授权契约                       |
| 查询及服务限制 | 任务轮询频率、各文件类型限制、完整错误码、实际配额和计费规则需对应最新开通说明                  |

以上项目在确认前保持待确认，不补写未提供的接口、枚举或转换逻辑。
