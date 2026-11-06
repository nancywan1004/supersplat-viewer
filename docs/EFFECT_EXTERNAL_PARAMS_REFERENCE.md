# 场景 GSplat 特效 — 外部可调参数参考

> 本文档整理 **第四期 `EFFECT_*` 协议** 与 **`settings.effects`** 中，**一次性开场 Reveal** 与 **Persistent 可持续特效** 对外（宿主 / 存盘 JSON）可见、可写的参数；并区分 **协议已接入** 与 **仅引擎内部默认值**（当前无法通过 `EFFECT_PARAMS_PATCH` 调节）。
>
> **代码真源**：`src/editor-modules/protocol-adapters/effects-protocol-adapter.ts`、`src/settings-serialize/effects-sync.ts`、`src/vfx/effects-runtime/reveal/reveal-controller.ts`、`src/vfx/effects-runtime/reveal/reveal-effect-params.ts`、`src/vfx/effects-runtime/persistent/persistent-effect.ts`、`src/vfx/effects-runtime/persistent/persistent-effect-params.ts`、`src/vfx/effects-runtime/effect-types.ts`。

---

## 1. 协议入口与 `effectId`

| 事件 | `effectId` | 说明 |
|------|------------|------|
| `EFFECT_PARAMS_PATCH` | `scene.gsplat-reveal` | 一次性开场 Reveal 轨参数（见 §2） |
| `EFFECT_PARAMS_PATCH` | `scene.gsplat-persistent` | Persistent 轨参数与类型（见 §3） |
| `EFFECT_TOGGLE` | **仅** `scene.gsplat-persistent` | `value: boolean`，开关 persistent 轨 |
| `EFFECT_REPLAY` | **仅** `scene.gsplat-reveal` | `restartAnim?: boolean`（默认 `true`），重播一次性 reveal |

- 入站若带 `module`，须为 **`effects`**（与 `MESSAGE_BRIDGE_MODULE.effects` 一致）；**不传 `module` 也合法**。
- 更完整的载荷与行为说明见 **`docs/SaaS第四期编辑模式接口文档.md`**。

---

## 2. 一次性开场 Reveal（`scene.gsplat-reveal`）

### 2.1 存盘 / 协议层：公共字段 + `effectParams`

`EFFECT_PARAMS_PATCH` 在 **`effectId === 'scene.gsplat-reveal'`** 时，**仅当 `params` 至少包含以下键之一**才会被处理（实现：`paramsPatchHasRevealKeys`）：

| 字段 | 类型 | 约束 / 默认 | 写入位置 |
|------|------|-------------|----------|
| `type` | `string` | 见 §2.2 类型枚举；从 **persistent** 切到 **非 persistent** 时会清空 persistent 轨 | `settings.effects.reveal.paramsById['scene.gsplat-reveal']` |
| `totalDuration` | `number` | **必须 `> 0`**；缺省回退见 `DEFAULT_VFX_TOTAL_DURATION`（`src/schemas/v2-custom.ts`，当前为 **10** 秒） | 同上 |
| `autoStart` | `boolean` | 控制脚本初始 `enabled` | 同上 |
| `effectParams` | `object \| null` | 按当前 `type` 白名单合并到存盘包；`null` 清空专参。见 `reveal-effect-params.ts` | 同上 |

写入后会 **`syncLegacyRevealEffectShadow`** 对齐内存中的 `revealEffect`，并触发 **`revealConfigChanged`** → `RevealController` 更新。

**其它任意 `params` 键**（除上表外）：当前 **不会被** `applyGsplatRevealParamsPatch` 消费。

### 2.2 `type` 可选值（一次性）

与 `REVEAL_EFFECT_TYPE_VALUES`（`src/vfx/effects-runtime/effect-types.ts`）一致：

`radial` · `rain` · `rain-v2` · `smooth` · `pieces-recover` · `integrate` · `growth-wave` · `sketch`

（另：`none` 表示无开场 reveal；**不可**把 persistent 类型放在 reveal 轨，协议切换逻辑会按 persistent 规则处理。）

### 2.3 各 `type` 对公共字段的实际含义（运行时）

以下均在 **`RevealController`** 创建脚本时生效；**除 `type` / `totalDuration` / `autoStart` 及 `effectParams` 白名单键外**，列出的脚本字段均为 **代码内写死的默认值**，无其它协议路径。

