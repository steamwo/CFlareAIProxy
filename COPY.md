# CLIProxyAPI 对齐与跟进（COPY）

> 本文档记录 CFlareAIProxy 与 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的行为对齐程度、明确差异和后续同步规则。
>
> `COPY` 表示“参考、比较并按本项目架构移植”，不表示逐文件复制。CFlareAIProxy 运行在 Cloudflare Workers 上，必须优先遵守 Workers、D1、Durable Objects、KV、Queue 和原生 Socket 的约束。

<!-- upstream-repository: router-for-me/CLIProxyAPI -->
<!-- upstream-ref: 4a2eb54dc6bf943196be4fb515e6a9407a4db143 -->
<!-- local-implementation-ref: 86b7eb4ca1b81c9332e681206dcd78be0cda4f32 -->
<!-- last-reviewed: 2026-07-30 -->

## 1. 当前基线

| 项目 | 基线 |
| --- | --- |
| 上游仓库 | `router-for-me/CLIProxyAPI` |
| 上游分支 | `main` |
| 已审阅上游提交 | `4a2eb54dc6bf943196be4fb515e6a9407a4db143` |
| 本地分支 | `dev` |
| 本地实现基线 | `86b7eb4ca1b81c9332e681206dcd78be0cda4f32` |
| 审阅日期 | 2026-07-30 |

本轮审阅范围为 `c9417c8a..4a2eb54d`，共 10 个提交：

- `f3229143` 为配置型 API-key provider 的模型条目新增精确 thinking/reasoning capability，并将其纳入模型哈希、registry 合成和统一请求 thinking 应用路径；Codex 与 OpenAI-compatible 均受影响。
- 该变化需要明确配置能力与发现/静态 registry 的优先级、Workers 配置热更新失效语义、公开 alias 回写及不同 provider 的 level 校验，未直接移植，已创建 Issue #49。
- `74d38e09` 的 `cached_creation_tokens` 仅修改 Claude→OpenAI usage 转换，按 Claude 协议范围排除；`fecebcca` 与 `4a2eb54d` 仅修改 Codex→Claude/Claude 请求转换，同样排除。
- Home CAS、Claude header、Antigravity/Gemini schema、Gemini model registry 删除及仅 xAI/Gemini/Claude 相关变化均按范围或 Workers 架构差异排除。

本轮没有安全可验证的运行代码或测试更新；`local-implementation-ref` 保持不变。

## 2. 对齐程度

以下比例是工程估算，用来表达工作量和行为覆盖，不是官方兼容认证，也不是逐测试用例通过率。

