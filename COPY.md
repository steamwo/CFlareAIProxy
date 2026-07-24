# CLIProxyAPI 对齐与跟进（COPY）

> 本文档记录 CFlareAIProxy 与 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的行为对齐程度、明确差异和后续同步规则。
>
> `COPY` 表示“参考、比较并按本项目架构移植”，不表示逐文件复制。CFlareAIProxy 运行在 Cloudflare Workers 上，必须优先遵守 Workers、D1、Durable Objects、KV、Queue 和原生 Socket 的约束。

<!-- upstream-repository: router-for-me/CLIProxyAPI -->
<!-- upstream-ref: f8dffa0522c628c27970148319a50f25f0ffebdd -->
<!-- local-implementation-ref: f68c71f5a40a9660b40a2bff7f0312dd7feecd0f -->
<!-- last-reviewed: 2026-07-25 -->

## 1. 当前基线

| 项目 | 基线 |
| --- | --- |
| 上游仓库 | `router-for-me/CLIProxyAPI` |
| 上游分支 | `main` |
| 已审阅上游提交 | `f8dffa0522c628c27970148319a50f25f0ffebdd` |
| 本地分支 | `dev` |
| 本地实现基线 | `f68c71f5a40a9660b40a2bff7f0312dd7feecd0f` |
| 审阅日期 | 2026-07-25 |

本轮审阅范围为 `35ebe3f3..f8dffa05`，共 8 个提交：

- 1 个纯赞助文档提交，忽略。
- 1 个 Claude client model catalog，属于明确排除范围。
- 1 个 Codex client model catalog 重构与增强，属于 provider/model registry 范围。
- 5 个 Codex Live/WebRTC/sideband/TCP relay 相关提交，属于尚未批准的长连接和媒体转发架构。

Codex client model catalog 新增或强化了模板回退、稳定优先级、reasoning levels、input modalities、context window、visibility、search-tool support 和 Multi-Agent V2 标记。CFlareAIProxy 已有通用模型能力元数据、公开别名继承和请求前能力校验，但尚未实现官方 Codex 客户端所需的完整 models 响应结构。该项已补充到 Issue #16，未机械移植上游的常驻内存模板缓存。

Codex Live 依赖 WebRTC、ICE/STUN、sideband、TCP candidate proxy、常驻会话和动态配置热更新，不能安全直接移植到 Workers 主服务。已建立 Issue #17 进行独立架构和威胁模型评估，本轮不修改运行代码。

## 2. 对齐程度

以下比例是工程估算，用来表达工作量和行为覆盖，不是官方兼容认证，也不是逐测试用例通过率。

