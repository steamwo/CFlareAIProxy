# 部署与升级指南

本文档对应 `dev` 分支，覆盖本地开发、Cloudflare 远程部署、资源初始化、Secret、D1 migration、预览版本和常见故障。

## 1. 部署架构

CFlareAIProxy 使用单 Worker 架构：

```text
/admin/*       → Vue 3 SPA / Cloudflare Static Assets
/admin/api/*   → Hono 管理 API
/v1/*          → OpenAI-compatible 网关 API
/oauth/*       → OAuth 回调与授权流程
/health        → Worker 与 D1 健康检查
```

Cloudflare 资源：

| Binding | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 | 供应商、凭据、模型、额度、路由、网关 Key、价格和日志。 |
| `CONFIG_CACHE` | KV | 短时配置缓存。 |
| `USAGE_QUEUE` | Queue | 异步写入 usage 和费用。 |
| `ACCOUNT_POOL` | Durable Object | 账号租约、并发、权重、会话亲和与刷新锁。 |
| `RATE_LIMITER` | Durable Object | 网关 Key 的 RPM、并发和月 Token 限制。 |
| `ASSETS` | Static Assets | `/admin` 管理台构建产物。 |

Wrangler 会根据 `wrangler.jsonc` 自动配置 D1、KV、Durable Objects 和 Static Assets。部署脚本会额外确保 usage Queue 与 dead-letter Queue 存在。

## 2. 环境要求

- Node.js `>= 20.19`
- pnpm `11.9.x`
- Cloudflare 账号与 Wrangler 登录（远程部署）

```bash
node --version
pnpm --version
pnpm exec wrangler whoami
```

安装依赖：

```bash
pnpm install --frozen-lockfile
```

本地开发时也可以使用普通 `pnpm install`。

## 3. 本地运行

```bash
pnpm install
pnpm run doctor
pnpm run dev
```

访问：

```text
http://127.0.0.1:8787/admin
```

`pnpm run dev` 会：

1. 创建或补全 `.dev.vars`；
2. 应用本地 D1 migrations；
3. 构建 Vue 管理台；
4. 启动 Wrangler 本地 Worker。

