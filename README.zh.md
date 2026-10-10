[English](README.md) · **中文**

# 后续推荐（Follow-up Suggestions）

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.1.7--rc.2-4D6BFE)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个 DSH 插件：会话**最后一条已完成回复的正下方**显示 1-3 条推荐文本气泡，文字由**该会话当前所选模型**生成；点一下就填进输入框，不改一个字的会话历史。

本仓库带有 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 标签（topic）—— 这是 DeepSeek Harness 文档对插件仓库的要求，让插件能被搜索到；README 里也保留了一处指向该标签页的可点击链接。

```
助手：飞夺泸定桥是 1935 年 5 月的一次战斗……
[复制] [分支] …
为你推荐
┌──────────────────────────┐ ┌────────────────────┐
│ 详细讲讲当时的作战部署    │ │ 这段历史有哪些争议  │
└──────────────────────────┘ └────────────────────┘
```

## 它做什么

- **生成**：Host 半侧读该 Session 已记录的请求头（`session.requestHeader().config`），拿到你在 `/model` 或输入框模型菜单里选定的 `provider/model`，用它跑一次**一次性**的 `ctx.llm.stream()` 调用，产出 1-3 行短指令。
- **显示**：Client 半侧注册进 ui-chat 的 `conversation.chat.turnTail` 插槽，并用 `order:1` 排到复制/分支行动条的**下面**。
- **只显示在最后一条**：只有 Turn 记录 `status === "closed"` **且**它是 `timeline.turnOrder` 的最后一项时才显示。历史消息不再请求、不再显示。
- **点击 = 填入输入框**：通过 ui-conversation 的 `inputActions.setDraft()` 写入草稿，你自己改完再按回车。不会误发。
- **带缓存**：一个已完成 Turn 只花一次模型调用。Host 记住已算出的答案、并共享正在进行的调用；浏览器再把答案按 Turn 存进 `localStorage`，所以刷新页面、切走再切回、另开一个标签页都是**直接显示、不再请求**，同一 Turn 的推荐也保持稳定。
- **失败即静默**：Session 已不存在、没有记录过请求头、模型报错、网络断了、返回空 —— 一律渲染为空，transcript 不受任何影响；空结果与失败**不入缓存**，下次访问会重试。
- **零会话污染**：生成调用不写入 Session 日志，不进入模型历史，不影响 KV cache。

## 安装

**方式一：插件管理器**

```
plugin_manager install_bundle target="github:YubaiLoving/dsh-followup-suggestions"
```

**方式二：手动**

包目录出现在 profile 的 `node_modules` 下，并在 `cordis.patch.yml` 末尾加一条 Loader 条目（本插件 Host/Client 两半由**同一条**目录挂载）：

```
~/.dsh/profiles/desktop/node_modules/dsh-followup-suggestions/
```

```yaml
- insert:
    - id: followup-suggestions
      name: 'dsh-followup-suggestions'
```

保存后 DSH 会重新应用 patch 层：**浏览器半侧刷新页面即可**，**Host 半侧改代码需要重启 DSH**（已加载的模块在进程内被缓存）。但条目上的 `config` 改动会**即时重载**插件（实测：把 `maxItems` 改成 1，下一次请求就只返回 1 条）。

## 配置（可选）

`cordis.patch.yml` 的条目上可以加 `config`：

```yaml
- id: followup-suggestions
  name: 'dsh-followup-suggestions'
  config:
    maxItems: 3           # 1-3，超出被夹到 3
    maxTokens: 320        # 输出上限（不是目标，用不到不花钱）
    timeoutMs: 30000      # 单次调用超时
    maxContextChars: 1200 # 每条上下文保留的字符数
    reasoningEffort: off  # 最低思考等级；null / inherit 表示继承会话路由默认值
```

全部可省略。`config` 改动即时生效（会重载插件，不需要重启）。

## 实现要点

