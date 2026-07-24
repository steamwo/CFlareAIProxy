# 验证与发布检查

本文档是 `dev` 分支的可重复验证清单。它不把某一次沙箱运行结果当作永久结论；每次准备合并或发布时都应重新执行，并在 PR / Release 中记录真实输出。

## 1. 一键检查

```bash
pnpm install --frozen-lockfile
pnpm run doctor
pnpm run check
pnpm run config:check
pnpm run build
pnpm run smoke:admin
```

命令职责：

| 命令 | 覆盖内容 |
| --- | --- |
| `pnpm run doctor` | Node、依赖、本地变量、版本一致性和基础环境。 |
| `pnpm run check` | 配置检查、Web 静态检查、Worker/Web 类型检查、Vitest。 |
| `pnpm run config:check` | Wrangler deploy dry-run。 |
| `pnpm run build` | Worker/Web 类型检查与 Vite production build。 |
| `pnpm run smoke:admin` | 管理 API 和管理台关键路径 smoke test。 |

如果依赖、Cloudflare 登录或远程资源不可用，应明确记录“未执行”与原因，不要写成“通过”。

## 2. GitHub Actions

`.github/workflows/check.yml` 在 pull request 和 `main` push 上执行：

1. `pnpm install --frozen-lockfile`；
2. `node scripts/check-config.mjs`；
3. `node scripts/check-web.mjs`；
4. Worker / Web TypeScript typecheck；
5. Vitest；
6. Vite production build；
7. Wrangler dry-run；
8. 汇总步骤结果并在任一步骤失败时让 Job 失败。

CI 使用 Node.js 22 与 pnpm 11.9。Cloudflare Builds 也应使用 Node.js 20.19 或更高版本。

## 3. 配置与构建检查

必须确认：

- `package.json` 版本与管理 API 暴露版本一致；
- `wrangler.jsonc` 中 Worker、D1、KV、Queue、Durable Objects 与 Assets binding 完整；
- Static Assets 的 `run_worker_first` 覆盖 `/v1/*`、`/admin/api/*`、`/oauth/*` 和 `/health`；
- `web/public/_headers` 不阻断管理台静态资源；
- Vite 输出可由 Wrangler dry-run 正确收集；
- `.dev.vars`、`.cflare/auth/`、`dist/`、测试输出和临时 Secret 不进入发布源码。

## 4. 数据库检查

### 空库 migration

所有 `migrations/*.sql` 应能按编号在空数据库顺序执行。

本地：

```bash
pnpm run db:migrate:local
```

远程：

```bash
pnpm exec wrangler d1 migrations list DB --remote
pnpm exec wrangler d1 migrations apply DB --remote --yes
```

核心 schema 检查：

```bash
pnpm exec wrangler d1 execute DB --remote --yes \
  --command "SELECT COUNT(*) AS provider_count FROM providers"
```

还应确认当前代码读取的新增字段已经存在，例如模型能力、缓存价格和缓存 Token 相关列。

### 升级库

从上一发布版本的真实 schema 升级时，确认：

- 现有 providers、credentials、routes、prices、keys 和 logs 保留；
- 新字段有安全默认值；
- migration 可重复检测，不会重复破坏数据；
- 旧 Worker 回滚与新 schema 的兼容风险已评估。

## 5. 网关 API smoke test

准备一个测试网关 Key 和至少一个可用模型。

### 健康检查

```bash
curl https://gateway.example.com/health
```

预期：

```json
{
  "status": "ok",
  "database": "ok"
}
```

### 模型目录

```bash
curl https://gateway.example.com/v1/models \
  -H "Authorization: Bearer $CFLARE_API_KEY"
```

确认：

- 只返回该 Key 允许的模型；
- 路由别名可见；
- 有能力数据的模型返回 `x_cflare_capabilities`；
- 未授权请求返回统一错误格式。

### Chat 非流式与流式

```bash
curl https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"coding-fast","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

```bash
curl -N https://gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"coding-fast","messages":[{"role":"user","content":"ping"}],"stream":true}'
```

确认：

- 响应包含 `x-request-id`；
- 流正常结束，不把上游中断伪装为成功；
- 请求日志出现 provider、credential、模型、状态、延迟和 usage；
- 账号与 rate limiter 租约最终释放。

### Responses

至少对 Codex 和一个需要协议转换的渠道分别测试：

```bash
curl https://gateway.example.com/v1/responses \
  -H "Authorization: Bearer $CFLARE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"coding-fast","input":"ping","stream":false}'
