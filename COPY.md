# CLIProxyAPI 对齐与跟进（COPY）

> 本文档记录 CFlareAIProxy 与 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的行为对齐程度、明确差异和后续同步规则。
>
> `COPY` 表示“参考、比较并按本项目架构移植”，不表示逐文件复制。CFlareAIProxy 运行在 Cloudflare Workers 上，必须优先遵守 Workers、D1、Durable Objects、KV、Queue 和原生 Socket 的约束。

<!-- upstream-repository: router-for-me/CLIProxyAPI -->
<!-- upstream-ref: ac02da6c05e18f465aa7e3ed5b0a65a2f060917d -->
<!-- local-implementation-ref: 67029a02e4aeabfdc73c11430e08bdc2373bd1b1 -->
<!-- last-reviewed: 2026-09-13 -->

## 1. 当前基线

| 项目 | 基线 |
| --- | --- |
| 上游仓库 | `router-for-me/CLIProxyAPI` |
| 上游分支 | `main` |
| 已审阅上游提交 | `ac02da6c05e18f465aa7e3ed5b0a65a2f060917d` |
| 本地分支 | `dev` |
| 本地实现基线 | `67029a02e4aeabfdc73c11430e08bdc2373bd1b1` |
| 审阅日期 | 2026-09-13 |

本轮累计审阅范围为 `41fc5e13..ac02da6c`：

