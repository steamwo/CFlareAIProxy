# CFlareAPI

CFlareAPI 是运行在 Cloudflare Workers 上的多账号 LLM API 网关，对外提供 OpenAI-compatible API，并由同一个 Worker 交付 Vue 3 管理台。

## 0.5.3 的核心能力

- **内置渠道**：Codex、Kimi、Qoder、OpenCode Zen。协议、OAuth、官方端点和模型发现由代码维护。
- **OpenAI-compatible 供应商**：测试 API Key、读取 `/models`、勾选公开模型、设置客户端别名和供应商权重。
- **可用性路由**：先过滤额度耗尽、账号冷却和供应商熔断节点，再按优先级主备、同级权重分流。
- **原生代理**：只填写 HTTP/SOCKS5 Proxy URL；OAuth 换取/刷新 Token、模型、额度和推理请求共用同一代理出口，不再静默直连回退。
- **完整计费**：模型价格分别设置输入、输出和缓存命中 Token；请求日志记录缓存 Token 并据此计算成本。
- **Qoder 修复**：授权轮询、账号导入、个人/组织额度和重置时间正常工作。
- **账号卡片**：每个账号独立显示状态、调度参数、额度、错误和恢复信息。

## API

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
POST /v1/completions
```

## 快速开始

需要 Node.js 20.19 或更高版本。

```bash
pnpm install
pnpm run doctor
pnpm run dev
```

管理台：

```text
http://127.0.0.1:8787/admin
```

首次运行会创建 `.dev.vars`、初始化本地 D1、构建管理台并启动 Wrangler。

## 管理台怎么用

- **内置渠道**：启停 Codex、Kimi、Qoder、OpenCode Zen，设置账号池策略和渠道代理。
- **OpenAI 供应商**：填写 Base URL 与 API Key，先测试并获取模型；勾选要公开的上游模型，按需改成更短的客户端模型名，并设置供应商权重。
- **账号池**：添加 Key、导入 OAuth、发起授权，设置账号优先级/权重/并发，查看模型和额度。
- **模型路由**：查看自动生成的线路和实时可用状态；高级场景再添加手动主备线路。
- **模型价格**：分别维护输入、输出、缓存命中价格。
- **网关密钥**：限制 RPM、并发、月 Token 和可用模型。
- **系统设置**：设置默认 Proxy URL，并验证 Worker 直连 IP 与代理出口 IP。

## OpenAI-compatible 供应商

创建供应商时填写：

```text
ID: openai-main
名称: OpenAI 主线路
Base URL: https://api.openai.com/v1
API Key: sk-...
供应商权重: 3
```

点击“测试 API Key 并获取模型”后：

1. 勾选要对客户端公开的上游模型；
2. “公开模型名”可保持原名，也可映射成 `coding-fast` 等别名；
3. 保存后自动生成对应模型路由；
4. 多个供应商映射到同一公开模型名、且优先级相同时，按供应商权重分流。

未勾选的模型不会自动暴露。编辑供应商时 API Key 留空会使用已有启用账号测试；填写新 Key 会追加到账号池。

## 模型路由

模型路由就是“客户端模型名 → 实际供应商与上游模型”的映射。

```text
客户端请求 coding-fast
  ├─ 优先级 10：provider-a / model-x，权重 3
  ├─ 优先级 10：provider-b / model-y，权重 1
  └─ 优先级 20：provider-c / model-z，备用
```

运行规则：

1. 先排除禁用、额度耗尽和冷却中的账号；
2. 排除处于熔断期的供应商；
3. 使用数字最小的可用优先级；
4. 同一优先级按权重分流；
5. 主线路不可用时自动尝试下一线路；供应商恢复成功后自动回到可用池。

OpenAI 供应商的常规模型选择、别名和权重直接在供应商页面完成。“模型路由”页面主要用于跨供应商主备、同名聚合和高级覆盖。

## 代理与 Codex 403

支持：

```text
http://user:pass@host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

HTTPS 上游通过 HTTP CONNECT 或 SOCKS5 隧道访问，所以 HTTP 代理仍填写 `http://`，不要填写 `https://`。代理启用后请求失败会明确报错，**不会回退到 Cloudflare 直连出口**。

渠道代理覆盖系统默认代理。Codex 授权码换 Token、刷新 Token、模型、额度和推理均使用 Codex 渠道的最终代理配置。

在代理编辑器点击“验证出口 IP”：

- `代理出口 IP` 与 `Worker 直连 IP` 不同：代理链路已改变出口；若 Codex 仍返回 403，通常是该代理出口或 Token 本身被上游拒绝。
- 两个 IP 相同：代理没有真正改变出口，应检查代理服务或地址。

`proxy-bridge/` 仅为旧部署兼容保留，0.5.3 不需要配置 Bridge。

## Codex 管理台授权

1. 在账号池发起 Codex 授权；
2. 登录后浏览器跳转到 `http://localhost:1455/auth/callback?...`；
3. 本机未监听时页面无法访问是正常现象；
4. 把地址栏完整回调 URL 粘贴回管理台；
5. Worker 使用原 PKCE 会话，并通过 Codex 渠道代理换取 Token。

授权 JSON、`pnpm run codex:login` 和 `pnpm run oauth:loopback` 仍可作为备用方式。

## 构建和部署

```bash
pnpm run build
pnpm run deploy
```

Cloudflare Dashboard 推荐：

```text
Root directory: /
Build command: pnpm run build
Deploy command: node scripts/deploy.mjs
```

部署会上传 Worker 后端、Vue 静态资源，并使用 D1、KV、Durable Objects 与 Queues。

## 升级

0.5.3 新增 migration `0006_routing_cache_prices.sql`，部署脚本会应用它，为模型价格增加缓存价格，为请求日志增加缓存 Token 字段。

## 验证

```bash
pnpm run doctor
pnpm run check
pnpm run smoke:admin
```

## 文档

- [部署说明](DEPLOYMENT.md)
- [代理说明](docs/PROVIDER_PROXY.md)
- [管理端架构](docs/ADMIN_UI.md)
- [Codex 本地授权](docs/CODEX_LOCAL_AUTH.md)
- [OpenCode Zen 上游](docs/OPENCODE_UPSTREAM.md)
- [验证记录](VALIDATION.md)

## 安全

- 上游 Token、API Key 和 Proxy URL 使用 `MASTER_KEY` 进行 AES-GCM 加密。
- 网关 Key 仅保存哈希。
- 管理登录使用 HttpOnly Cookie。
- 默认不保存完整提示词和输出。
- 内置渠道配置由代码注册表固定，数据库中的端点篡改不会进入运行时。