- **当前目标范围（暂不包含 Claude 协议和未批准的 Codex Live）：约 75%，属于“大体对齐”。**
- **相对 CLIProxyAPI 全部产品能力：约 44%，属于“部分对齐”。**

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
| OpenAI Responses（HTTP） | 大体对齐 | 支持原生 Responses、Chat↔Responses 转换和可选 Multi-Agent V2 请求/响应兼容 | 补齐 custom tool、tool output 图片、交错调用和终止事件测试，跟进 Issue #38/#42 |
| OpenAI Completions | 大体对齐 | 可路由 generic、Codex、Kimi | 保持兼容，不扩大旧协议特性 |
| Kimi Chat 上游 | 已对齐 | 专用 adapter，固定走 Chat Completions | 持续对比 `kimi_executor.go` |
| Kimi 模型名归一化 | 已对齐 | 去除 `[1m]` 后缀 | 跟进上游新增 suffix/alias 规则 |
| Kimi 多轮工具消息修复 | 已对齐 | 删除无效空 assistant、补 `reasoning_content`、修复 `call_id/tool_call_id` | 新增上游测试时同步移植测试语义 |
| Kimi Responses/Completions 转换 | 大体对齐 | 支持文字、图片、工具定义、tool choice 和终止事件 | 跟进新的 Responses item/event 类型 |
| Kimi 流式 usage | 大体对齐 | 自动请求 `include_usage` 并归集基础 Token | 接入规范化 Token 质量模型 |
| Codex Responses 请求归一化 | 大体对齐 | 清理不兼容字段、转换 tools/tool choice、透传 Codex 会话头 | 评估派生会话 UUID（Issue #35）、custom tool/name conflict（Issue #38）和原生 session signal 优先级（Issue #42） |
| Codex `response.failed/error` | 已对齐 | SSE 内嵌错误会分类为认证、权限、限额、参数或服务错误 | 对比上游新增 code/type 分类 |
| Codex 中断流检测 | 已对齐 | 未收到 `response.completed/incomplete` 时视为失败，不伪造成功 | 跟进上游中断流恢复策略 |
| Codex 最终 output 重建 | 已对齐 | 从 `response.output_item.done` 重建空的 `response.output` | 保持事件顺序测试 |
| Codex custom tool HTTP/SSE | 部分对齐 | 基础 function tool 已覆盖；尚未验证 custom tool、交错调用、done fallback 与重复抑制 | 跟进 Issue #38，不涉及 WebSocket |
| Codex tool output 图片 | 部分对齐 | 已支持常规文本 tool output；尚未验证 `input_image`/`image_url` 混合结构和递归内容 | 跟进 Issue #42，仅限 HTTP/SSE |
| Codex client model catalog | 大体对齐 | 动态生成 Codex 客户端响应，覆盖 reasoning、modalities、context window、visibility、search-tool、service tier、稳定 priority 和 V2 标记 | 核实并补齐 `minimal` reasoning，跟进 Issue #42；配置型模型精确 capability 与热更新跟进 Issue #49 |
| Codex Multi-Agent V2 | 大体对齐 | 默认关闭；按 route/provider 开启；仅目标 UA；支持 spawn/agent/namespace、非 Codex 转换及流式/非流式恢复 | 运行完整 CI 与真实 Codex 客户端 smoke；WebSocket 单独设计 |
| Codex Live / WebRTC / sideband | 未对齐 | 当前仅实现 HTTP/SSE，不提供媒体 relay 或 TCP candidate proxy | 重大安全与生命周期设计，跟进 Issue #17 |
| Codex reasoning replay/signature cache | 未对齐 | 尚未实现跨请求 reasoning/signature 重放缓存 | 评估 Workers KV/DO 实现 |
| Codex Responses WebSocket | 未对齐 | Workers 网关当前仅实现 HTTP/SSE | 未单独批准前不自动移植 |
| Codex Alpha Search / 特殊路由插件 | 未对齐 | 尚未实现插件式模型选择 | 有真实使用需求后再跟进 |
| 多账号调度 | 大体对齐 | D1 存账号，Durable Object 管租约、权重、优先级、并发和会话亲和；无进程内 executor 重绑定 | 跟进 credential concurrency、会话信号优先级和选择算法变化，保持无关 provider 更新不扰动既有租约；平滑加权轮询与 weight 校验见 Issue #47 |
| 账号冷却与失败切换 | 大体对齐 | 认证/限额/服务错误分类后进入账号冷却或 provider 熔断 | 继续细化按错误类型的 cooldown；不移植 PostgreSQL store |
| Token/OAuth 刷新锁 | 大体对齐 | 使用 Durable Object 防止同账号并发刷新 | 跟进新的 OAuth 字段和刷新失败语义 |
| 账号级代理 | 大体对齐 | `proxy_url/proxyUrl` 覆盖 provider/system proxy；支持 `direct/none` | 补齐模型发现和额度刷新使用账号代理 |
| Provider/System 代理 | 已对齐 | 原生 HTTP CONNECT、SOCKS5、TLS；失败不静默直连 | 持续跟进 Workers Socket 限制 |
| OpenAI-compatible 自定义上游 | 已对齐 | 可配置 base URL、API mode、模型、权重、Key 和代理 | 配置型模型精确 thinking capability、优先级和热更新跟进 Issue #49 |
| 模型发现与公开别名 | 大体对齐 | 动态发现、静态路由和公开模型别名 | 补强不同供应商模型响应解析 |
| 模型能力元数据 | 大体对齐 | 支持 tools、images、reasoning、service tiers、输入/输出模态、context window、visibility、search-tool、priority 和模型名回写 | 跟进上游 registry 新字段、`minimal` reasoning、冲突优先级及配置型 capability（Issue #49） |
| Usage/Token 规范化 | 部分对齐 | 已记录 prompt/completion/cached/total 和费用 | 优先跟进 canonical breakdown、partial/unclassified/inconsistent 状态 |
| 请求级日志与费用 | 项目差异 | 使用 D1/Queue 内建 | 不要求结构一致，只保证 Token 语义可靠 |
| 管理界面 | 项目差异 | 内建 Vue 管理端 | 不跟随 CLIProxyAPI 管理中心架构 |
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

重点关键词：`normalizeKimiToolMessageLinks`、`reasoning_content`、`tool_call_id`、`stream_options`、`include_usage`、Kimi header、device ID、OAuth、模型 suffix。

### Codex

- `internal/runtime/executor/codex_executor.go`
- `internal/runtime/executor/codex_executor*_test.go`
- `internal/auth/codex/**`
- Codex 相关 `sdk/translator/**`
- `internal/client/codex/models/**`
- `internal/client/codex/optimize-multi-agent-v2/**`
- `internal/runtime/executor/helps/codex_multi_agent_v2.go`
- `internal/client/codex/live/**`
- `internal/config/codex_live.go`

