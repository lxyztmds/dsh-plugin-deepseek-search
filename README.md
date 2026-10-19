# dsh-plugin-deepseek-search

把 **DeepSeek 官方 Search / Fetch API** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。安装后模型获得两个工具：

| 工具 | 底层接口 | 作用 |
| --- | --- | --- |
| `deepseek_search` | `POST https://api.deepseek.com/v1/tools/search` | 用 DeepSeek 自研搜索引擎检索网页，返回标题、URL、摘要、发布时间、权威性、排序分；可选返回网页正文 |
| `deepseek_fetch` | `POST https://api.deepseek.com/v1/tools/fetch` | 抓取单个网页，返回标题与 Markdown 正文 |

接口文档：<https://api-docs.deepseek.com/zh-cn/guides/search/>

- 插件只读、无缓存、无遥测；不会写入工作区。
- 与 DSH 内置的 `web_search` / `web_fetch` **互不冲突**：本插件注册独立工具名，不接管 `ctx.web` 的 provider 选择，也不改动内置设置。
- 鉴权默认使用 DSH 凭据服务里的凭据引用（默认 `DEEPSEEK_API_KEY`），每次调用实时解析，换 Key 不需要重启；显式配置 `apiKey` 字面值时会优先使用它。

## 目录结构

```text
dsh-plugin-deepseek-search/
├── package.json          # 包清单：dsh.bundle.patch 声明 + peerDependencies
├── cordis.patch.yml      # bundle patch 层：插入插件行 deepseek-search
├── lib/
│   ├── index.js          # 插件入口：Config schema、apply、两个 defineTool 定义
│   ├── client.js         # Search/Fetch HTTP 客户端：鉴权、超时、重试、错误映射、响应校验
│   └── format.js         # 模型侧渲染 + Web 结果卡片（presentationMeta / presentResult）
├── locale/{zh,en}.json   # 插件列表里的标题与描述
├── scripts/
│   └── install-bundle-entry.mjs  # 手工安装辅助：安全地把 bundle 名写进 profile 清单
├── test/
│   ├── client.test.mjs   # 单元测试：请求/重试/错误/校验（25 个用例）
│   ├── format.test.mjs   # 单元测试：渲染、截断、presentation（15 个用例）
│   └── live-smoke.mjs    # 真实 API 冒烟测试（需要 Key）
├── icon.svg
└── LICENSE
```

## 安装

DSH 的插件是 profile 的一个 *bundle*：profile 的 `package.json` 的 `dsh.profile.bundles` 引入它，它的 `cordis.patch.yml` 把插件行插进加载树。

最省事的方式：装好后在 **插件 → 发现** 里搜索本插件，或在命令行执行（非 `desktop` profile）：

```powershell
# GitHub 源码安装
dsh plugin --profile <profile-name> add github:lxyztmds/dsh-plugin-deepseek-search

# npm 安装（发布 npm 后可用；预构建、免 allowBuilds 授权）
dsh plugin --profile <profile-name> add dsh-plugin-deepseek-search
```

下面是本地/手工安装的三种方式。

### 方式一：图形界面安装（即时生效，推荐）

1. 打开 DSH 侧边栏的 **插件** 页；
2. 在安装输入框填入本插件目录的绝对路径，例如
   `C:\Users\Administrator\Desktop\开发相关\dsh-plugin-deepseek-search`；
3. 安装完成后插件默认启用。DSH 运行在 HMR 模式下，本插件属于纯 Host 端插件，安装/启用后立即出现在后续会话的工具列表里。

### 方式二：命令行安装（适用于非 Electron 托管的 profile）

```powershell
dsh plugin --profile <profile-name> add "file:C:\path\to\dsh-plugin-deepseek-search"
# 然后重启该 profile
```

`desktop` 这个 profile 名被 Electron 独占：独立 `dsh` CLI 会拒绝，请用方式一或方式三；Desktop 自带的 `dsh` 命令可管理该 profile（例如 `dsh plugin --profile desktop why <pkg>`），但跨版本行为不一致，手工路径最稳。

### 方式三：手工安装（当前 Desktop profile 已按此方式装好）

```powershell
# 1) 拷一份到 ASCII 路径（避免中文路径在 pnpm/命令行链路上被错误转码）
robocopy "<插件源码目录>" "C:\Users\Administrator\.dsh\plugins-local\dsh-plugin-deepseek-search" /E /XD node_modules .git

# 2) 在 profile 目录安装依赖
pnpm --dir "C:\Users\Administrator\.dsh\profiles\desktop" add "file:C:\Users\Administrator\.dsh\plugins-local\dsh-plugin-deepseek-search"

# 3) 把 bundle 名追加进 dsh.profile.bundles（node 脚本，避免手工改 JSON 出错）
node "<插件目录>\scripts\install-bundle-entry.mjs" "C:\Users\Administrator\.dsh\profiles\desktop\package.json"
```

