<div align="center">
  <img src="web/public/logo.svg" width="96" alt="CFlareAIProxy logo" />
  <h1>CFlareAIProxy</h1>
  <p><strong>运行在 Cloudflare Workers 上的多账号 LLM API 网关与控制台</strong></p>
  <p>一个 Worker，统一接入 Codex、Kimi、Qoder、OpenCode Zen 与任意 OpenAI-compatible 上游。</p>

  <p>
    <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" />
    <img alt="Vue" src="https://img.shields.io/badge/Vue-3.5-42B883?logo=vuedotjs&logoColor=white" />
    <img alt="Hono" src="https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white" />
    <img alt="License" src="https://img.shields.io/github/license/steamwo/CFlareAIProxy" />
  </p>
</div>

> [!IMPORTANT]
> 本文档对应 **`dev` 分支**。该分支可能领先于 `main`，适合测试最新路由、协议适配和管理端能力；生产升级前请先阅读 [部署与升级指南](DEPLOYMENT.md) 并执行完整校验。

## CFlareAIProxy 能做什么

CFlareAIProxy 把不同上游的授权方式、请求协议、账号池和故障语义收敛成统一的 OpenAI-compatible API。客户端只持有网关 Key，上游 OAuth Token、API Key 和代理地址均由服务端加密保存。

| 能力 | 说明 |
| --- | --- |
| **统一 API** | 提供 `/v1/models`、`/v1/responses`、`/v1/chat/completions` 与 `/v1/completions`。 |
| **内置渠道适配** | Codex、Kimi、Qoder、OpenCode Zen 使用独立 adapter，不是简单改写 Base URL。 |
| **自定义上游** | 添加任意 OpenAI-compatible 服务，测试 API Key、发现模型、选择公开模型并设置别名。 |
| **多账号调度** | 支持优先级、权重、最大并发、会话亲和、额度摘除、账号冷却与自动 Token 刷新。 |
| **弹性路由** | 数字更小的优先级先使用；同级按权重分流；线路失败时切换账号、供应商或备用路由。 |
| **能力感知** | 模型目录可暴露 tools、图片、推理等级和输入/输出模态；请求进入上游前会做能力校验。 |
| **原生代理** | Worker 原生 HTTP CONNECT / SOCKS5；支持账号、供应商和系统三级代理策略及 `direct`/`none` 覆盖。 |
| **限流与成本** | 每个网关 Key 可限制 RPM、并发、月 Token 和模型范围；日志记录缓存 Token 与估算费用。 |
| **一体化管理台** | Vue 3 SPA 与 Hono API 由同一个 Worker 提供，无需单独部署前端和跨域服务。 |

## 架构

```mermaid
flowchart LR
  C[OpenAI-compatible 客户端] --> W[Cloudflare Worker / Hono]
  W --> A[网关 Key 鉴权与限流]
  A --> R[模型路由与健康检查]
  R --> P[Provider Adapter]
  P --> U1[Codex]
  P --> U2[Kimi]
  P --> U3[Qoder]
  P --> U4[OpenCode Zen]
  P --> U5[OpenAI-compatible 上游]

  W --> S[Vue 3 管理台 / Static Assets]
  W --> D[(D1)]
  W --> K[(KV 配置缓存)]
  W --> Q[Queue 异步用量写入]
  A --> DO1[RateLimiter Durable Object]
  R --> DO2[AccountPool Durable Object]
```

核心资源：

- **D1**：供应商、加密凭据、模型目录、额度快照、路由、网关 Key、价格与请求日志；
- **Durable Objects**：账号租约、并发控制、会话亲和、刷新锁和网关限流；
- **KV**：短时配置缓存；
- **Queues**：将用量与费用写入移出响应主链路；
- **Static Assets**：同域交付 `/admin` 管理台。

## 支持的上游

| 上游 | 授权 | 上游协议处理 | 备注 |
| --- | --- | --- | --- |
| **OpenAI Codex** | PKCE OAuth / 授权 JSON / 本地助手 | Responses 为主，Chat 与 Completions 自动转换 | 支持流式错误识别、完成事件检查和输出重建。 |
| **Kimi Coding** | Device OAuth | Chat、Responses、Completions 转换 | 处理工具消息关联、模型名归一化和流式 usage。 |
| **Qoder** | PKCE Device OAuth | Qoder 专用请求与 SSE | 内置 COSY 签名、模型发现和个人/组织额度。 |
| **OpenCode Zen** | API Key / 匿名免费模型 | Responses、Anthropic Messages、Google GenerateContent、Chat | 官方线路失败后可按配置尝试镜像线路。 |
| **OpenAI-compatible** | API Key | Chat、Responses 或 both | 可发现模型、设置公开别名、权重和代理。 |