| `type` | `totalDuration` | `autoStart` | 备注 |
|--------|-----------------|-------------|------|
| **radial** | **`totalDuration`**：抬升波抵达 `endRadius` 的时刻与之对齐，由 `RevealController.applyRadialRevealTotalDurationConstraint` 在默认 `delay`/`acceleration` 与 `effectParams` 之后反算 **`speed`**（与 `GsplatRevealRadial.getCompletionTime` 同式） | 初始 `script.enabled` | 初始 `endRadius`：`applyAdaptiveEndRadius(0)`；可用 **`effectParams.endRadius`** 等白名单键覆盖 |
| **rain** | 未参与创建公式 | 初始 `enabled` | 初始 `endRadius` 同上；可用 **`effectParams.endRadius`**；`distance`/`speed`/… 等同理 |
| **rain-v2** | **用于** 推导 `script.timeScale`，使推进节奏匹配目标总时长 | 初始 `enabled` | 无脚本 `endRadius`；xz 范围见 **`effectParams.maxDist2D`** 等 |
| **smooth** | 未使用 | 初始 `enabled` | 球形半径为脚本 **`maxRadius`** 默认；可用 **`effectParams.maxRadius`** |
| **pieces-recover** | **用于** 缩放 scatter/recover 时长与 `waveSpeed` | 初始 `enabled` | 默认 `endRadius` **25** + `applyAdaptiveEndRadius`；可用 **`effectParams.endRadius`** |
| **integrate** | **用于** 计算 `verticalSpread` | 初始 `enabled` | `intensity/speed/waveSpeed/waveFrequency` 硬编码；AABB 来自 bbox |
| **growth-wave** | **参与** Phase1 排布与（必要时）**压缩 Phase1** 以装入 `totalDuration`；**Phase2 `recoverDuration` = max(0.5s, totalDuration − Phase1 结束)** | 初始 `enabled` | 默认 `endRadius` **50** + `applyAdaptiveEndRadius`；可用 **`effectParams`** 覆盖 |
| **sketch** | **用于** 缩放 `sketchDuration`/`colorizeDuration` 并反算 `waveSpeed` | 初始 `enabled` | 默认 `endRadius` **200** + `applyAdaptiveEndRadius`；可用 **`effectParams.endRadius`**（若仅改 `endRadius` 而未同步 `waveSpeed`，总时长语义以当前脚本字段为准） |

**策略说明**（与 `reveal-policy.ts` 一致）：

- 凡 **`type !== 'none'` 且非 persistent**，在控制器语义上都会走 **`isRevealTimedVfxType`** 分支（时间轴 UI、`setupTiming`、`effectTime:changed` 等）。
- **`totalDuration`** 对 **rain-v2 / pieces-recover / integrate / growth-wave / sketch** 的创建逻辑有**直接数值影响**；对 **radial** 通过反算 **`speed`** 约束抬升波完成时刻；对 **rain / smooth** 主要影响时间轴/导出等读回，**不改变**脚本内已写死的动画系数（以代码为准）。
- **growth-wave 专参色调**：`effectParams.phase1CloudTint` / `phase2HaloTint` 为 **`[r,g,b]`**（写入脚本 `Color`，与 radial 等一致），分别对应 Phase1 点云/蓝辉与 Phase2 金环的 additive 色；白名单见 **`reveal-effect-params.ts`**。

---

## 3. Persistent 可持续特效（`scene.gsplat-persistent`）

### 3.1 当前类型

与 `PERSISTENT_EFFECT_TYPE_VALUES` 一致，现仅：

- **`perlin-wave`**

关闭：`type: 'none'`（大小写不敏感、空白视为 none）或配合 `enabled: false`（见 `normalizePersistentType`、`applyGsplatPersistentParamsPatch`）。

### 3.2 协议 / 存盘层：`EFFECT_PARAMS_PATCH` 与 `paramsById` 包形

`scene.gsplat-persistent` 的 **`paramsById['scene.gsplat-persistent']`** 由 **`parsePersistentPack` / `persistentToParamRecord`** 序列化：**`type`、`autoStart`、可选 `effectParams`**（**无** `totalDuration`；旧 JSON 若含该键，读入时忽略）。写入由 **`patchPersistentSettingsFromParams`**（`effects-sync.ts`）完成；**`effectParams` 合并语义**与 reveal 的 **`patchRevealSettingsFromParams`** 一致（切换 `type` 且未带 `effectParams` 时清空专参等）。

| 顶层 `params` 字段 | 类型 | 说明 |
|-------------------|------|------|
| `type` | `string` | `perlin-wave` / `none`（及等价空白）；`none` 时清空轨并 teardown（见 `applyGsplatPersistentParamsPatch`） |
| `enabled` | `boolean` | 写在 **`settings.effects.persistent.enabled`**（不入 `paramsById`）；**`EFFECT_TOGGLE`** 转为 `{ enabled: value }` 补丁 |
| `autoStart` | `boolean` | 存盘包内；创建脚本时控制初始 `script.enabled` |
| `effectParams` | `object \| null` | `null` 或 `{}` 清空专参；否则按 **`persistent-effect-params.ts`** 白名单在 **remount** 时写入脚本 |