1、2 步也可用一条 `dsh plugin --profile <name> add <path>` 交给 CLI（仅限非 Electron 托管的 profile；独立 CLI 会拒绝 `desktop`），CLI 成功后第 3 步的 bundles 追加会自动完成。

手工改过 profile 后一般需要**重启 DSH Desktop** 才会生效；若该 DSH 版本运行在 HMR 模式，运行时也可能检测到 profile 变化并热加载（本机安装时即自动生效）。

## 配置

配置项定义在 `lib/index.js` 的 `Config`（schemastery schema），默认值由 schema 提供（bundle patch 只显式写了 `apiKeyEnv`），可在 profile 的 `cordis.patch.yml` 用 id 定向覆盖：

```yaml
- id: deepseek-search
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    count: 5
    needContent: false
    timeoutMs: 60000
    retries: 2
    maxOutputChars: 60000
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKey` | 空 | 直接写入的 API Key（secret role；不推荐，优先用凭据引用） |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用名，按调用经 `ctx.credentials` 解析；没有凭据服务时回退到启动进程的环境变量 |
| `baseURL` | `https://api.deepseek.com/v1/tools` | Search/Fetch API 基础地址（含 `/v1/tools`，不含 `/search`、`/fetch`）；必须是带 host 的 http(s) URL，且不能包含用户名/密码，非 https 会明文传输 Key |
| `count` | `10` | `deepseek_search` 未显式传 `count` 时的默认条数（1–50） |
| `needContent` | `false` | `deepseek_search` 未显式传 `need_content` 时的默认值 |
| `timeoutMs` | `60000` | 一次工具调用的总预算（含重试退避），到点返回 `TIMEOUT` |
| `retries` | `2` | 遇到 408 / 429 / 5xx / 网络错误时的重试次数（0–5），429 会优先遵守 `Retry-After` |
| `maxOutputChars` | `60000` | 单次调用返回给模型的最大字符数；超出会截断并注明 |
| `sendOriginalQuestion` | `true` | 把触发本轮的用户问题（折叠空白、截断 128 字符）作为 `ori_question` 发送 |

### Key 从哪里来

1. `apiKey` 字面值（若配置）；
2. `ctx.credentials.resolve(apiKeyEnv)`：Desktop/Web 的凭据服务会读 `~/.dsh/.credentials.yaml` 的 `refs:`，或 Web **模型**页保存的 Key；
3. 启动进程环境变量 `process.env[apiKeyEnv]`（例如 `dsh` 前 `set DEEPSEEK_API_KEY=sk-...`）。

三处都没有时，工具仍会显示在工具列表里，执行时返回带修复指引的 `MISSING_CREDENTIAL` 错误。

## 工具参数

### `deepseek_search`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 1–128 个 Unicode 字符，不能全为空白；支持搜索语法（见下） |
| `count` | integer | 否 | 1–50，缺省用部署配置；越界会返回参数错误 |
| `need_content` | boolean | 否 | 是否同时返回网页正文（更大、更慢） |

`query` 支持的搜索语法（原样传给搜索服务）：

| 操作符 | 示例 |
| --- | --- |
| `site:` | `DeepSeek site:github.com OR site:huggingface.co` |
| `-site:` | `DeepSeek -site:example.com` |
| `-` / `-"..."` | `DeepSeek -广告`、`DeepSeek -"release notes"` |
| `"..."` | `DeepSeek "精确短语"` |
| `lang:` | `DeepSeek lang:zh,en` |
| `after:` / `before:` | `DeepSeek after:2025-01-01 before:2026-06-01` |

结果包含 `title`、`url`、`snippet`、`summary`、`date`、`authority`（0–4，-1 未知）、`rerankScore`（0–3，≥1.5 为优质），`need_content` 时还有 `content`。

### `deepseek_fetch`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 绝对 http(s) URL，≤8192 字符，必须带 host，不能携带用户名/密码 |

返回 `{ url, title, content }`：`title` 被限制在 300 字符（防止畸形 `<title>` 冲爆输出），`content` 为 Markdown 正文，插件对单页保留上限为 200,000 字符（`MAX_FETCH_CONTENT_CHARS`），超出会截断并标注。

## 错误与重试

插件把文档里的状态码映射成模型可执行的错误文本，并附带 endpoint 与排查建议：