- **当前目标范围（暂不包含 Claude 协议和未批准的 Codex Live）：约 73%，属于“大体对齐”。**
- **相对 CLIProxyAPI 全部产品能力：约 42%，属于“部分对齐”。**

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
| OpenAI Responses（HTTP） | 大体对齐 | 支持原生 Responses 和 Chat↔Responses 转换 | 补齐更多事件、状态和工具边界测试 |
| OpenAI Completions | 大体对齐 | 可路由 generic、Codex、Kimi | 保持兼容，不扩大旧协议特性 |
| Kimi Chat 上游 | 已对齐 | 专用 adapter，固定走 Chat Completions | 持续对比 `kimi_executor.go` |
| Kimi 模型名归一化 | 已对齐 | 去除 `[1m]` 后缀 | 跟进上游新增 suffix/alias 规则 |
| Kimi 多轮工具消息修复 | 已对齐 | 删除无效空 assistant、补 `reasoning_content`、修复 `call_id/tool_call_id` | 新增上游测试时同步移植测试语义 |
| Kimi Responses/Completions 转换 | 大体对齐 | 支持文字、图片、工具定义、tool choice 和终止事件 | 跟进新的 Responses item/event 类型 |
| Kimi 流式 usage | 大体对齐 | 自动请求 `include_usage` 并归集基础 Token | 接入规范化 Token 质量模型 |
| Codex Responses 请求归一化 | 已对齐 | 清理不兼容字段、转换 tools/tool choice、透传 Codex 会话头 | 跟进 Codex CLI 新 header 和 payload 字段 |
| Codex `response.failed/error` | 已对齐 | SSE 内嵌错误会分类为认证、权限、限额、参数或服务错误 | 对比上游新增 code/type 分类 |
| Codex 中断流检测 | 已对齐 | 未收到 `response.completed/incomplete` 时视为失败，不伪造成功 | 跟进上游中断流恢复策略 |
| Codex 最终 output 重建 | 已对齐 | 从 `response.output_item.done` 重建空的 `response.output` | 保持事件顺序测试 |
| Codex client model catalog | 部分对齐 | 已有通用 capabilities、公开别名继承和模型名回写；缺官方客户端完整 metadata 模板 | 与 Issue #16 一并设计；不复制常驻内存模板缓存 |
| Codex Multi-Agent V2 | 未对齐 | 尚未重写 `spawn_agent`、`agent_message`、collaboration namespace 和客户端模型目录 | 重大架构项，跟进 Issue #16 |
| Codex Live / WebRTC / sideband | 未对齐 | 当前仅实现 HTTP/SSE，不提供媒体 relay 或 TCP candidate proxy | 重大安全与生命周期设计，跟进 Issue #17 |
| Codex reasoning replay/signature cache | 未对齐 | 尚未实现跨请求 reasoning/signature 重放缓存 | 评估 Workers KV/DO 实现 |
| Codex Responses WebSocket | 未对齐 | Workers 网关当前仅实现 HTTP/SSE | 未单独批准前不自动移植 |
| Codex Alpha Search / 特殊路由插件 | 未对齐 | 尚未实现插件式模型选择 | 有真实使用需求后再跟进 |
| 多账号调度 | 大体对齐 | D1 存账号，Durable Object 管租约、权重、优先级、并发和会话亲和 | 跟进 credential concurrency 和选择算法变化 |
| 账号冷却与失败切换 | 大体对齐 | 认证/限额/服务错误分类后进入账号冷却或 provider 熔断 | 继续细化按错误类型的 cooldown |
| Token/OAuth 刷新锁 | 大体对齐 | 使用 Durable Object 防止同账号并发刷新 | 跟进新的 OAuth 字段和刷新失败语义 |
| 账号级代理 | 大体对齐 | `proxy_url/proxyUrl` 覆盖 provider/system proxy；支持 `direct/none` | 补齐模型发现和额度刷新使用账号代理 |
| Provider/System 代理 | 已对齐 | 原生 HTTP CONNECT、SOCKS5、TLS；失败不静默直连 | 持续跟进 Workers Socket 限制 |
| OpenAI-compatible 自定义上游 | 已对齐 | 可配置 base URL、API mode、模型、权重、Key 和代理 | 跟进通用 provider 配置能力 |
| 模型发现与公开别名 | 大体对齐 | 动态发现、静态路由和公开模型别名 | 补强不同供应商模型响应解析 |
| 模型能力元数据 | 部分对齐 | 支持 tools、images、reasoning levels、输入/输出模态和模型名回写 | 后续补 context window、search-tool、visibility 等客户端 metadata |
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

重点关键词：`response.failed`、`response.completed`、`response.output_item.done`、incomplete/disconnected stream、usage limit、capacity、context length、reasoning replay/signature、`spawn_agent`、`agent_message`、model catalog、WebRTC、sideband、ICE/STUN/TCP candidate。

### 通用 P1

- 账号选择、credential concurrency、retry/cooldown、proxy-aware client。
- provider registry、model registry、model capability。
- OAuth refresh 和并发锁。
- usage/token normalization 和 cache/tool/reasoning Token 统计。
- OpenAI-compatible provider 配置和请求/响应转换。

## 5. 不触发直接同步的变化

以下变化通常只记录，不自动修改 CFlareAIProxy：

- README、赞助商、展示项目和纯文档排版。
- 仅适用于本地 Go 进程、Gin、文件系统或 Go SDK 的实现。
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
| 2026-07-25 | `35ebe3f3..f8dffa05` | 文档更新；Issue #16 补充；Issue #17 | Codex client model catalog 属于相关变化，但现有通用 capability 已覆盖主语义，完整官方客户端 metadata 与 Multi-Agent V2 一并设计；Codex Live/WebRTC 属重大架构和安全能力，不直接合入。其余为 Claude 或纯文档变化。 |
| 2026-07-25 | `42f36b94..35ebe3f3` | `f68c71f5`；Issue #16 | credential concurrency 仅重构测试，无行为变化；新增 Codex Multi-Agent V2 属于重大架构能力，不直接合入。 |
| 2026-07-24 | 至 `42f36b94` | `4e20ae6b` | Kimi/Codex HTTP 核心与 P1 调度、错误、模型能力已大体对齐；Token canonical breakdown、Codex WebSocket/replay cache、完整多供应商范围仍未对齐。 |

## 9. 许可证与署名

CLIProxyAPI 使用 MIT License。可以参考、修改和移植其代码，但如果复制了具有实质性的代码片段，应同时保留适用的版权与 MIT 许可声明。一般情况下，本项目优先根据上游行为和测试重新实现，以适配 Cloudflare Workers 架构。