| 项目 | 说明 |
| --- | --- |
| 会话选择权 | 模型路由完全来自 Session 自己的请求头，本插件**没有**自己的模型配置项，所以 `/model` 一改，推荐跟着改 |
| 上下文 | `session.deriveMessages()` 里最后一条 user 文本 + 最后一条 assistant 文本，各截尾至 1200 字符 |
| 调用 | `ctx.llm.stream({ provider, model, maxTokens, reasoningEffort, sessionId, messages, signal })`，`AbortSignal.timeout` 兜底；`BlockAssembler` 收流 |
| 传输 | Host 用 `ctx.connection.fetch.register()` 挂 `POST /api/dsh-followup-suggest`，Client 用同源 `fetch` |
| 渲染位置 | `ctx.slots.inject("conversation.chat.turnTail", …)`；座位 outlet 外层是 `display:contents`，所以本行与行动条同级，`order:1` 即排在它下面（若容器不再是 flex 列则该声明被忽略，退回行动条上方） |
| 思考等级 | 默认请求最低等级并用 `maxTokens` 做上限；路由不认识该等级时返回 `UNSUPPORTED_REASONING_EFFORT`，此时去掉该字段重试一次，并记住该路由不再重试 |
| 判定"最后一条" | Turn 座位没有"是不是最新"的 prop，故取标准 seat `useChat()` 读 `timeline.turnOrder`；该 seat 缺失时退化为不显示 |
| 缓存键 | `Session + Turn + closing final node seq`。用收官节点的 seq 让条目**自我失效**：重试、分支、下一轮都会让 seq 变化 |
| Host 缓存 | 已结算答案 Map（上限 256 条 / 24 小时）+ 进行中 Promise Map（同一 key 的并发请求共用一次模型调用）。空结果与失败不写入 |
| 浏览器缓存 | 页面内存 Map → `localStorage: dsh.followupSuggestions.v1`（上限 40 条 / 7 天）。首个渲染就用惰性初始化读缓存，刷新后与回复同帧出现 |
| 依赖 | Host：`@deepseek-ai/dsh-llm`；Client：仅 `react` |

## 性能

开销有两块：**模型调用**（唯一的大头）与**渲染**。实测（本机、真实会话、真模型）：

| 场景 | 优化前 | 优化后 |
| --- | --- | --- |
| 同一 Turn 重复请求（Host 命中缓存） | ~1.5–2.4s 且结果不稳定 | **~5ms**，结果一致 |
| 刷新页面 / 切走再切回同一 Turn | 每次一次模型调用 | **0 次调用**（与回复同帧出现） |
| 首次加载（必须调用） | 空白 ~2s 后突然出现 | 立即显示 3 个**占位胶囊**，返回后替换 |
| 两个标签页同一瞬间各请求一次 | 2 次模型调用 | **1 次**（进行中 Promise 共用） |

关于最低思考等级：ABAB 交错实测（同进程切 config，各 10 次真实调用）显示**延迟无可测差异**（中位 1413ms 继承 vs 1495ms off，落在噪声内 —— 延迟主要由厂商首字时间决定）。保留它是因为可靠性：输出很短，若继承高思考等级，思考会先吃掉输出预算，`maxTokens` 小时会截断成不足 3 条（inherit 组 10 次里 4 次不足；off 组 10/10 均 3 条）。首次调用的延迟本身没有改善，本插件优化的是**重复开销**与**感知延迟**。

## 已知限制

- **只对"当前查看的会话"的末条回复生效**：刻意的（省调用、免打扰），不是按会话预生成。
- **判定依赖两个契约**：Turn 记录带 `status`/`turn`，以及 `useChat().timeline.turnOrder`；ui-chat 若改这两个字段需要同步调整 `lib/client.js`。
- **落在 ui-conversation 的 `inputActions` 上**：该 seat 缺失时气泡仍会显示，但点击无效。
- **缓存保留 7 天**：同一 Turn 的推荐在此期间固定不变；想看新的一批就清掉 `localStorage` 里的 `dsh.followupSuggestions.v1`。
- **Host 缓存是进程内存**：不落盘，随进程重启清空。
- **Host 半侧改代码要重启 DSH**：进程内模块被缓存（entry 的 `config` 改动除外，那是即时生效的）。
- **不参与会话记录**：推荐内容只存在于浏览器 `localStorage` 与 Host 内存，从不写入 Session 日志，也不出现在会话导出里。

## 自测

```
node test/smoke.mjs
```

不依赖 DSH 运行时：用 stub 模块加载器驱动 `lib/index.js`（真 `Request`/`Response` + stub `ctx.llm`），并用一个最小 hook 运行时挂载 `lib/client.js` 注册的组件。覆盖 69 项断言：路由注册与路径、模型路由取自会话请求头、标号/引号清洗、超长行丢弃、条数上限、失败/无路由/未知会话为空、实时 Turn 不渲染不请求、历史 Turn 不渲染、末条 Turn 先出占位再出气泡、点击只填草稿不发送、Host 失败静默、seat 缺失不崩；提示与预算覆盖默认最低思考等级、`null` 继承、路由不支持时无 effort 重试且只重试一次、上下文长度上限；缓存覆盖重复请求命中 Host 缓存、并发同 key 只调一次模型、seq 变化即失效、失败不入缓存，以及浏览器侧的持久命中/写回/重挂载不请求/换 seq 重新请求/空结果不被缓存。

## 许可

[MIT](LICENSE) © 2026 YubaiLoving