- 已在 PR #124 / merge `14bd81b4` 中同步可安全适配 Workers 的 HTTP 行为：request-scoped custom headers、空 Codex credential 认证头清理、Codex `Session-Id`/会话 header 透传、prompt-cache 字段清理、collision-safe Responses input IDs、Kimi reasoning/incomplete/partial tool-call 语义、Responses tool-output 文本/图片规范化、Responses usage detail normalization、401 request-scoped `invalid_request_error` 不冷却 credential、Codex client catalog 新字段与 max completion token、以及严格的 OpenAI-compatible Responses SSE EOF/error 处理。
- PR #124 的 GitHub Actions 已通过 worker/web typecheck、完整测试、production web build 和 Wrangler dry-run；Cloudflare Workers build 也成功。`dev` 后续 PR #129 / merge `090183c8` 已补齐 HTTP 402 后 credential cooldown/rebind 行为。
- `17a65ee5..2a6b87ac` 的范围内实质变化已逐提交、逐文件分类：OAuth access-token 过期/refresh failure 可用性（#131）、usage/token safe-integer 边界（#132）、model-scoped quota cooldown（#133）、Codex orphan delegation compatibility（#134）；429 retry-round/10 秒 cooldown floor 继续归入 #94，LCP fork/subagent/session hierarchy 继续归入 #117。旧 Codex client reasoning-level 清理在本地 builder 已有等价行为；Kimi thinking helper 仅为重构，无新增 wire behavior。
- `2a6b87ac..5208aec7` 的范围内变化继续逐提交分类：OpenAI-compatible 429/TPM bounded wait（#136）、OAuth/auth refresh three-way merge 与 registration epoch/error precedence（#113）、`gpt-6-astra` 动态 capability/default-catalog 策略（#52）继续作为架构跟进；`5208aec7` 的 Codex client catalog 空 `supported_reasoning_levels` 保留语义已在本地实现并增加现代客户端及 legacy filtering 回归测试。
- `5208aec7..c76dfd4` 的 7 个提交已逐提交、逐文件分类：`5ab0bca0` 的 Codex `usage_limit_reached` credential scope、quota reset layout 与 prevalidated candidate context 属范围内架构变化，统一跟进 #138；`31ec4362` 仅删除上游静态 `gpt-5.4/gpt-5.4-mini` 目录，本地没有对应静态条目；`084f25c7` 是本地文件 watcher 并发快照语义，Workers 无对应文件扫描生命周期；`580df364` 主要把 session/parent-session hierarchy 传播到 usage/Home/Redis 元数据队列，不改变 token normalization，session hierarchy 设计继续归入 #117；`c76dfd4` 仅更新固定 Codex UA，而本地策略明确不强制伪装官方 UA；`9dfddd61` 为 AI Studio/Gemini 专用，`7c2f6ce0` 为 Claude 专用，均排除。
- `c76dfd4..934fb792` 的 14 个提交已逐提交、逐文件分类：`1c22598d` 修复后续失败缩短既有 cooldown deadline 的问题，本地已在 AccountPool credential-wide cooldown 上使用单调 deadline，并增加并发租约回归测试；PR #140 的 GitHub Actions worker/web typecheck、完整测试、production build、Wrangler dry-run 全部通过。`fa01468e` 将非 credential-scoped result 更新收窄到 canonical request/route model scheduler shards，并缓存 supported-model set/registry epoch；本地尚无 model-scoped pool state，因此已补充 #133 的架构验收，不把该优化机械移植到 credential-wide DO。`00c63a56` 只扩展 pluginhost outbound HTTP wire profile（header casing/order、HTTP/1.1、compression 等），本地没有 pluginhost HTTP bridge，且不改变当前 core provider proxy 行为。其余提交为 Antigravity/Gemini、Grok/xAI WebSocket、Claude 或赞助/README，按范围排除。
- `934fb792..ba7e5583` 的 Codex HTTP/Responses 变化已逐提交、逐文件审阅：`d01516c1` 的 function-tool 缺省 `strict:false` 与 `bee20b99` 的 `[A-Za-z0-9_-]` tool-name sanitization/64 字符限制/碰撞安全可逆映射已在 PR #142（实现提交 `7e91167c`，merge `dd41a737`）同步，覆盖 declarations、`tool_choice` 与历史 assistant tool calls，并增加 omitted/explicit strict、非法字符传播和 sanitization collision 回归测试；PR CI 的 worker/web TypeScript typecheck、完整测试、production build、Wrangler dry-run 均通过。`bf20b999` constant-union schema normalization 与空 `response.incomplete`、`8696585c` 的 `service_tier` 和 cache-write token details、`82f4f370` Multi-Agent dotted-name 恢复、`03a054e3` 无歧义 namespace recovery、`ba7e5583` retry-advising `server_error` bootstrap failover 继续由 Issue #141 跟进，不在未验证状态下直接合入。
- `ba7e5583..7fac6b15` 的 28 个提交已逐提交、逐文件审阅：`d4146bde` 为 Kimi 新增原生 OpenAI Responses upstream 路径（stream/non-stream 直接 `/v1/responses`，不再经 Chat bridge），会改变 wire protocol、tool/reasoning/incomplete/usage/error 路径，已创建 Issue #144 进行显式 Workers 架构与兼容验证，不直接切换生产路径；`48e5e9e0` 仅为 Go 常驻 OAuth refresh loop 的最大 30 秒 sleep，Workers 无常驻 timer loop；`1d5f7b2a` 清除 Go `time.Time` monotonic clock 部分，JS/Workers `Date` 无对应状态；`39058915`、`6b187e77`、`1119ef14` 的 session hierarchy / canonical UUIDv8 继续归入 #117；`7fac6b15` 的 `$schema/$id` tool schema 清理只修改 Claude→Codex translator，按当前范围排除 Claude 协议。其余变化为 Gemini/Antigravity、Claude、plugin-store/Home/Redis、logging、赞助/文档等范围外内容。
- `7fac6b15..d1a024e9` 的 10 个提交已逐提交、逐文件审阅：`e56abd56` 与 `37ce368c` 在 Codex executor 通用 tool-schema 出站路径中清理 Python/下游不支持的 Unicode property escape `\\p{...}`/`\\P{...}`，并处理 JSON `\\u` 解码后的绕过和 `patternProperties` key；本地已按 JSON Schema 位置做无状态递归规范化，保留 `default`/`enum` 等非 schema 用户数据，并覆盖 native Responses 与 Chat/custom-tool 路径及回归测试。`b064b832` 新增可配置 model-level quota cooling，进一步确认 #133 需引入 model-scoped error/cooldown state，未直接改变 credential-wide DO。`aedc9e6a` 在所有候选凭据均发生永久认证失败后返回 non-retryable `upstream_authentication_required`，属于 selector 聚合错误语义，已补充 #100。`3bf787fc` 让 canonical session identity 同时驱动 `$CPA-SESSION-ID` dynamic header，已补充 #117，避免 affinity/header 各自解析。`d1a024e9` 新增 `gpt-image-2.5`/`-flare`/`-sunburst` built-in registry 及直接 `/images/generations`/`images/edits` 执行；本地不隐式宣传未验证 built-ins，且无对应完整 direct-image 路径，已创建 #146。`60e5b8bd` 为 auth-file 管理端显式 force-refresh endpoint/Go manager 操作，本地 D1/Workers 管理模型无 auth-file 生命周期，不机械移植；`0796d6d1` 为 pluginhost session-affinity lookup callback，本地无 pluginhost；`a59b1764` 为 Claude usage，排除；`db011593` 为 schema 修复合并提交，无额外语义。
- `d1a024e9..09a29bd` 的 8 个提交已逐提交、逐文件审阅：`25913086` 让 OpenAI Responses HTTP/SSE 错误保留嵌套 error/custom fields 与 `sequence_number`，递归脱敏敏感字段，并用无损数字解析避免大整数/token metrics 精度损失；本地官方 Codex-client framing 已部分具备嵌套 error/sequence number，但普通客户端 framing、递归脱敏及 JS safe-integer 边界仍需结合 #132/#141 统一设计，未直接扩大 wire behavior。`3ae9093d` 扩展 model-capacity 识别并在 bootstrap 未提交时触发 failover，`dde250f1` 将结构化 `model_not_found` 优先映射 404、将 model access denial 纳入 model-level cooldown/rotation 并尊重 `disable_cooling`；两者依赖本地尚未具备的 model-scoped cooldown/error scope，继续归入 #133。`638ed7e1` 修复 SSE CRLF 恰好跨 transport chunk 的边界；本地 HTTP/SSE parser 以累计 buffer 匹配完整 `\r?\n\r?\n`，已具备等价边界行为，无需代码变更。`bd03aabc` 为 Responses WebSocket 专用，`4dce5f3a` 为仅 Gemini translator，`6a73f396` 为 Claude，`09a29bd` 为赞助/README，均按规则排除。
- `09a29bd..5b278561` 的 31 个提交已逐提交、逐文件筛选：`8bd67f33` 的 Kimi K2.8/K2.8 Code/preview alias canonicalization 已在 PR #150 / `67029a02` 同步并增加 request-level 回归测试；同提交的静态 K2.8/K3 capability/`zero_allowed` 与 temperature guard 需要确认 discovered-model 和 Responses bridge 语义，跟进 #149。`5a07045e` 的 Responses `fco_` output-item ID 排除与 pending call fallback、`c8ecb4f3` 的 reasoning-before-content SSE 事件顺序继续由 #141 验证。`8f23ad02` 的 Codex alias canonical template metadata/provider capability intersection 建立 #151，并与 #133 的 canonical model state key 协同设计。`456d4c37` 的 credential-change unauthorized/model cooldown invalidation 与 `2912516c` 的 pre-mutation result policy 已补充 #133；`6dce7867` 的 Go `ForceRefreshAll` 有界 worker pool 无对应 Workers 批量常驻刷新生命周期。`9fad5055` 的 Cloudflare 520–526 transient handling 和 `Retry-After` cooldown hint 本地 `status>=500` + header/payload retry-after 分类已等价覆盖。`4edf9d1d` 仅增加 usage reporting 的 in-turn reasoning-effort metadata extraction，`c8f723e0` 主要传播 usage/plugin auth `base_url`，均不改变本地 token normalization。`5b278561` 为 plugin model-list interceptor，本地无 pluginhost model interceptor。Claude、Gemini/Antigravity、Grok/xAI、WebSocket、赞助/文档变化继续按规则排除。
- `5b278561..ac02da6c` 的 4 个提交已逐提交、逐文件审阅：`b192f655` 新增 plugin/declarative quota 查询与 reset，并在上游 quota provider/probe 明确 reset 成功后清除对应 credential 的 core routing quota state；该行为涉及 credential/model scope、reset 与并发 late release 的 epoch/version 竞态及非 quota cooldown 隔离，本地当前只有 credential-wide AccountPool 状态，已补充 #133 的精确失效与并发验收，不直接移植管理面/pluginhost 代码。`e30de3d5` 为 Antigravity capability probe cache/singleflight，`3c3938fe` 为 plugin auth provider login metadata 透传，`ac02da6c` 为赞助链接文档，均不改变当前目标范围运行时。
- 仍需架构决策或单独验证的范围继续保留 Issue：credential retry-round 与 exclusion（#94）、request-scoped error action/cooldown 与终止型聚合认证错误（#100）、candidate filtering 后 RR/SWRR 公平性（#108）、Codex quota observation snapshot（#109）、旧 Codex client reasoning-level handler 透传（#110）、HTTPS proxy 双层 TLS/ALPN（#111）、Kimi tool schema `$ref` normalization（#112）、registration epoch/error precedence 与 refresh state merge（#113）、`response.done` HTTP/SSE 终止语义（#115）、Codex `reasoning_text` Chat 转换（#116）、LCP/parent-subagent/fork session affinity 与 canonical session/header 一致性（#117）、OAuth token expiry/refresh failure（#131）、usage/token safe-integer accounting（#132）、model-scoped quota cooldown/targeted scheduler state 与显式 quota reset 精确失效（#133）、orphan delegation compatibility（#134）、OpenAI-compatible 429/TPM bounded wait（#136）、Codex usage-limit credential scope/quota reset/candidate filtering（#138）、post-934fb792 Codex HTTP/Responses 剩余兼容行为（#141）、Kimi 原生 Responses upstream 路径（#144）、Codex GPT Image 2.5 registry/direct image routing（#146）、Kimi K2.8 capability/temperature（#149），以及 Codex alias canonical template/provider capability（#151）。
- Responses WebSocket ping/keepalive、Claude 协议/Claude OAuth、Home/Redis、仅 Gemini/Grok/Antigravity 专用变化、赞助和纯文档继续排除；推进 `upstream-ref` 只表示“已审阅并分类”，不表示这些能力已实现。