本地最小配置：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请设置强密码
```

`MASTER_KEY` 与 `ADMIN_TOKEN` 缺失时，本地脚本会生成可用值。`.dev.vars` 包含敏感信息，不得提交到 Git。

## 4. 配置与 Secret

### 必需或推荐的 Secret

| 名称 | 是否必须 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 必须 | 管理台登录密码，应由部署者设置。 |
| `MASTER_KEY` | 必须 | 恰好 32 字节随机值的 Base64，用于 AES-GCM 加密上游凭据和代理地址。 |
| `ADMIN_TOKEN` | 必须 | 管理会话签名和自动化鉴权。 |
| `ADMIN_USERNAME` | 推荐 | 默认值为 `admin`。可作为普通变量或 Secret。 |

远程部署时，`node scripts/deploy.mjs` 会检查 Worker Secret：

- `MASTER_KEY` 缺失时生成 32 字节随机值并 Base64 编码；
- `ADMIN_TOKEN` 缺失时生成 32 字节随机值并输出为 hex；
- 已存在的值会保留，不会在每次部署时轮换；
- 临时 secrets 文件使用受限权限写入并在命令结束后删除；
- 生成值不会打印到日志。

`ADMIN_PASSWORD` 不会自动生成。首次部署前应主动设置：

```bash
pnpm exec wrangler secret put ADMIN_PASSWORD
```

可选设置用户名：

```bash
pnpm exec wrangler secret put ADMIN_USERNAME
```

### 普通变量

`wrangler.jsonc` 当前提供：

```text
APP_NAME=CFlareAIProxy
MAX_BODY_BYTES=8388608
DEFAULT_RPM=60
DEFAULT_CONCURRENCY=8
DEFAULT_MONTHLY_TOKENS=0
CREDENTIAL_COOLDOWN_MS=60000
PUBLIC_BASE_URL=
```

说明：

- `MAX_BODY_BYTES`：网关 JSON 请求体上限，默认 8 MiB；
- `DEFAULT_*`：创建网关 Key 时的默认限制；
- `CREDENTIAL_COOLDOWN_MS`：账号失败后的基础冷却时间；
- `PUBLIC_BASE_URL`：需要显式生成公网回调或客户端配置时使用。

### 可选运行时变量

代码还支持按需要设置：

```text
OPENCODE_MIRRORS_URL   # 额外 OpenCode 镜像，使用逗号或换行分隔
```

历史变量 `PROXY_BRIDGE_URL` 与 `PROXY_BRIDGE_TOKEN` 仅用于旧部署兼容。当前 Worker 原生支持 HTTP CONNECT / SOCKS5，不需要 Proxy Bridge。

## 5. 推荐部署方式

### 方式 A：本地命令部署

先登录 Cloudflare：

```bash
pnpm exec wrangler login
```

执行：

```bash
pnpm run build
pnpm run deploy
```

`pnpm run deploy` 等价于构建后运行 `node scripts/deploy.mjs`。

部署脚本会按顺序：

1. 检查并创建 `cflare-api-usage`；
2. 检查并创建 `cflare-api-usage-dlq`；
3. 检查远程 `ADMIN_TOKEN` 与 `MASTER_KEY`；
4. 上传 Worker、Durable Objects 配置和 Vue Static Assets；
5. 应用 `migrations/` 中尚未执行的远程 D1 migrations；
6. 查询 `providers` 表验证数据库 schema。

成功日志末尾应包含：

```text
• 应用远程 D1 迁移...
• 验证远程 D1 schema...
✓ CFlareAIProxy 部署、密钥初始化和数据库迁移完成
```

### 方式 B：Cloudflare Git 连接

Cloudflare Dashboard → Workers & Pages → Create → Import a repository：

```text
Root directory: /
Build command: pnpm run build
Deploy command: node scripts/deploy.mjs
```

生产分支应设置为你真正用于生产的分支。仓库默认分支是 `main`；使用 `dev` 作为生产分支前，应明确接受它可能包含尚未发布的变化。

> [!IMPORTANT]
> Deploy command 必须执行 `node scripts/deploy.mjs`。裸 `wrangler deploy` 只上传代码，不会执行项目的远程资源检查和 D1 schema 验证；`wrangler versions upload` 也不会自动应用远程 migrations。

Cloudflare Builds 使用 pnpm 11 时应使用 Node.js 20.19 或更高版本。仓库 CI 当前使用 Node.js 22 与 pnpm 11.9。

## 6. 部署后检查

### 健康检查

```bash
curl https://你的-worker地址/health
```

正常结果：

```json
{
  "status": "ok",
  "service": "CFlareAIProxy",
  "database": "ok",
  "time": "2026-01-01T00:00:00.000Z"
}
```

`database` 状态：

| 值 | 含义 |
| --- | --- |
| `ok` | D1 binding 可用且核心表存在。 |
| `schema_missing` | D1 可访问，但尚未应用 migration。 |
| `error` | D1 binding、权限或查询发生其他错误。 |

### 管理台检查

1. 打开 `https://你的-worker地址/admin`；
2. 使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录；
3. 确认“概览”可加载；
4. 创建一个限制严格的测试网关 Key；
5. 调用 `/v1/models`；
6. 发起一次非流式模型请求；
7. 在“请求日志”确认请求 ID、模型、状态和用量。

## 7. D1 未初始化或版本落后

### `DATABASE_NOT_INITIALIZED`

管理接口返回 `DATABASE_NOT_INITIALIZED`，或 `/health` 显示 `schema_missing`：

```bash
pnpm exec wrangler d1 migrations apply DB --remote --yes
pnpm exec wrangler d1 execute DB --remote --yes \
  --command "SELECT COUNT(*) AS provider_count FROM providers"
```

### `DATABASE_MIGRATION_REQUIRED`