| 状态码 | 行为 |
| --- | --- |
| 400 | 不重试，提示 query/count/JSON 约束 |
| 401 | 不重试，提示配置 Key 的三种途径 |
| 402 | 不重试，提示充值 |
| 403 / 404 | 不重试（Fetch 被安全策略拒绝 / 页面无可提取正文） |
| 408 / 429 | 按 `Retry-After` 或指数退避重试，超过次数后报错 |
| 413 | 不重试，提示请求体超过 API 大小限制 |
| 任意 5xx（500/502/503/504/501/505…） | 按 `Retry-After` 或指数退避重试，超过次数后报错；502/503 有专门的排障提示 |
| 网络失败 | 重试后报错，提示检查网络与 `baseURL` |

本地错误码会以 `[CODE] ` 前缀出现在错误文本里，便于模型和日志路由：`MISSING_CREDENTIAL`（未配置 Key）、`ABORTED`（用户取消）、`TIMEOUT`（总预算耗尽）、`INVALID_RESPONSE`（返回体不符合文档结构）、`INVALID_BASE_URL`（baseURL 不合法）。

Search 与 Fetch 都是只读请求，重试安全。

## 计费与限速

按 DeepSeek 文档：

- Search / Fetch 均按**成功请求次数**计费，5 元 / 1000 次；失败、无结果不计费；`count` 不影响单次价格。
- 每个账号 Search、Fetch 各自独立限速 **5 QPS**，超限返回 429。
- 在 DeepSeek Harness / Claude Code / Codex 中通过服务端工具调用访问 Search/Fetch 目前不计费，自 **2026-11-01 00:00（北京时间）** 起按次收费。

本插件是显式工具调用，属于按次计费路径，请按需控制 `count` 与调用频率。

## 安全与隐私

- 插件只把 `Authorization: Bearer <key>` 发给配置的 `baseURL`；Key 不写入消息、日志或模型上下文，上游错误体里若回显了 Key 会被替换为 `[redacted]`。
- `baseURL` 必须是有 host 的 http(s) URL，且拒绝携带用户名/密码的 URL；非 https 地址会明文发送 Key，只应指向信任的本地网关。
- `query`、`url` 会发给 DeepSeek API；`sendOriginalQuestion` 开启时还会发送本轮用户问题的前 128 字符，关闭它即可不发送。
- 页面正文属于外部不可信内容，工具结果带有 "external, untrusted data" 提示；插件不做 HTML 渲染，不执行页面内容。
- 所有 provider 可控字符串（标题、摘要、正文、URL）在渲染与持久化元数据前都有字符上限，畸形页面无法撑爆输出；标题里的 `[`/`]` 会被转义，避免伪造 Markdown 链接。
- 跟随重定向被禁用（`redirect: 'error'`），避免凭据被带到别的地址。

## 开发

```powershell
# 单元测试（不联网；40 个用例：25 client + 15 format）
node --test test/client.test.mjs test/format.test.mjs

# 真实 API 冒烟测试（读取 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml）
node test/live-smoke.mjs
```

实现要点：

- `lib/client.js` 不依赖 DSH 运行时，可独立测试；`createDeepSeekApi` 通过 `fetchImpl` / `sleep(ms, signal, operation)` 注入网络与时钟。
- 一次调用的所有重试与退避共享 `timeoutMs` 总预算（`AbortSignal.timeout`），等待期间也会响应取消/超时；取消使用调用方 `exec.signal`，两者用 `AbortSignal.any` 合并。
- `deepseek_search` / `deepseek_fetch` 都声明了 `isConcurrencySafe: () => true`（只读，可并行），并声明 `timeoutMs` 供 DSH 的超时策略做兜底。
- 输出先经过 canonical JSON schema 校验，再渲染成模型文本；渲染有总字符预算，超限注明 "Showing the first N of M"；Fetch 的页眉/标题也计入预算，`presentResult` 的 `truncated` 与渲染文本共用同一次计算。
- `presentationMeta` 把结构化来源/抓取摘要持久化（字段亦有长度上限），`presentResult` 让 Web 客户端渲染成 `web` 结果卡片，且对错误结果返回 `undefined`。
- 本地错误码（`MISSING_CREDENTIAL`/`TIMEOUT`/…）会以 `[CODE] ` 前缀进入错误文本，模型和日志可以直接路由。

## 卸载 / 回退

- 图形界面：插件页停用或删除本插件。
- 手工：从 profile 的 `dsh.profile.bundles` 删掉 `dsh-plugin-deepseek-search`，再 `pnpm --dir <profile> remove dsh-plugin-deepseek-search`，重启。

## License

MIT