## 2. 对齐程度

以下比例是工程估算，用来表达工作量和行为覆盖，不是官方兼容认证，也不是逐测试用例通过率。

- **当前目标范围（暂不包含 Claude 协议和未批准的 Codex Live）：约 82%，属于“大体对齐”。**
- **相对 CLIProxyAPI 全部产品能力：约 48%，属于“部分对齐”。**

等级定义：

- **已对齐**：核心行为和失败语义基本一致。
- **大体对齐**：主路径已覆盖，仍缺少少量边界能力。
- **部分对齐**：已有基础实现，但上游能力明显更完整。
- **未对齐**：尚未实现。
- **暂不跟进**：明确不在当前范围内。

## 3. 能力对齐矩阵

| 能力 | 程度 | CFlareAIProxy 状态 | 后续动作 |
| --- | --- | --- | --- |
| OpenAI Chat Completions | 已对齐 | 支持流式、非流式、tools、多账号路由和 OpenAI-compatible 上游 | 跟进上游新增字段和错误语义 |
| OpenAI Responses（HTTP） | 大体对齐 | 支持原生 Responses、Chat↔Responses、tool-output 文本/图片规范化、严格 SSE EOF/error 处理和可选 Multi-Agent V2；Chat function tool 缺省 `strict:false`、Codex tool-name sanitization 及不兼容 Unicode schema regex 清理已同步 | 补齐 `response.done`、Codex reasoning_text、orphan delegation compatibility、constant-union/empty-incomplete、usage/service-tier details、namespace recovery，以及 nested error/sequence/custom-field/safe-number framing；`fco_` output-item ID 与 reasoning/content SSE 顺序跟进 #141；跟进 Issue #115/#116/#132/#134/#141/#38 |
| OpenAI Completions | 大体对齐 | 可路由 generic、Codex、Kimi | 保持兼容，不扩大旧协议特性 |
| Kimi Chat 上游 | 已对齐 | 专用 adapter，当前生产路径固定走 Chat Completions；reasoning placeholder 与同轮 reasoning/tool 行为已补强 | 持续对比 `kimi_executor.go`；tool schema `$ref` normalization 跟进 Issue #112；原生 Responses upstream 评估见 #144 |
| Kimi 模型名归一化 | 已对齐 | 去除 `[1m]` 后缀，并将 K2.7/K2.8 Code、K2.8 preview 等兼容 alias canonicalize 到 `kimi-for-coding`/`-highspeed` | 跟进上游新增 suffix/alias 规则 |
| Kimi 模型目录与能力 | 大体对齐 | 公开模型来自 discovered models 与显式 routes，不复制上游静态目录 | K2.8/K3 `zero_allowed`、1M/64K metadata 与 temperature guard 跟进 #149；原有 K3/K3-256K metadata 持续验证 |
| Kimi 多轮工具消息修复 | 已对齐 | 删除无效空 assistant、补 `reasoning_content`、修复 `call_id/tool_call_id`，并保持 Responses 同轮 reasoning/tool 连续性 | 新增上游测试时同步移植测试语义 |
| Kimi Responses/Completions 转换 | 大体对齐 | 当前 Responses 经 Chat bridge 转换，支持文字、图片、工具定义、tool choice、reasoning fallback、incomplete/content-filter 和 partial tool-call completion safety；尚未启用上游新增的原生 `/responses` wire path | 原生 Responses upstream 路径及 endpoint/stream/usage/error 边界跟进 Issue #144；temperature/reasoning mapping 见 #149；其余 item/event 与 schema normalization 继续跟进 #112 |
| Kimi 流式 usage | 大体对齐 | 自动请求 `include_usage` 并归集基础 Token；Responses detail 已规范化 | 接入更完整 canonical Token 质量模型；启用原生 Responses 前验证 usage detail 保真（#144） |
| Codex Responses 请求归一化 | 大体对齐 | 清理不兼容 prompt-cache 字段、collision-safe input IDs、转换 tools/tool choice、function tool 缺省 `strict:false`、tool name 字符集/长度 sanitization 与可逆恢复，并按 schema 位置清理不兼容 Unicode property escape pattern/patternProperties key；使用 canonical `Session-Id` 并透传 Codex 会话 header；当前不强制伪装官方 Codex `User-Agent`/`Originator` | 评估派生会话 UUID（Issue #35）、剩余 custom tool/name conflict（Issue #38）、原生 session signal 优先级（Issue #42）、HTTP 身份 header 策略（Issue #55）、orphan delegation（Issue #134）及剩余 namespace/schema compatibility（Issue #141） |
| Codex `response.failed/error` | 大体对齐 | SSE 内嵌错误会分类为认证、权限、限额、参数或服务错误；无 payload 的异常 EOF 不再伪装成功；官方 Codex-client framing 已保留部分嵌套 error/sequence 信息 | 对比上游新增 code/type 分类；`response.done` 跟进 #115；usage-limit credential scope/reset precedence 跟进 #138；nested error/custom fields/recursive redaction/sequence 与 retry-advising `server_error` bootstrap failover 跟进 #141；候选耗尽后的 terminal auth aggregate 跟进 #100；model-capacity/model-access scope 跟进 #133 |
| Codex 中断流检测 | 已对齐 | 未收到已知成功终止事件时视为失败，不伪造成功；严格处理 SSE EOF/error，跨 transport chunk 的 CRLF 边界由累计 buffer 自然覆盖 | 补齐 `response.done` 终止事件，跟进 Issue #115 |
| Codex 最终 output 重建 | 已对齐 | 从 `response.output_item.done` 重建空的 `response.output` | 保持事件顺序测试 |
| Codex custom tool HTTP/SSE | 大体对齐 | function tool 基础转换、缺省 strict、名称字符集/长度规范化、碰撞安全和可逆恢复已覆盖；tool parameters 会清理下游不支持的 Unicode property escape regex 且不触碰 `default`/`enum` 用户数据；仍未完整验证复杂 custom tool、交错调用、done fallback、重复抑制与 orphan delegation | 跟进 Issue #38/#134/#141，不涉及 WebSocket |
| Codex tool output 图片 | 大体对齐 | Responses tool-output 文本/图片已做结构化规范化；仍需覆盖复杂递归与混合内容 | 跟进 Issue #42，仅限 HTTP/SSE |
| Codex client model catalog | 大体对齐 | 动态生成 Codex 客户端响应，覆盖 reasoning、modalities、context window、max completion token、visibility、search-tool、service tier、稳定 priority、V2 及新增 model message/schema 字段；builder 支持旧客户端过滤 max/ultra，并在无兼容 reasoning level 时显式保留 `supported_reasoning_levels: []` | `/v1/models` 的 client-version 透传仍跟进 Issue #110；默认内置目录策略保持保守；`gpt-image-2.5*` registry/visibility/direct images 见 #146；alias canonical template metadata/provider capability intersection 见 #151 |
| Codex Multi-Agent V2 | 大体对齐 | 默认关闭；按 route/provider 开启；仅目标 UA；支持 spawn/agent/namespace、非 Codex 转换及流式/非流式恢复 | orphan delegation compatibility 跟进 Issue #134；dotted collaboration name / namespace recovery 跟进 #141；LCP fork/subagent affinity 跟进 Issue #117；WebSocket 单独设计 |
| Codex Live / WebRTC / sideband | 未对齐 | 当前仅实现 HTTP/SSE，不提供媒体 relay 或 TCP candidate proxy | 重大安全与生命周期设计，跟进 Issue #17 |
| Codex reasoning replay/signature cache | 未对齐 | 尚未实现跨请求 reasoning/signature 重放缓存 | 评估 Workers KV/DO 实现 |
| Codex Responses WebSocket | 未对齐 | Workers 网关当前仅实现 HTTP/SSE | 未单独批准前不自动移植；上游 ping/keepalive 等专用变化继续排除 |
| Codex Alpha Search / 特殊路由插件 | 未对齐 | 尚未实现插件式模型选择 | 有真实使用需求后再跟进 |
| 多账号调度 | 大体对齐 | D1 存账号，Durable Object 管租约、权重、优先级、并发和会话亲和；无进程内 executor 重绑定 | retry-round/exclusion、candidate filtering 公平性及 LCP hierarchy 分别跟进 Issue #94/#108/#117；registration epoch/refresh merge 跟进 #113；model-scoped cooldown、credential-change state invalidation、pre-mutation result policy 及 quota reset epoch/精确失效跟进 #133；prevalidated candidate context 跟进 #138；候选全部永久认证失败后的 terminal aggregate 跟进 #100 |
| 账号冷却与失败切换 | 大体对齐 | 认证/限额/服务错误分类后进入账号冷却或 provider 熔断；request-scoped 401 invalid_request 不污染账号可用性；HTTP 402 已进入 credential cooldown/rebind；credential-wide 后续失败只延长、不缩短仍有效 cooldown deadline；Cloudflare 520–526 已由通用 5xx transient 分类覆盖并尊重 `Retry-After` | request-scoped error action/disable-cooling 与 terminal auth aggregate 继续跟进 Issue #100；429 retry-round floor 见 #94；OpenAI-compatible TPM bounded wait 见 #136；model-scoped quota、credential-change invalidation、显式 quota reset 成功后的精确 state invalidation、`model_not_found`/model-access cooldown 与 model-capacity bootstrap failover 见 #133；Codex credential-wide usage limit 与 transient/model scope 区分见 #138；retry-advising server-error failover 见 #141 |
| Token/OAuth 刷新锁 | 大体对齐 | Durable Object 选出唯一 refresh 持有者；Codex 直连与账号级代理 refresh 使用独立 30 秒超时；Codex 超时/传输故障分类为 `OAUTH_REFRESH_FAILED` | JWT `exp`、refresh failure 保留未过期 token、已过期 credential selection 阻断及 24h proactive lead 跟进 Issue #131；refresh three-way state merge/epoch ordering 跟进 #113；上游 auth-file force-refresh/`ForceRefreshAll` worker pool 不适用于 D1/Workers auth-file-free 生命周期；Workers 不复制 Go singleflight/常驻 timer loop 等进程语义 |
| 账号级代理 | 大体对齐 | `proxy_url/proxyUrl` 覆盖 provider/system proxy；支持 `direct/none` | 补齐模型发现和额度刷新使用账号代理；request-scoped APICall proxy 见 Issue #96 |
| Provider/System 代理 | 大体对齐 | 原生 HTTP CONNECT、SOCKS5、TLS；失败不静默直连；request-scoped custom header 已支持 | HTTPS proxy 双层 TLS/ALPN 需 Workers smoke，跟进 Issue #111 |
| OpenAI-compatible 自定义上游 | 已对齐 | 可配置 base URL、API mode、模型、权重、Key、代理和 request-scoped dynamic headers | 配置型模型精确 thinking capability、优先级和热更新跟进 Issue #49；TPM bounded wait 跟进 Issue #136 |
| 模型发现与公开别名 | 大体对齐 | 动态发现、静态路由和公开模型别名；当前不按 Codex API-key 隐式注入内置模型 | 保持“不宣传未验证 built-ins”的既有决策；`gpt-image-2.5*` discovered/explicit capability、visibility 与 direct image endpoint 评估见 #146；Codex alias canonical template/provider capability 见 #151；quota observation 见 #109 |
| 模型能力元数据 | 大体对齐 | 支持 tools、images、reasoning、service tiers、输入/输出模态、context window、max completion token、visibility、search-tool、priority 和模型名回写 | Kimi K2.8/K3 metadata/`zero_allowed` 见 #149；camelCase modality 兼容（Issue #95）及配置型 capability（Issue #49）；GPT Image 2.5 元数据见 #146；Codex alias capability intersection 见 #151；Home-dispatched capability 生命周期不适用当前 Workers 架构 |
| Usage/Token 规范化 | 大体对齐 | 已记录 prompt/completion/cached/total/费用，并规范化 Responses `reasoning_tokens` 与 `cached_tokens` detail | canonical breakdown、partial/unclassified/inconsistent、Codex quota observation 继续跟进 Issue #109；JS safe-integer 与 D1 边界及 Responses 大整数保真跟进 Issue #132；`service_tier` / cache-write token details 跟进 #141；GPT Image usage 若实施 direct image 路径需纳入 #146；上游 reasoning-effort/base_url usage metadata 传播不视为 token normalization |
| 请求级日志与费用 | 项目差异 | 使用 D1/Queue 内建 | 不要求结构一致，只保证 Token 语义可靠 |
| 管理界面 | 项目差异 | 内建 Vue 管理端 | 不跟随 CLIProxyAPI 管理中心架构；账号权重直接来自 D1 账号字段，不移植 auth-file 扫描/force-refresh endpoint 或 plugin quota probe 管理 API 的 Go/pluginhost 生命周期；quota reset 成功后的 routing-state 语义单独在 #133 处理 |
| Gemini / Interactions | 未对齐 | 当前仅有部分 Google adapter 基础 | 另立范围后实施 |
| Grok/xAI | 未对齐 | 当前无完整 OAuth executor | 另立范围后实施 |
| Claude 协议 | 暂不跟进 | 按当前决策暂不实施 Claude 请求/响应兼容 | 不因上游更新自动移植 |
| Go SDK / 本地 CLI 登录 | 暂不跟进 | Workers 服务架构不需要嵌入式 Go SDK | 保持架构差异 |