出现缺少字段、`no such column` 或 `has no column named`：

```bash
pnpm exec wrangler d1 migrations list DB --remote
pnpm exec wrangler d1 migrations apply DB --remote --yes
```

应用 migration 后通常不需要修改数据。为了确保 Worker 与 schema 同步，建议重新运行：

```bash
node scripts/deploy.mjs
```

### Binding 名称问题

项目代码固定读取 `DB` binding。若 Cloudflare Dashboard 中绑定名称不是 `DB`，应修正 binding，而不是修改 SQL 命令去掩盖配置错误。

## 8. Queue 问题

项目需要：

```text
cflare-api-usage
cflare-api-usage-dlq
```

手动检查：

```bash
pnpm exec wrangler queues list
```

自动创建：

```bash
pnpm run resources:ensure
```

如果推理成功但日志迟迟不出现，应检查 Queue consumer、dead-letter Queue 和 Worker 日志。请求响应不会等待 D1 usage 写入完成。

## 9. 代理部署说明

当前版本在 Worker 内使用 `cloudflare:sockets` 建立 HTTP CONNECT 或 SOCKS5 隧道。

支持：

```text
http://user:pass@host:port
socks5://user:pass@host:port
socks5h://user:pass@host:port
```

无需部署 `proxy-bridge/`。该目录和相关脚本只为旧环境保留。

代理配置优先级：

```text
账号级代理
  ↓
供应商/内置渠道代理
  ↓
系统默认代理
  ↓
Worker 直连
```

账号级设置为 `direct` 或 `none` 会跳过后续代理。选中的代理失败时不会静默回退直连。

部署后请在管理台执行“验证出口 IP”，确认代理出口与 Worker 直连出口符合预期。详见 [代理与出口策略](docs/PROVIDER_PROXY.md)。

## 10. 预览版本

```bash
pnpm run preview
```

该命令使用 `wrangler versions upload`，适合上传预览版本，但不会：

- 创建远程 Queue；
- 初始化 `ADMIN_TOKEN` / `MASTER_KEY`；
- 应用远程 D1 migrations；
- 验证远程 schema。

预览版本依赖的远程资源必须已经由正式部署准备完成。涉及新 migration 的分支不要只上传预览版本后直接判断功能是否正常。

## 11. 从旧版本升级

升级前建议：

1. 记录当前 Worker、D1 和生产分支；
2. 备份本地 `.dev.vars` 与 `.cflare/auth/`；
3. 不要手工复制 `dist/` 或 `node_modules/`；
4. 阅读 [CHANGELOG.md](CHANGELOG.md) 和 migration 文件；
5. 先在预览或独立 Worker / D1 环境验证。

更新代码：

```bash
git fetch origin
git switch dev
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run doctor
pnpm run check
pnpm run build
```

本地 D1：

```bash
pnpm run db:migrate:local
```

远程部署：

```bash
pnpm run deploy
```

D1 migrations 使用增量方式执行，不应删除现有账号、模型、路由、价格和日志。仍建议在重大升级前使用 Cloudflare 提供的 D1 备份或导出能力保留恢复点。

## 12. 回滚注意事项

Worker 代码可以回滚到旧版本，但 D1 migration 通常不会自动回滚。若新代码写入了旧版本无法识别的字段或数据：

- 优先修复并前滚；
- 不要直接删除 migration 记录；
- 在确认数据兼容前，不要把生产 Worker 回滚到早于 schema 变化的版本；
- 必要时从升级前备份恢复独立 D1，再切换 binding。

## 13. 发布前检查

```bash
pnpm run doctor
pnpm run check
pnpm run config:check
pnpm run smoke:admin
```

推荐再执行：

```bash
pnpm run build
```

GitHub Actions 的 `check.yml` 会执行配置检查、Web 静态检查、Worker/Web 类型检查、Vitest、生产构建和 Wrangler dry-run。

完整清单见 [验证与发布检查](VALIDATION.md)。