> [!NOTE]
> 对外 API 仍以 OpenAI-compatible 为主。Anthropic / Google 协议是 OpenCode Zen adapter 的内部上游转换，不代表网关对外提供完整 Claude 或 Gemini 原生 API。

## 快速开始

### 环境要求

- Node.js `>= 20.19`
- pnpm `11.9.x`
- 一个可用的 Cloudflare 账号（远程部署时）

```bash
git clone https://github.com/steamwo/CFlareAIProxy.git
cd CFlareAIProxy
git switch dev
pnpm install
pnpm run doctor
pnpm run dev
```

本地管理台：

```text
http://127.0.0.1:8787/admin
```

`pnpm run dev` 会创建或补全 `.dev.vars`、应用本地 D1 migrations、构建管理台并启动 Wrangler。

首次登录至少需要：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请设置强密码
```

`MASTER_KEY` 与 `ADMIN_TOKEN` 在本地缺失时可由项目脚本生成。不要提交 `.dev.vars`。

## 三分钟完成首次请求

1. 打开 `/admin`，登录管理台；
2. 在“内置渠道”启用需要的渠道，或在“OpenAI 供应商”添加 Base URL 与 API Key；
3. 在“授权”完成 OAuth，或在供应商页面测试 Key 并选择公开模型；
4. 在“网关密钥”创建客户端 Key；
5. 调用模型目录并发送请求。

```bash
export CFLARE_BASE_URL="http://127.0.0.1:8787/v1"
export CFLARE_API_KEY="cfp_xxx"

curl "$CFLARE_BASE_URL/models" \
  -H "Authorization: Bearer $CFLARE_API_KEY"
```

```bash
curl "$CFLARE_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coding-fast",
    "messages": [{"role": "user", "content": "用一句话解释 Durable Objects"}],
    "stream": false
  }'
```

也可以直接使用 OpenAI SDK，只需替换 `base_url` / `baseURL`。完整示例见 [API 与客户端接入](docs/API_USAGE.md)。

## 路由如何工作

```text
客户端模型 coding-fast
  ├─ priority 10 · provider-a/model-x · weight 3
  ├─ priority 10 · provider-b/model-y · weight 1
  └─ priority 20 · provider-c/model-z · 备用
```

请求执行顺序：

1. 校验网关 Key 的模型范围、RPM、并发和月 Token；
2. 选择数字最小且健康的路由优先级；
3. 同级路由按权重排序与分流；
4. 排除禁用、额度耗尽、冷却中或模型不可用的账号；
5. 通过账号池分配凭据，并在需要时使用刷新锁更新 OAuth Token；
6. 对可重试错误切换账号或下一条路由；连续网络/5xx 失败会触发供应商熔断；
7. 流结束后释放租约，并异步写入 usage、延迟和费用。

客户端可传 `X-Session-Id` 或 `X-Conversation-Id`，帮助开启会话亲和的渠道尽量复用同一账号。

## 模型能力元数据

`GET /v1/models` 可能为模型附加非标准扩展字段：

```json
{
  "id": "coding-fast",
  "object": "model",
  "x_cflare_capabilities": {
    "inputModalities": ["text", "image"],
    "outputModalities": ["text"],
    "reasoningLevels": ["low", "medium", "high"],
    "supportsTools": true,
    "supportsImages": true
  }
}
```

网关会在转发前拒绝明确不支持的 tools、图片输入或 reasoning level，避免把无效请求消耗到上游。

## 代理策略

优先级从高到低：

```text
账号 proxy_url / proxyUrl
        ↓ 未设置
供应商或内置渠道 Proxy URL
        ↓ 未设置
系统默认 Proxy URL
        ↓ 未设置
Worker 直连
```

账号级值设为 `direct` 或 `none` 时，会明确跳过供应商与系统代理。支持：

```text
http://user:pass@host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