## 4. 需要重点追踪的上游路径

### Kimi

- `internal/runtime/executor/kimi_executor.go`
- `internal/runtime/executor/kimi_executor_test.go`
- `internal/auth/kimi/**`
- 与 OpenAI Chat/Responses 转换相关的 `sdk/translator/**`
- `internal/registry/models/models.json` 中 Kimi 条目

重点关键词：`normalizeKimiToolMessageLinks`、`reasoning_content`、`tool_call_id`、`stream_options`、`include_usage`、Kimi header、device ID、OAuth、模型 suffix、`kimi-k2.8`、`kimi-k3`、`kimi-k3-256k`、context length、thinking levels、temperature。

### Codex

- `internal/runtime/executor/codex_executor.go`
- `internal/runtime/executor/codex_executor*_test.go`
- `internal/auth/codex/**`
- Codex 相关 `sdk/translator/**`
- `internal/client/codex/models/**`
- `internal/client/codex/optimize-multi-agent-v2/**`
- `internal/runtime/executor/helps/codex_multi_agent_v2.go`
- `internal/runtime/executor/helps/codex_tool_schema.go`
- `internal/config/codex_live.go`

重点关键词：`response.failed`、`response.completed`、`response.done`、`response.output_item.done`、`response.reasoning_text`、`custom_tool_call`、`response.custom_tool_call_input`、`input_image`、`image_url`、`patternProperties`、Unicode property escape、incomplete/disconnected stream、usage limit、capacity、context length、reasoning replay/signature、`minimal` reasoning、`prompt_cache_key`、`Session-Id`、conversation identity、`spawn_agent`、`agent_message`、orphan delegation、model catalog、canonical template、provider capability、`gpt-image-2.5`、`User-Agent`、`Originator`、Codex cloaking、WebRTC、sideband、ICE/STUN/TCP candidate。

