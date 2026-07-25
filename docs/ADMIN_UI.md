# 管理台说明

CFlareAIProxy 管理台是与 Worker 同域部署的 Vue 3 SPA，用于管理上游渠道、账号、模型、路由、客户端 Key、价格、日志和代理设置。

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

源码位于 `web/`，生产构建输出到 `dist/`，再由 Cloudflare Workers Static Assets 与后端一起发布。

## 同域架构

```text
/admin/*       → Vue SPA
/admin/api/*   → Hono 管理 API
/v1/*          → 客户端网关 API
/oauth/*       → OAuth 回调
```

Vue Router 使用 `/admin/` 作为 history base。Static Assets 的 SPA fallback 允许用户直接访问 `/admin/accounts`、`/admin/routes` 等深层地址。

管理 API 使用 HttpOnly Cookie 登录会话。同域交付避免了第二套域名、CORS、跨域 Cookie 和前后端版本错配。

## 页面导航

### 概览

用于快速判断网关是否正常运行：

- 请求量、成功率、Token 与成本；
- 最近请求和错误；
- 近期成功率趋势；
- 供应商、账号和模型的整体状态。

概览适合发现异常，具体原因应继续到“请求日志”“账号池”或“模型路由”查看。

### 内置渠道

管理代码中固定注册的渠道：

- OpenAI Codex；
- Kimi Coding；
- Qoder；
- OpenCode Zen。

内置渠道的 Base URL、OAuth 端点、请求协议和默认模型规则由代码维护，管理台只允许修改运行时配置，例如：

- 启用或禁用；
- 账号池策略；
- 渠道级 Proxy URL；
- 部分可安全覆盖的选项。

这样可以防止数据库中的端点或协议配置被意外篡改后进入运行时。

### OpenAI 供应商

用于添加 OpenAI-compatible 上游。常见流程：

1. 填写 ID、名称和 Base URL；
2. 选择 Chat、Responses 或 both；
3. 填写 API Key；
4. 测试 Key 并读取 `/models`；
5. 勾选要对客户端公开的模型；
6. 可选地把上游模型映射成更短的公开别名；
7. 设置供应商权重、账号池策略和代理；
8. 保存后自动生成或更新相应模型路由。

未勾选的模型不会自动公开。编辑供应商时，已有 Key 保留；填写新 Key 会追加到该供应商的凭据集合。

OpenAI-compatible API Key 在供应商页面管理，不会混入“账号池”的内置渠道账号列表。

### 授权

集中处理内置渠道的 OAuth 与授权文件导入。

支持的交互：

- Codex PKCE：打开授权页后粘贴 localhost 完整回调 URL；
- Kimi Device OAuth：显示授权页并自动轮询；
- Qoder PKCE Device：显示设备授权信息并自动轮询；
- 导入授权 JSON：将已有 access token / refresh token 加入账号池。

授权成功后，账号会自动进入账号池，并触发模型与额度刷新。

### 账号池

只展示内置渠道账号。每张账号卡片用于查看和修改：

- 标签和账号身份；
- 启用状态；
- 优先级与权重；
- 最大并发；
- 模型发现状态；
- 额度窗口与重置时间；
- Token 过期时间；
- 最近错误、冷却与恢复信息；
- 账号级代理覆盖。

数字更小的优先级先被选择。同优先级账号按权重参与调度。账号不可用时会被临时摘除，而不是继续盲目请求。

### 实际模型

展示从各账号或匿名目录发现的真实上游模型。发现记录关联：

```text
provider_id
credential_id
model_id
endpoint
capabilities
```

不同账号可能拥有不同模型权限。刷新成功时替换该账号旧目录；刷新失败时保留上一次成功结果。

模型能力可能包含：

- tools；
- 图片输入；
- reasoning level；
- 输入和输出模态；
- 响应中的模型名是否强制回写为公开模型名。

### 模型路由

定义“客户端公开模型名 → 实际供应商与上游模型”的映射。

```text
coding-fast
  ├─ priority 10 · provider-a/model-x · weight 3
  ├─ priority 10 · provider-b/model-y · weight 1
  └─ priority 20 · provider-c/model-z · fallback
```

规则：

1. 过滤禁用、熔断和无可用账号的线路；
2. 使用数字最小的可用优先级；
3. 同级按权重分流；
4. 请求失败时尝试其他账号或下一条路由；
5. 线路恢复后自动重新加入可用集合。

普通 OpenAI-compatible 模型的公开选择、别名和供应商权重优先在“OpenAI 供应商”页面维护。“模型路由”用于跨供应商聚合、主备和高级覆盖。

### 网关密钥

客户端只使用网关 Key，不直接使用上游凭据。

每个 Key 可以设置：

- 名称；
- RPM；
- 最大并发；
- 月 Token 上限；
- 允许模型；
- 启用状态。

完整 Key 只在创建时显示一次，数据库只保存哈希和前缀提示。丢失后应创建新 Key 并删除旧 Key。

### 模型价格

按公开模型维护：

- 输入 Token 单价；
- 输出 Token 单价；
- 缓存命中 Token 单价。

价格用于网关日志中的成本估算，不替代供应商账单。不同供应商映射到同一公开模型名时，当前价格按公开模型统一计算。

### 请求日志

用于排查一次请求实际走了哪条路径。常见字段：

- request ID；
- 网关 Key；
- 公开模型和上游模型；
- provider 与 credential；
- endpoint；
- 状态码；
- prompt、completion、cached、total Token；
- 总延迟和首 Token 延迟；
- 错误码与错误摘要；
- 估算费用。

日志默认不保存完整提示词和模型输出。

### 系统设置

用于维护全局默认配置，特别是系统 Proxy URL 与出口 IP 验证。

代理优先级：

```text
账号级代理
  ↓ 未设置
供应商/内置渠道代理
  ↓ 未设置
系统默认代理
  ↓ 未设置
Worker 直连
```

账号级 `direct` / `none` 会明确跳过供应商和系统代理。

## 账号、供应商与路由的边界

这三个概念容易混淆：

| 概念 | 回答的问题 |
| --- | --- |
| 供应商 / 渠道 | 请求发往哪个服务，使用什么协议。 |
| 账号 / 凭据 | 使用该服务的哪个 OAuth Token 或 API Key。 |
| 模型路由 | 客户端模型名最终映射到哪个供应商和上游模型。 |

一个供应商可以有多个账号；一个公开模型可以有多条供应商路由；同一个账号也可能只拥有部分模型。

## 登录与会话

至少需要：

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=强密码
```

`ADMIN_USERNAME` 未设置时默认使用 `admin`。`ADMIN_PASSWORD` 应保存为 Cloudflare Secret。

`ADMIN_TOKEN` 用于管理会话签名与自动化鉴权，不等同于客户端网关 Key。不要把 `ADMIN_TOKEN` 分发给普通客户端。

## 前端缓存与发布恢复

部署后，旧浏览器标签页可能仍持有上一版 Vite chunk URL。Worker 对失效的 `/admin/assets/*.js` 返回一个最小恢复模块，触发 SPA 刷新，避免导航永久卡死。

若页面仍异常：

1. 强制刷新；
2. 清除该站点缓存；
3. 检查浏览器 Network 中是否混用了不同部署版本的静态资源；
4. 检查 `/admin/api/session` 与 Worker 日志。

## 移动端与主题

管理台提供：

- 桌面侧边栏；
- 移动端抽屉导航；
- 亮色 / 暗色主题；
- 响应式卡片和表格。

管理台适合日常运维，但批量自动化仍应使用受保护的管理 API 或仓库脚本，并严格保管 `ADMIN_TOKEN`。