代理一旦选中，失败会明确返回错误，**不会静默回退直连**。详见 [代理与出口策略](docs/PROVIDER_PROXY.md)。

## 部署

```bash
pnpm run build
pnpm run deploy
```

Cloudflare Git 连接推荐配置：

```text
Production branch: main（或你明确用于生产的分支）
Root directory: /
Build command: pnpm run build
Deploy command: node scripts/deploy.mjs
```

`node scripts/deploy.mjs` 不只是上传 Worker，它还会确保远程 Queue、初始化缺失的关键 Secret、应用 D1 migrations 并验证 schema。不要在生产部署中用裸 `wrangler versions upload` 替代它。

部署后检查：

```bash
curl https://你的-worker地址/health
```

正常响应应包含：

```json
{
  "status": "ok",
  "database": "ok"
}
```

完整步骤、变量说明、故障排查和升级流程见 [部署与升级指南](DEPLOYMENT.md)。

## 管理台导航

- **概览**：请求量、成功率、成本与近期运行状态；
- **内置渠道**：启停 Codex、Kimi、Qoder、OpenCode Zen；
- **OpenAI 供应商**：配置自定义上游、Key、模型公开范围与权重；
- **授权**：集中处理 OAuth、设备授权与授权 JSON 导入；
- **账号池**：账号状态、额度、并发、优先级、权重和错误恢复；
- **实际模型 / 模型路由**：查看上游目录、能力元数据、别名和主备线路；
- **网关密钥**：按客户端限制 RPM、并发、月 Token 与模型范围；
- **模型价格 / 请求日志**：维护输入、输出、缓存价格并追踪 usage、延迟和错误；
- **系统设置**：默认代理、出口验证与全局配置。

详见 [管理台说明](docs/ADMIN_UI.md)。

## 安全模型

- 上游 Token、API Key 和 Proxy URL 使用 `MASTER_KEY` 进行 AES-GCM 加密；
- 网关 Key 只保存哈希，完整值仅在创建时显示一次；
- 管理台使用 HttpOnly Cookie，同域部署避免额外的跨域凭据风险；
- 默认不保存完整提示词和模型输出；
- 内置渠道端点、OAuth 配置和协议规则由代码注册表固定；
- 代理配置不会在管理接口中回显完整认证信息；
- `.dev.vars`、`.cflare/auth/` 和其他本地凭据文件不得提交到 Git。

## 校验

```bash
pnpm run doctor
pnpm run check
pnpm run config:check
pnpm run smoke:admin
```

`pnpm run check` 会覆盖配置检查、管理台静态检查、Worker/Web 类型检查和 Vitest。发布前清单见 [验证与发布检查](VALIDATION.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [API 与客户端接入](docs/API_USAGE.md) | Curl、OpenAI SDK、流式请求、错误格式和模型能力字段。 |
| [部署与升级指南](DEPLOYMENT.md) | 本地运行、Cloudflare 部署、资源、Secret、migration 与排障。 |
| [管理台说明](docs/ADMIN_UI.md) | 页面职责、账号与供应商边界、路由和登录架构。 |
| [代理与出口策略](docs/PROVIDER_PROXY.md) | 账号/供应商/系统代理优先级、协议和失败行为。 |
| [模型、配额与 OpenCode](docs/MODELS_QUOTAS_OPENCODE.md) | 动态模型、能力元数据、额度快照和 OpenCode 双向概念。 |
| [Codex 授权](docs/CODEX_LOCAL_AUTH.md) | 管理台 PKCE、本地助手、CLI 同步与代理。 |
| [OpenCode Zen 适配](docs/OPENCODE_UPSTREAM.md) | 多协议转换、匿名模型、官方/镜像故障转移。 |
| [CLIProxyAPI 对齐记录](COPY.md) | 行为参考范围、明确差异和后续同步规则。 |
| [变更记录](CHANGELOG.md) | 已发布版本与 `dev` 分支开发变化。 |

## 项目边界

CFlareAIProxy 关注的是 **Cloudflare 原生部署、统一 OpenAI-compatible 接口、多账号调度和可视化运维**。它不会机械复制本地 Go 网关的所有能力，也不会把尚未完整实现的 Claude、Gemini、Grok 或 Responses WebSocket 宣称为兼容。

## License

本项目按 [LICENSE](LICENSE) 中的条款发布。