**`paramsPatchHasPersistentKeys`**：仅当 `params` 含上表之一时处理；**其它任意顶层键不再写入** `paramsById`（避免旧版「整包 spread」污染 JSON）。

专参变更（含仅 **`effectParams`**）在适配器内视为 **pack 变更**：同步 `effectsRuntimeState` 后按与 `type`/`enabled` 相同规则触发 **`persistentGsplatEffectRemountRequested`**（reveal 独占播放中则 **`revealComplete` 后**再 remount）。

### 3.3 `perlin-wave`：`effectParams` 白名单与默认值

白名单与写入逻辑：**`src/vfx/effects-runtime/persistent/persistent-effect-params.ts`**（**`applyPersistentEffectParamsToScript`**）。在 **`createPerlinWaveRevealScript`** 中于默认赋值与 **`updateScriptCenter`** 之后应用专参。

| `effectParams` 键 | 脚本属性 | 默认（`createPerlinWaveRevealScript` 内，先于专参补丁） | 类上 `@range`（见 `gsplat-perlin-wave.ts`） |
|-------------------|----------|-------------------|------|
| `intensity` | `intensity` | `0.8`（类默认 `0.5`） | `[0, 1]` |
| `waveAmplitude` | `waveAmplitude` | `0.2`（类 `0.1`） | `[0, 2]` |
| `waveFrequency` | `waveFrequency` | 类默认 `1.0`（create 未改） | `[0, 10]` |
| `wavelength` | `wavelength` | `2.5`（类 `0`） | `[0, 100]`；`>0` 时优先于 `waveFrequency` |
| `waveSpeed` | `waveSpeed` | `0.5`（类 `1.0`） | `[0, 5]` |
| `scaleBlend` | `scaleBlend` | `0.75`（类 `0`） | `[0, 1]` |
| `center` | `center`（`Vec3`） | 由 **`updateScriptCenter`** 写入 | JSON **`[x,y,z]`**；`effectParams` 可覆盖 |

**`center` 与相机**：宿主可经 `effectParams.center` 固定原点；未提供时仍以 **`updateScriptCenter`** 为准。

---

## 4. `settings.effects` 结构速查（与协议对齐）

```text
settings.effects.reveal.activeEffectId        → 固定 'scene.gsplat-reveal'
settings.effects.reveal.paramsById['scene.gsplat-reveal']
  → { type, autoStart, totalDuration, effectParams? }

settings.effects.persistent.activeEffectId   → 固定 'scene.gsplat-persistent'
settings.effects.persistent.enabled          → boolean
settings.effects.persistent.paramsById['scene.gsplat-persistent']
  → { type, autoStart, effectParams? }（**无** totalDuration）
```

导出快照会剔除 legacy `revealEffect` 键，以 **`effects` 为 scene reveal 真源**（见 `effects-sync.ts` 注释）。

---

## 5. 与第三期 `VFX_*` 的关系

第四期对外推荐 **`EFFECT_*`**。第三期 **`VFX_TYPE_SET` / `VFX_RESTART` / `VFX_EXIT`** 若仍被旧宿主使用，需对照 **`CommandRegistry` → `EffectsFacade`** 的当前实现与第四期文档；**本表以 `EFFECT_PARAMS_PATCH` 的 reveal：`type` / `totalDuration` / `autoStart` / `effectParams`，persistent：`type` / `autoStart` / `effectParams`（**无** `totalDuration`）+ persistent 顶层 **`enabled`**（`EFFECT_TOGGLE`）为权威外部参数面**。

---

## 6. 后续扩展（产品 / 协议）

若需扩展宿主可调面，典型增量为：

1. 在 **`reveal-effect-params.ts`** / **`persistent-effect-params.ts`** 扩展白名单，并保证 **`create*Script`** 默认值与 **`apply*EffectParamsToScript`** 顺序一致；
2. 或在 `paramsById` 下引入 **`perTypeParams`** 等结构化字段，并在 remount 时读回；
3. 同步更新 **`docs/SaaS第四期编辑模式接口文档.md`** 与本参考表。

---

**文档版本**：与仓库实现同步整理；若代码变更，请以 `effects-protocol-adapter.ts`、`effects-sync.ts`、`reveal-controller.ts`、`reveal-effect-params.ts`、`persistent-effect-params.ts` 为准更新本文。