### 通用 P1

- 账号选择、credential concurrency、retry/cooldown、proxy-aware client。
- provider registry、model registry、model capability。
- OAuth refresh 和并发锁。
- usage/token normalization 和 cache/tool/reasoning Token 统计。
- OpenAI-compatible provider 配置和请求/响应转换。

## 5. 不触发直接同步的变化

以下变化通常只记录，不自动修改 CFlareAIProxy：

- README、赞助商、展示项目和纯文档排版。
- 仅适用于本地 Go 进程、Gin、文件系统、PostgreSQL 或 Go SDK 的实现。
- Claude 协议、Claude OAuth、Claude Token 估算。
- 与当前供应商无关的 Gemini、Grok/xAI 专用修复。
- Home/Redis 控制面、Home credential refresh 协议及其 usage/token 指纹上报。
- WebSocket、WebRTC、媒体 relay、sideband 或 TCP candidate proxy，除非已经单独批准设计。
- 上游重构但没有行为变化。

## 6. 上游更新后的同步流程

1. 读取本文档中的 `upstream-ref`，比较该提交到上游最新 `main`。
2. 只筛选第 4 节列出的路径、关键词和行为变化。
3. 将变化分类为：已具备、只缺测试、需要移植、架构不适用、当前范围外。
4. 优先移植行为与测试，不机械翻译 Go 代码。
5. Cloudflare Workers 中不得引入常驻单进程内存状态、本地文件系统持久化、无限制长连接、Node/Go 专属网络 API，或失败后静默绕过代理直连。
6. 修改后至少执行 Worker TypeScript typecheck、相关 Vitest、Kimi/Codex 协议回归、错误分类/租约/cooldown 测试和代理继承测试。
7. 同步后更新 `upstream-ref`、`local-implementation-ref`、`last-reviewed`、对齐矩阵和审阅记录。
8. 变更过大、依赖架构决策或属于 WebSocket/WebRTC/Claude 范围时，不直接合入，改为创建跟进 Issue。

## 7. 验收标准

- 上游相关提交已逐项分类，没有只看 commit 标题。
- 新行为有对应测试，尤其是流终止、工具调用和错误分支。
- 对客户端暴露的模型名仍使用公开模型名，不泄漏内部 upstream alias。
- 账号失败能够正确释放租约并进入适当 cooldown。
- Provider 故障和单账号故障没有混为一谈。
- 代理失败不会改走 Worker 直连出口。
- 文档基线已更新。

## 8. 审阅记录

