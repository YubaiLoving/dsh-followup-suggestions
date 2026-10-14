[English](README.md) · **中文**

# 后续推荐（Follow-up Suggestions）

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.1.7--rc.2-4D6BFE)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个 DSH 插件：会话**最后一条已完成回复的正下方**显示 1-3 条推荐文本气泡，文字由**该会话当前所选模型**生成；点一下就填进输入框并**把光标交回输入框**，可以直接接着打字，绝不误发。标签后面还有一个小小的刷新图标，点它换一批推荐。

本仓库带有 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 标签（topic）—— 这是 DeepSeek Harness 文档对插件仓库的要求，让插件能被搜索到；README 里也保留了一处指向该标签页的可点击链接。

```
助手：飞夺泸定桥是 1935 年 5 月的一次战斗……
[复制] [分支] …
为你推荐 ⟳
┌──────────────────────────┐ ┌────────────────────┐
│ 详细讲讲当时的作战部署    │ │ 这段历史有哪些争议  │
└──────────────────────────┘ └────────────────────┘
```

## 它做什么

- **生成**：Host 半侧读该 Session 已记录的请求头（`session.requestHeader().config`），拿到你在 `/model` 或输入框模型菜单里选定的 `provider/model`，用它跑一次**一次性**的 `ctx.llm.stream()` 调用，产出 1-3 行短指令。
- **显示**：Client 半侧注册进 ui-chat 的 `conversation.chat.turnTail` 插槽，并用 `order:1` 排到复制/分支行动条的**下面**。
- **只显示在最后一条**：只有 Turn 记录 `status === "closed"` **且**它是 `timeline.turnOrder` 的最后一项时才显示。历史消息不再请求、不再显示。
- **点击 = 填入输入框并进入输入状态**：先通过 ui-conversation 的 `inputActions.setDraft()` 写入草稿，再把焦点交给输入框的 contenteditable，并把光标放到文本末尾 —— 点完就能直接接着打字。不会误发。
- **刷新 = 换一批**：标签后面的刷新图标会为当前 Turn 重新问一次 Host，**故意绕过两层缓存**，用新结果替换屏幕上的气泡和该 Turn 的缓存。刷新失败或返回为空则什么都不改，屏幕上的气泡原样保留；请求进行中图标旋转，按钮置灰。
- **带缓存**：一个已完成 Turn 默认只花一次模型调用。Host 记住已算出的答案、并共享正在进行的调用；浏览器再把答案按 Turn 存进 `localStorage`，所以刷新页面、切走再切回、另开一个标签页都是**直接显示、不再请求** —— 直到你点一次刷新。
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

关于这条有两点要说。其一，包内自带 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 声明），profile 走 bundle 机制时它已经会自动插入同样的一条，**不要**再加第二条。其二，上面这条插入行就够 Host/Client 两半加载了；另外再加一条同 id、不带 `insert` 的**顶层覆盖行**，作用只是让插件可被定位（因而能在插件页里开关）：

```yaml
- id: followup-suggestions
  name: 'dsh-followup-suggestions'
```

保存后 DSH 会重新应用 patch 层：**浏览器半侧刷新页面即可**，**Host 半侧改代码需要重启 DSH**（已加载的模块在进程内被缓存）。但条目上的 `config` 改动会**即时重载**插件（实测：把 `maxItems` 改成 1，下一次请求就只返回 1 条）。刷新按钮不受这条限制：它同时也带一个 cache-missing 的合成 seq，所以哪怕 Host 还是旧版（没重启、不认识 `refresh` 标志），点刷新一样会真的重新生成。

## 安装排错

"气泡突然没了"几乎都是下面三种环境问题之一。它们都不是插件的 bug；而且**任何一个都会让整次 `pnpm install` 中止** —— 所以症状表现为插件悄无声息地不再出现，而不是界面上弹出报错。

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_PNPM_FETCH_403`（`GET https://www.npmjs.com/package/<包名>`） | pnpm 11 会按供应链策略逐个复核 lockfile 条目，并去抓该包的 npm **网站**页面；这个请求可能被 403 拒绝，而 `registry.npmjs.org` 仍然返回 200 —— 属于代理或站点风控，与被装的包无关 | 跳过这一步重跑安装：`pnpm install --trust-lockfile`（实测：把一次硬失败变成数秒内成功） |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 同一 profile 里另一个依赖来自 git，需要执行构建脚本但不在白名单 | 按报错里给出的键，把该包加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`（形如 `'<包名>@<解析后的地址>': true`） |
| 改了本插件源码，运行中的 DSH 行为却没变 | `file:` 依赖是被**复制**进 profile 而不是软链，安装那一刻的源码就被固定下来了 | 每次改完源码都要在 profile 目录重跑一次安装；若改的是 Host 半侧，还要再重启 DSH |