重点关键词：`response.failed`、`response.completed`、`response.output_item.done`、`custom_tool_call`、`response.custom_tool_call_input`、`input_image`、`image_url`、incomplete/disconnected stream、usage limit、capacity、context length、reasoning replay/signature、`minimal` reasoning、`prompt_cache_key`、`Session_id`、conversation identity、`spawn_agent`、`agent_message`、model catalog、WebRTC、sideband、ICE/STUN/TCP candidate。

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
| 2026-07-30 | `c9417c8a..4a2eb54d` | 文档更新；Issue #49 | 10 个提交中 `f3229143` 为 Codex/OpenAI-compatible 配置型模型新增精确 thinking capability、模型哈希失效与统一 capability-aware 请求应用，属于 provider/model registry 范围内实质变化；因 Workers 侧需明确配置与发现 metadata 优先级、KV/DO 热更新失效、alias 回写和 level 校验，未直接移植。`74d38e09`、`fecebcca`、`4a2eb54d` 均仅涉及 Claude 协议转换；Home CAS、Antigravity/Gemini schema 和 Gemini registry 变化排除。 |
| 2026-07-28 | `cade44b9..c9417c8a` | 文档更新；Issue #47 | 15 个提交中 `5dcca50f` 的 smooth weighted round-robin、credential weight 统一解析与严格校验属于账号选择范围内实质变化；因 Workers 侧由 Durable Object 管理权重、租约、并发与会话亲和，上游 Go 进程内 current-weight 状态不能直接移植，需先明确状态隔离、sticky 推进、cooldown 恢复、热更新和 DO 重启语义。客户端元数据、Home、pluginhost、store、Claude 和仅 Antigravity/Gemini/Grok 变化排除。 |
| 2026-07-28 | `8423cce2..cade44b9` | 文档更新；Issue #42 | 16 个提交中，会话亲和原生信号优先级、控制字符校验、Home alias 保留、Codex tool output 图片及 `minimal` reasoning 为范围内实质变化；因涉及 Durable Object 亲和键、租户隔离、公开 HTTP/Responses 转换边界且无法可靠执行本地测试，未直接移植，创建仅限 HTTP/SSE 的跟进。Gemini/Antigravity usage 零值、request lifecycle plugin、gitstore、Claude、Gemini registry 和文档变化排除。 |
| 2026-07-27 | `42a00a2a..8423cce2` | 文档更新；Issue #38 | 18 个提交中 `6491ce39` 与 `58ede93e` 为 Codex HTTP/SSE custom tool 请求/响应转换的实质变化，涉及名称冲突、长名称映射、逐调用流状态、交错事件与重复抑制；因无法在本轮可靠执行本地类型检查和测试，未直接移植，创建仅限 HTTP/SSE 的跟进。PostgreSQL cooldown、Go SDK/filestore 属架构不适用；reasoning replay 仍需 KV/DO 设计；Claude、Gemini、xAI/Grok 和文档变化排除。 |
| 2026-07-26 | `27fc3169..42a00a2a` | 文档更新；Issue #35 | 8 个提交中 `f6c32ec3` 含 Codex HTTP/Responses 派生会话 UUID 与 prompt cache/session header 回退语义，属于相关变化；因租户隔离、账号切换稳定性和隐私回退无法在本轮可靠验证，未直接移植，建立仅限 HTTP/SSE 的设计与测试跟进。其 WebSocket 测试以及 Claude、Home/Redis、pluginhost、Gemini/Antigravity、xAI 变化均排除。 |
| 2026-07-26 | `f8dffa05..27fc3169` | 文档更新 | 11 个提交中仅 `27fc3169` 含通用 executor 注册串行化和 Codex executor 保留语义；Workers 侧由 Durable Object 串行租约、按请求配置快照和无进程内 executor registry 自然覆盖，不移植 Go 生命周期代码。OAuth 选择日志无行为变化；其余为 Windows plugin、Claude、Gemini/Antigravity 或 Grok/xAI 专用变化。 |
| 2026-07-25 | Issue #16 + `71d59129` | `88f703c9..86b7eb4c` | 已实现 Workers 原生 Multi-Agent V2 HTTP/SSE 兼容层和动态 Codex client model catalog：默认关闭、目标 UA 门禁、route/provider 灰度、冲突安全回退、公开模型/能力继承、SSE frame metadata 保留；不引入常驻 registry、文件系统或 WebSocket 假设。 |
| 2026-07-25 | `35ebe3f3..f8dffa05` | 文档更新；Issue #16 补充；Issue #17 | Codex client model catalog 属于相关变化；Codex Live/WebRTC 属重大架构和安全能力，不直接合入。其余为 Claude 或纯文档变化。 |
| 2026-07-25 | `42f36b94..35ebe3f3` | `f68c71f5`；Issue #16 | credential concurrency 仅重构测试，无行为变化；新增 Codex Multi-Agent V2 属于重大架构能力，先设计后实现。 |
| 2026-07-24 | 至 `42f36b94` | `4e20ae6b` | Kimi/Codex HTTP 核心与 P1 调度、错误、模型能力已大体对齐；Token canonical breakdown、Codex WebSocket/replay cache、完整多供应商范围仍未对齐。 |

## 9. 许可证与署名

CLIProxyAPI 使用 MIT License。可以参考、修改和移植其代码，但如果复制了具有实质性的代码片段，应同时保留适用的版权与 MIT 许可声明。一般情况下，本项目优先根据上游行为和测试重新实现，以适配 Cloudflare Workers 架构。