```

## 6. 模型能力验证

至少覆盖：

- `supportsTools=false` 时 tools 请求返回 `MODEL_TOOLS_UNSUPPORTED`；
- 不支持图片时图片输入返回 `MODEL_IMAGE_INPUT_UNSUPPORTED`；
- 不支持的 reasoning level 返回 `MODEL_REASONING_LEVEL_UNSUPPORTED`；
- 公开别名模型可以继承上游发现能力；
- 路由级能力配置覆盖发现数据；
- 客户端忽略 `x_cflare_capabilities` 时标准模型字段仍可使用。

相关测试应覆盖 `src/model-capabilities.ts` 与公开路由模型。

## 7. 路由与账号池验证

至少覆盖：

- 数字更小的 priority 先使用；
- 同 priority 的 weight 生效；
- 一个账号失败后可尝试同 provider 的其他账号；
- 主线路不可用时进入备用 priority；
- quota 耗尽账号被摘除；
- 401 / 403 / 429 / 5xx 按分类进入冷却或 provider 熔断；
- provider 成功后清除熔断状态；
- `X-Session-Id` / `X-Conversation-Id` 会参与会话亲和；
- 并发租约在成功、非流式失败、流式失败和客户端取消时释放。

## 8. OAuth 与 Token 刷新

### Codex

- 管理台创建 PKCE 会话；
- 粘贴 localhost 完整回调 URL；
- state / verifier 校验；
- 通过最终代理完成 code exchange；
- 403 时错误提示指向本地助手；
- `codex:sync` 更新同一 credential；
- Token 即将过期时推理链路自动刷新；
- 同 credential 并发刷新被 Durable Object lock 阻止。

### Kimi

- Device OAuth 轮询；
- Chat / Responses / Completions 转换；
- tools 与 tool result 关联；
- 流式 usage；
- 模型后缀归一化。

### Qoder

- 设备授权 202 / 404 等待语义；
- 短暂网络错误重试；
- COSY 签名请求；
- 模型发现；
- 个人与组织额度、重置时间。

## 9. OpenCode 验证

至少覆盖：

- 无 Key 时只公开实时匿名免费模型；
- 有 Key 时先尝试官方 Zen；
- 官方失败后按候选镜像故障转移；
- 镜像起点轮换；
- `mirror_urls` 与 `OPENCODE_MIRRORS_URL` 合并、去重并过滤非法 URL；
- 官方认证/限额失败在镜像成功时仍记录到账号健康；
- Responses、Anthropic、Google 与 Chat 协议路径；
- tools、函数调用、usage 和流式结束事件转换；
- 官方与镜像都遵守账号/provider/system 代理策略。

仓库中的 `test/opencode-failover.test.ts` 应保持覆盖镜像顺序与失败语义。

## 10. 代理验证

测试层级：

```text
账号代理
供应商/渠道代理
系统代理
直连
```

必须覆盖：

- 账号代理覆盖 provider/system；
- `direct` / `none` 显式跳过后续代理；
- HTTP CONNECT；
- SOCKS5 无认证与用户名/密码认证；
- TLS 隧道；
- 代理连接、认证、CONNECT、TLS 和协议错误；
- 选中代理失败时不静默直连；
- 模型、额度、OAuth refresh 和推理使用一致的最终代理；
- 出口 IP 验证能区分 Worker 直连与代理出口。

## 11. 管理台检查

逐页检查：

- 登录、退出、会话过期；
- 概览；
- 内置渠道；
- OpenAI 供应商；
- 授权；
- 账号池分页、筛选和状态；
- 实际模型；
- 模型路由；
- 网关 Key；
- 模型价格；
- 请求日志；
- 系统设置与出口验证；
- 亮色 / 暗色主题；
- 移动端抽屉；
- 部署后旧 chunk 自动刷新恢复。

OpenAI-compatible provider Key 不应出现在只展示内置渠道账号的账号池页面。

## 12. 安全检查

- `MASTER_KEY` 是恰好 32 字节随机值的 Base64；
- `ADMIN_TOKEN` 与 `ADMIN_PASSWORD` 未写入仓库；
- 上游 Token、API Key 与 Proxy URL 可加密/解密；
- 使用错误 `MASTER_KEY` 时返回明确解密错误而不是泄漏密文；
- 网关 Key 只保存哈希，完整值只显示一次；
- 管理 Cookie 为 HttpOnly；
- 管理 API 不回显完整代理认证信息；
- 请求日志不保存完整提示词与输出；
- `.cflare/auth/` 和 `.dev.vars` 被忽略。

## 13. 发布记录模板

在 PR 或 Release 中记录：

```markdown
## Validation

- [ ] pnpm run doctor
- [ ] pnpm run check
- [ ] pnpm run config:check
- [ ] pnpm run build
- [ ] pnpm run smoke:admin
- [ ] Empty D1 migrations
- [ ] Upgrade D1 migrations
- [ ] Chat non-stream / stream
- [ ] Responses non-stream / stream
- [ ] OAuth and token refresh
- [ ] Routing failover and cooldown
- [ ] Proxy precedence and no-direct-fallback
- [ ] OpenCode official/mirror failover
- [ ] Admin UI desktop/mobile

Environment:
- Node:
- pnpm:
- Wrangler:
- Cloudflare account/environment:
- Commit:
- Known skipped checks:
```

只有实际执行并看到成功结果的项目才能勾选。