安装中止**不会**拆掉原先能用的包，但这次要新增或要重链的那个包不会落地，所以插件可能在两次重启之间"消失"。排查前先确认实际装的是什么：

```
# Windows 路径示例，其他系统自行替换
node -p "require('C:/Users/<你>/.dsh/profiles/desktop/node_modules/dsh-followup-suggestions/package.json').version"
```

再确认名册里还留着它：`~/.dsh/profiles/desktop/cordis.patch.yml` 里该 id 必须同时出现在 `insert` 列表和顶层覆盖行中。

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
| Host 缓存 | 已结算答案 Map（上限 256 条 / 24 小时）+ 进行中 Promise Map（同一 key 的并发请求共用一次模型调用）。空结果与失败不写入。带 `refresh: true` 的请求跳过这两个捷径，重新调用模型，并用新结果覆盖它拿到的那个 key |
| 浏览器缓存 | 页面内存 Map → `localStorage: dsh.followupSuggestions.v1`（上限 40 条 / 7 天）。首个渲染就用惰性初始化读缓存，刷新后与回复同帧出现。只有刷新会改写条目 |
| 点击后聚焦 | `inputActions` 没有暴露 focus（只有 `setDraft`/`insertText`/`submit`/附件），所以直接按 `[data-conversation-content][data-conversation-session="…"] [data-composer-input]` 找输入框并聚焦，再显式把光标放到末尾 —— 裸 DOM focus 会落在开头，因为 ui-conversation 是通过 Lexical 自己的 `focus()` 恢复光标的。这两个属性属于 ui-conversation：改名后查找失效，点击就只填草稿 |
| 刷新传输 | 刷新请求同时带 `refresh: true` 与一个**合成的收官 seq**（`seq + REFRESH_SEQ_STEP × n`）。新版 Host 读标志位；而标志位之前就已加载的 Host 会忽略它，此时正是这个合成 seq 让它的已结算 key 落空 —— 不用重启也能刷新 |
| 样式表 | 每个 document 注入一次，并且在**本构建的规则与页面里已有的 tag 不一致时重写它**。插件重载（HMR 或重新挂载）不会重载 document，没有这个比较的话，改过的尺寸或间距要硬刷新才会出现在页面上 |
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
- **落在 ui-conversation 的 `inputActions` 与输入框 DOM 上**：seat 缺失时气泡仍会显示，但点击无效；`data-conversation-content` / `data-conversation-session` / `data-composer-input` 若改名，点击仍会填草稿，但不再把键盘交回输入框。
- **缓存保留 7 天**：同一 Turn 的推荐在此期间默认不变，点刷新图标即可换一批（手动清掉 `localStorage` 里的 `dsh.followupSuggestions.v1` 效果相同）。
- **一次刷新 = 一次模型调用**：这是设计如此，它是唯一绕过两层缓存的动作。
- **Host 缓存是进程内存**：不落盘，随进程重启清空。
- **Host 半侧改代码要重启 DSH**：进程内模块被缓存（entry 的 `config` 改动除外，那是即时生效的；刷新按钮按构造就会让旧 Host 的缓存 key 落空，所以刷新生效不依赖重启）。
- **不参与会话记录**：推荐内容只存在于浏览器 `localStorage` 与 Host 内存，从不写入 Session 日志，也不出现在会话导出里。

## 自测

```
node test/smoke.mjs
```

不依赖 DSH 运行时：用 stub 模块加载器驱动 `lib/index.js`（真 `Request`/`Response` + stub `ctx.llm`），并用一个最小 hook 运行时挂载 `lib/client.js` 注册的组件。覆盖 99 项断言：路由注册与路径、模型路由取自会话请求头、标号/引号清洗、超长行丢弃、条数上限、失败/无路由/未知会话为空、实时 Turn 不渲染不请求、历史 Turn 不渲染、末条 Turn 先出占位再出气泡、点击只填草稿并聚焦输入框且光标落在末尾、Host 失败静默、seat 缺失不崩、注入的样式表在规则变化时被重写而内容相同时保持不动；提示与预算覆盖默认最低思考等级、`null` 继承、路由不支持时无 effort 重试且只重试一次、上下文长度上限；缓存覆盖重复请求命中 Host 缓存、并发同 key 只调一次模型、seq 变化即失效、失败不入缓存、Host 的 `refresh` 标志绕过已结算答案并覆盖它（非布尔值不算刷新）、单个合成 seq 在没有该标志的 Host 上同样落空且不动真实 key，以及浏览器侧的持久命中/写回/重挂载不请求/换 seq 重新请求/空结果不被缓存、刷新按钮在标签行内、它的禁用与旋转状态、它只发一次带标志与 cache-missing seq 的请求、它替换两层缓存里的一整批结果，以及刷新为空或失败时屏幕气泡与缓存条目都不动。

## 许可

[MIT](LICENSE) © 2026 YubaiLoving