| 日期 | 上游范围 | 本地提交 | 结论 |
| --- | --- | --- | --- |
| 2026-09-13 | `5b278561..ac02da6c` | 文档更新；#133 补充 | 已完成 4 个新增提交逐提交、逐文件审阅并推进审阅基线。`b192f655` 的 plugin/declarative quota reset 在上游明确 reset 成功后清除对应 credential 的 core routing quota state；该语义依赖 credential/model scope、reset epoch 与并发 late release 防护，本地当前 credential-wide AccountPool 无法安全机械移植，已补充 #133 的精确失效、失败不清状态和并发验收。`e30de3d5` 为 Antigravity-only capability probe cache，`3c3938fe` 为 plugin auth login metadata，`ac02da6c` 为赞助链接文档，按当前范围不改运行时。本轮无运行时代码变化，`local-implementation-ref` 保持 `67029a02`；因此无需新增 TypeScript/Vitest。 |
| 2026-09-12 | `09a29bd..5b278561` | `67029a02`（PR #150）+ #133/#141/#149/#151 | 已完成 31 个新增提交逐提交、逐文件筛选。Kimi K2.8/K2.8 Code/preview alias canonicalization 已安全同步并覆盖实际 request body；PR #150 CI 通过。静态 K2.8/K3 capability/`zero_allowed` 与 temperature guard 建立 #149；Codex alias canonical template/provider capability 建立 #151；credential-change cooldown invalidation 与 pre-mutation result policy 补充 #133；Responses `fco_` call-id fallback 与 reasoning/content SSE 顺序补充 #141。Cloudflare 520–526 + `Retry-After` 本地已有等价通用 5xx/retry-after 分类；Go ForceRefreshAll worker pool、usage `base_url`/reasoning-effort metadata、pluginhost model-list interceptor 无需改变当前 Workers token/proxy/runtime。WebSocket、Claude、Gemini/Grok-only、赞助/文档按规则排除。 |
| 2026-09-10 | `d1a024e9..09a29bd` | 文档更新；#132/#133/#141 | 已完成 8 个新增提交逐提交、逐文件审阅并推进基线。`25913086` 的 Responses HTTP/SSE nested error/custom fields、`sequence_number`、递归敏感字段脱敏和无损大整数/token metrics 保真继续由 #132/#141 统一处理，避免在普通客户端和官方 Codex-client framing 之间扩大不一致；`3ae9093d` model-capacity bootstrap failover 与 `dde250f1` 的 `model_not_found` 404/model-access model-scoped cooldown 依赖 model-scoped pool/error scope，继续归入 #133；`638ed7e1` 的 split-CRLF SSE 修复本地累计 buffer 已等价覆盖，无运行时代码变化。`bd03aabc` WebSocket、`4dce5f3a` Gemini、`6a73f396` Claude、`09a29bd` 赞助/README 按规则排除。 |
| 2026-09-10 | `7fac6b15..d1a024e9` | `07d2bb6d`（PR #147）+ #100/#117/#133/#141/#146 | 已完成 10 个新增提交逐提交、逐文件审阅。`e56abd56`/`37ce368c` 的 Codex 通用 tool-schema Unicode property escape/patternProperties 防护已按 Workers 无状态请求规范化同步，覆盖 native Responses 与 Chat/custom-tool 路径并保留非 schema `default`/`enum` 数据。`b064b832` model-level cooling 补充 #133；`aedc9e6a` 候选耗尽后的 non-retryable terminal auth 补充 #100；`3bf787fc` canonical session/header 一致性补充 #117；`d1a024e9` GPT Image 2.5 built-in registry 与 direct image execution 建立 #146；`60e5b8bd` auth-file force-refresh 管理生命周期、`0796d6d1` pluginhost callback 不适用当前 Workers 架构；Claude/merge-only 变化按规则排除。PR #147 的验证结果以合入时 GitHub Actions 为准。 |
| 2026-09-09 | `ba7e5583..7fac6b15` | 文档更新；Issue #144 | 已完成 28 个新增提交的逐提交、逐文件审阅并推进基线。`d4146bde` 为 Kimi 新增原生 OpenAI Responses upstream wire path：stream/non-stream 直接请求 Kimi `/v1/responses`，不再通过 Chat bridge；本地当前仍将 Responses 转成 Chat 后发 `/chat/completions`，该切换会改变 tool/reasoning/incomplete/usage/error 与 endpoint override 语义，因此创建 #144 做显式 Workers 兼容设计与验收，不直接合入。`48e5e9e0` 的 refresh-loop 30 秒最大 sleep 与 `1d5f7b2a` 的 Go monotonic clock 清理在 Workers 无对应运行时状态；`39058915`/`6b187e77`/`1119ef14` 的 session hierarchy/UUIDv8 继续归入 #117；`7fac6b15` 仅修改 Claude→Codex schema normalization，按 Claude 协议排除。其余 Gemini/Antigravity、Claude、plugin-store/Home/Redis、logging、赞助/文档变化按规则排除。本轮无运行时代码变更，`local-implementation-ref` 保持 `7e91167c`。 |
| 2026-09-08 | `934fb792..ba7e5583` | `7e91167c`（PR #142）+ Issue #141 | 已完成该区间 Codex HTTP/Responses 逐提交、逐文件审阅并推进基线。`d01516c1` 的 function tool 缺省 `strict:false` 与 `bee20b99` 的 tool-name 字符集/长度 sanitization、碰撞安全和可逆恢复已同步到 Workers，测试覆盖 omitted/explicit strict、declarations/tool_choice/history 的非法字符传播和 sanitization collision；PR #142 CI 的 worker/web TypeScript typecheck、完整测试、production build、Wrangler dry-run 均通过。`bf20b999` constant-only `oneOf/anyOf` schema normalization 与空 `response.incomplete`、`8696585c` service-tier/cache-write token details、`82f4f370` Multi-Agent dotted-name 恢复、`03a054e3` namespace recovery、`ba7e5583` retry-advising `server_error` failover 继续由 #141 跟进。WebSocket、Claude、Gemini/Grok-only、赞助/文档按规则排除。 |
| 2026-09-07 | `c76dfd4..934fb792` | `a7d6fd08`（PR #140）+ Issue #133 补充 | 已完成 14 个新增提交的逐提交/逐文件审阅并推进基线。`1c22598d` 的 credential/model cooldown deadline 单调性中，可独立适配 Workers 的 credential-wide 部分已同步：后续失败不会用更短 deadline 覆盖仍生效的长 cooldown，并以两个并发 lease 的 429 回归测试验证；GitHub Actions 的 worker/web typecheck、完整 tests、production build 和 Wrangler dry-run 全部通过。`fa01468e` 的 canonical model targeted scheduler shard update / supported-model registry-epoch cache 依赖 model-scoped pool state，已补充 #133 验收，不直接移植。`00c63a56` 为 pluginhost outbound HTTP wire profile，Workers 当前无 pluginhost HTTP bridge，因此不改 core proxy。Antigravity/Gemini、Grok/xAI WebSocket、Claude、赞助/README 变化按范围排除。 |
| 2026-09-06 | `5208aec7..c76dfd4` | 文档更新；Issue #138 | 已完成 7 个新增提交的逐提交/逐文件审阅并推进审阅基线。`5ab0bca0` 的 Codex `usage_limit_reached` credential-wide scope、top-level/nested `resets_at`/`resets_in_seconds` 解析及 prevalidated candidate context 会改变 AccountPool cooldown、model/provider scope、retry precedence 与 session-affinity candidate 语义，继续由 #138 设计和验证，不直接合入。`31ec4362` 删除的静态 `gpt-5.4/gpt-5.4-mini` 本地无对应条目；`084f25c7` 文件 watcher 并发快照不适用 Workers；`580df364` 仅传播 session hierarchy 到 usage/Home/Redis 元数据，token normalization 无变化且 hierarchy 继续归入 #117；`c76dfd4` 固定 Codex UA 更新不改变本地显式 UA 策略。Claude、Gemini/AI Studio 和 WebSocket/Live 专用变化继续排除。本轮没有运行时代码变化，因此无需新增 typecheck/Vitest 结果。 |
| 2026-09-05 | `2a6b87ac..5208aec7` | `27c21c65`（PR #137）+ 跟进 Issues | 继续完成逐提交/逐文件分类并推进基线。`5208aec7` 修复 Codex client catalog 空 reasoning-level 语义：无可用或被 legacy client 过滤后为空时显式返回 `supported_reasoning_levels: []`，并删除 `default_reasoning_level`；本地已同步行为与两组回归测试，GitHub Actions 的 worker/web typecheck、完整测试、production build 和 Wrangler dry-run 通过。同期 OpenAI-compatible 429/TPM bounded wait 继续跟进 #136；OAuth refresh three-way merge/epoch ordering 归入 #113；`gpt-6-astra`/默认 catalog capability 策略归入 #52。WebSocket、Claude、Home/Redis、Gemini/Grok/Antigravity-only、赞助及纯文档变化继续排除。 |
| 2026-09-04 | `17a65ee5..2a6b87ac` | `090183c8` + 跟进 Issues | 已完成该区间逐提交/逐文件分类并推进审阅基线。范围内变化：OAuth access-token expiry/refresh failure（#131）、usage/token safe-integer accounting（#132）、model-scoped quota cooldown（#133）、Codex orphan delegation compatibility（#134）；429 cooldown floor/retry-round 归入 #94，Merkle LCP fork/subagent hierarchy 归入 #117。`cdda333c` 的旧 Codex client reasoning-level 清理本地已有等价 builder 行为；`c6dd8214` 为 Kimi helper 重构。Home-dispatched capabilities、Claude、Gemini/Antigravity-only、赞助/文档以及 `2a6b87ac` WebSocket ping 按范围排除。上述新增差异均涉及 DO/OAuth/usage/protocol 架构或缺少可重复 Workers 验证，本轮不提交运行时代码。 |
| 2026-09-02 | `41fc5e13..17a65ee` | `14bd81b4`（PR #124）+ 跟进 Issues | 已完成该区间逐项分类并推进审阅基线。PR #124 同步了可安全适配 Workers 的 HTTP/Responses、Kimi、Codex request normalization、dynamic headers、401 分类、usage detail 与 model catalog 行为；CI 的 worker/web typecheck、tests、production web build、Wrangler dry-run 和 Cloudflare Workers build 全部通过。调度 retry-round/candidate fairness、error-action/cooldown、quota snapshot、HTTPS proxy、registration epoch、`response.done`、Codex `reasoning_text`、Kimi tool schema 与 LCP session hierarchy 等仍按 Issue #94/#100/#108/#109/#111/#112/#113/#115/#116/#117 跟进；WebSocket/Claude/Gemini-only/Grok-only 变化继续排除。 |
| 2026-08-03 | `bc71c77f..41fc5e13` | `2a057b44` | Codex OAuth refresh 在 Workers 中使用独立 30 秒 timeout signal；Codex 直连和账号级代理的超时/传输故障均分类为可观测的 `OAUTH_REFRESH_FAILED`。并发语义由 Durable Object refresh lock 提供唯一持有者，不复制 Go singleflight 的等待共享结果；测试覆盖并发唯一持有者及调用方取消后锁所有权保持。Claude OAuth/TLS handshake 与 Home client closure 继续排除。 |
| 2026-07-31 | `a80e8082..4a315136` | 文档更新 | 4 个提交中 `7d00936a` 为 Kimi registry 增加 `kimi-k3-256k`，并更新 `kimi-k3` 的 1M context、65K output 与 `low/high/max` thinking metadata，属于 Kimi/provider-model registry 范围内实质变化。CFlareAIProxy 的公开目录来自 discovered models 与显式 routes，不复制上游静态目录，因此未硬编码新模型；待发现或配置该模型时验证能力与别名回写。`f179a0f4`、`4db8e120` 及合并提交 `4a315136` 为 Home/Redis/Go SDK 的 401 OAuth 恢复、token 指纹、选择重派发及 WebSocket retention，Workers 当前无对应 Home 协议，未移植。 |
| 2026-07-30 | `a80e8082..4a315136` | 文档更新；Issue #55 补充 | `a80e8082` 为 Codex HTTP 请求新增可关闭的 cloaking 策略，但默认会在客户端、配置和自定义 header 之后强制覆盖固定 `User-Agent` 与 `Originator`，同时更新固定 UA 版本。该行为属于 Codex HTTP 范围内实质变化，但涉及官方客户端身份伪装、header 优先级、审计可观测性、API-key/OAuth 差异和合规决策，未直接移植；WebSocket 测试继续排除，已创建仅限 HTTP/SSE 的 Issue #55。 |
| 2026-07-30 | `b4d94d58..928478e4` | 文档更新；Issue #52 补充 | 2 个提交中 `928478e4` 固化 Codex API-key 未显式配置模型时使用内置默认目录，并新增测试要求默认注册集和 `/v1/models` 来源包含 `gpt-image-1.5`、`gpt-image-2`，显式模型模式不得混入默认图像模型。该行为继续涉及公开模型面、发现失败时的误宣传及 credential 身份绑定，未直接移植，已补充 Issue #52 验收要求。`e8e39526` 仅为 Gin/文件型管理端规范化解析和展示 credential weight；Workers 侧账号权重由 D1 数据直接表达，无对应 auth-file 扫描路径，不移植。 |
| 2026-07-30 | `2b63d6bc..b4d94d58` | 文档更新；Issue #52 | 3 个提交中 `b4d94d58` 恢复 Codex API-key 未显式配置模型时的内置 Codex Pro 默认目录，并增加配置索引 credential 校验、回退匹配和陈旧模型清理，属于 provider/model registry 范围内实质变化。该提交推翻上一轮 configured-models-only 语义；因 Workers 侧需先决定隐式默认目录、D1 账号与 route/provider/discovery 的凭据身份绑定、配置轮换和陈旧目录失效策略，未直接移植。`1c1d8efd` 为 Antigravity/Gemini 专用 response schema 修复，`a2ff6914` 为本地 Git store 恢复逻辑，均排除。 |
| 2026-07-30 | `4a2eb54d..2b63d6bc` | 文档更新 | 3 个提交中 `2c8e5ba4` 修正 Codex API-key credential 模型注册，只暴露明确配置模型且空配置不注册模型；CFlareAIProxy 的 `/v1/models` 和 Codex client catalog 已仅从启用的 discovered models 与显式 routes 构建，不存在强制注入内置模型路径，因此行为已具备，无运行代码或测试变更。`8cdd3f1d` 为合并提交，`2b63d6bc` 仅涉及 Gemini schema cleaning，排除。 |
| 2026-07-30 | `c9417c8a..4a2eb54d` | 文档更新；Issue #49 | 10 个提交中 `f3229143` 为 Codex/OpenAI-compatible 配置型模型新增精确 thinking capability、模型哈希失效与统一 capability-aware 请求应用，属于 provider/model registry 范围内实质变化；因 Workers 侧需明确配置与发现 metadata 优先级、KV/DO 热更新失效、alias 回写和 level 校验，未直接移植。`74d38e09`、`fecebcca`、`4a2eb54d` 均仅涉及 Claude 协议转换；Home CAS、Antigravity/Gemini schema 和 Gemini registry 变化排除。 |
| 2026-07-28 | `cade44b9..c9417c8a` | 文档更新；Issue #47 | 15 个提交中 `5dcca50f` 的 smooth weighted round-robin、credential weight 统一解析与严格校验属于账号选择范围内实质变化；因 Workers 侧由 Durable Object 管理权重、租约、并发与会话亲和，上游 Go 进程内 current-weight 状态不能直接移植，需先明确状态隔离、sticky 推进、cooldown 恢复、热更新和 DO 重启语义。客户端元数据、Home、pluginhost、store、Claude 和仅 Antigravity/Gemini/Grok 变化排除。 |
| 2026-07-28 | `8423cce2..cade44b9` | 文档更新；Issue #42 | 16 个提交中，会话亲和原生信号优先级、控制字符校验、Home alias 保留、Codex tool output 图片及 `minimal` reasoning 为范围内实质变化；因涉及 Durable Object 亲和键、租户隔离、公开 HTTP/Responses 转换边界且无法在本轮可靠执行本地测试，未直接移植，创建仅限 HTTP/SSE 的跟进。Gemini/Antigravity usage 零值、request lifecycle plugin、gitstore、Claude、Gemini registry 和文档变化排除。 |
| 2026-07-27 | `42a00a2a..8423cce2` | 文档更新；Issue #38 | 18 个提交中 `6491ce39` 与 `58ede93e` 为 Codex HTTP/SSE custom tool 请求/响应转换的实质变化，涉及名称冲突、长名称映射、逐调用流状态、交错事件与重复抑制；因无法在本轮可靠执行本地类型检查和测试，未直接移植，创建仅限 HTTP/SSE 的跟进。PostgreSQL cooldown、Go SDK/filestore 属架构不适用；reasoning replay 仍需 KV/DO 设计；Claude、Gemini、xAI/Grok 和文档变化排除。 |
| 2026-07-26 | `27fc3169..42a00a2a` | 文档更新；Issue #35 | 8 个提交中 `f6c32ec3` 含 Codex HTTP/Responses 派生会话 UUID 与 prompt cache/session header 回退语义，属于相关变化；因租户隔离、账号切换稳定性和隐私回退无法在本轮可靠验证，未直接移植，建立仅限 HTTP/SSE 的设计与测试跟进。其 WebSocket 测试以及 Claude、Home/Redis、pluginhost、Gemini/Antigravity、xAI 变化均排除。 |
| 2026-07-26 | `f8dffa05..27fc3169` | 文档更新 | 11 个提交中仅 `27fc3169` 含通用 executor 注册串行化和 Codex executor 保留语义；Workers 侧由 Durable Object 串行租约、按请求配置快照和无进程内 executor registry 自然覆盖，不移植 Go 生命周期代码。OAuth 选择日志无行为变化；其余为 Windows plugin、Claude、Gemini/Antigravity 或 Grok/xAI 专用变化。 |
| 2026-07-25 | Issue #16 + `71d59129` | `88f703c9..86b7eb4c` | 已实现 Workers 原生 Multi-Agent V2 HTTP/SSE 兼容层和动态 Codex client model catalog：默认关闭、目标 UA 门禁、route/provider 灰度、冲突安全回退、公开模型/能力继承、SSE frame metadata 保留；不引入常驻 registry、文件系统或 WebSocket 假设。 |
| 2026-07-25 | `35ebe3f3..f8dffa05` | 文档更新；Issue #16 补充；Issue #17 | Codex client model catalog 属于相关变化；Codex Live/WebRTC 属重大架构和安全能力，不直接合入。其余为 Claude 或纯文档变化。 |
| 2026-07-25 | `42f36b94..35ebe3f3` | `f68c71f5`；Issue #16 | credential concurrency 仅重构测试，无行为变化；新增 Codex Multi-Agent V2 属于重大架构能力，先设计后实现。 |
| 2026-07-24 | 至 `42f36b94` | `4e20ae6b` | Kimi/Codex HTTP 核心与 P1 调度、错误、模型能力已大体对齐；Token canonical breakdown、Codex WebSocket/replay cache、完整多供应商范围仍未对齐。 |

## 9. 许可证与署名

CLIProxyAPI 使用 MIT License。可以参考、修改和移植其代码，但如果复制了具有实质性的代码片段，应同时保留适用的版权与 MIT 许可声明。一般情况下，本项目优先根据上游行为和测试重新实现，以适配 Cloudflare Workers 架构。