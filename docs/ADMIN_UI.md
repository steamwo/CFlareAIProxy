# Vue 3 管理台

CFlareAPI 0.5.0 不再把 HTML、CSS 和 JavaScript 写进 Worker TypeScript 字符串。

## 技术栈

```text
Vue 3
Vite
TypeScript
Naive UI
Vue Router
Pinia
Lucide Vue
```

源码在 `web/`，构建产物在 `dist/`。`dist/` 不提交为业务源码，可由 Cloudflare Builds 在部署时生成。

## 概念

### 内置渠道

Codex、Kimi、Qoder、OpenCode Zen。用户不能编辑 Base URL、OAuth 端点、请求协议或模型规则，只能：

- 启停渠道；
- 选择账号池策略；
- 管理账号；
- 设置来源级代理覆盖。

### OpenAI-compatible 供应商

用户可以新增、编辑和删除。配置项刻意保持简单：

- ID；
- 名称；
- Base URL；
- Chat/Responses 支持模式；
- 账号池策略；
- 启停状态。

API Key 统一在账号池中管理，因此同一个供应商可以有多个 Key。

## 路由和登录

Vue Router 使用 `/admin/` 作为历史记录基路径。Cloudflare Static Assets 的 SPA fallback 会让 `/admin/channels` 等导航直接返回 `index.html`。

管理 API 位于 `/admin/api/*`，登录后使用 HttpOnly Cookie。同源部署避免额外 CORS、跨域 Cookie和第二套域名配置。
