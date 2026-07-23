# CFlareAPI 0.5.3 部署说明

## 单 Worker 架构

前端位于 `web/`，后端位于 `src/`。Vite 将管理台构建到 `dist/`，Wrangler Static Assets 与 Worker 一起上传。

```text
/admin/*       → Vue SPA Static Assets
/admin/api/*   → Hono 管理 API
/v1/*          → LLM Gateway API
/oauth/*       → OAuth 回调
```

## 本地运行

```bash
pnpm install
pnpm run doctor
pnpm run dev
```

访问 `http://127.0.0.1:8787/admin`。

`pnpm run dev` 会创建或补全 `.dev.vars`、应用本地 D1 migration、构建 Vue 管理台并启动 Wrangler。

## GitHub 连接部署

Cloudflare Dashboard → Workers & Pages → Create → Import a repository：

```text
Worker name: cflare-api
Root directory: /
Build command: pnpm run build
Deploy command: node scripts/deploy.mjs
```

必需 Secrets：

```text
MASTER_KEY
ADMIN_TOKEN
ADMIN_USERNAME
ADMIN_PASSWORD
```

`deploy.mjs` 会确保 Queue 存在，执行 `wrangler deploy`，并应用远程 D1 migrations。D1 与 KV 使用 Wrangler 自动资源配置，不要在模板中填写假的资源 ID。

## 代理

0.5.3 使用 Cloudflare Worker 原生 TCP 连接 HTTP/SOCKS5 代理，无需 `PROXY_BRIDGE_URL` 或 `PROXY_BRIDGE_TOKEN`。

管理台只填写：

```text
http://user:pass@host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

代理启用后不会静默直连回退。部署完成后应在管理台执行“验证出口 IP”，确认代理出口与 Worker 直连出口不同。

`proxy-bridge/` 目录与相关脚本仅为旧部署兼容保留。

## 升级到 0.5.3

建议解压到新目录，再复制本地密钥：

```powershell
Copy-Item ..\CFlareAPI-old\.dev.vars .\.dev.vars
pnpm install
pnpm run doctor
pnpm run dev
```

0.5.3 会应用 `migrations/0006_routing_cache_prices.sql`：

- `model_prices.cache_micros_per_million`：缓存命中价格；
- `request_logs.cached_tokens`：缓存 Token 用量。

现有账号、模型、路由、价格和日志均保留；新增字段默认值为 0。

## 发布前检查

```bash
pnpm run doctor
pnpm run check
pnpm run config:check
pnpm run smoke:admin
```
