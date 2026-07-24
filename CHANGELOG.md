# Changelog

## Unreleased (`dev`)

### Gateway runtime

- 推理主链路切换到新的 provider-aware proxy pipeline，统一账号选择、路由重试、上游错误分类、流式跟踪和 usage 写入。
- Codex Responses 适配增强：请求字段归一化、流内错误分类、中断流检测、完成事件处理和最终 output 重建。
- Kimi 使用专用 adapter，补充 Chat / Responses / Completions 转换、工具消息关联修复、模型名归一化和流式 usage。
- OAuth Token 在推理前可自动刷新，并使用 Durable Object credential lock 避免同一账号并发刷新。
- 账号级 `proxy_url` / `proxyUrl` 覆盖 provider 与系统代理；支持 `direct` / `none` 显式直连。
- 统一上游网络、认证、权限、限额、参数、服务和流式错误语义，改善账号冷却、provider 熔断与故障切换。

### Models and routing

- 新增模型能力元数据：输入/输出模态、tools、图片、reasoning levels 与响应模型名回写。
- `/v1/models` 可为直接模型和公开路由模型返回 `x_cflare_capabilities`。
- 请求进入上游前会拒绝明确不支持的 tools、图片输入和 reasoning level。
- OpenCode Zen 增加官方线路到多镜像线路的故障转移，并允许通过 provider options 或 `OPENCODE_MIRRORS_URL` 追加镜像。
- OpenCode 官方认证或限额失败可记录到账号健康状态，同时在镜像成功时继续向客户端返回结果。

### Admin console

- 新增独立“授权”页面，集中处理 Codex PKCE、Kimi/Qoder 设备授权和授权 JSON 导入。
- 账号池、渠道、供应商、模型、路由、Key、价格和日志页面重新整理信息层级与状态展示。
- 新增系统 Logo、provider 图标、响应式侧栏、移动端抽屉和主题切换。
- 增加旧 Vite chunk 失效后的自动刷新恢复，减少跨版本部署后页面卡死。
- Static Assets 增加安全响应 Header。

### Documentation

- 重做 `README.md`，增加架构图、上游矩阵、快速接入、路由、能力元数据、代理、部署和安全说明。
- 新增 `docs/API_USAGE.md`。
- 更新部署、管理台、代理、模型/配额、Codex 授权和 OpenCode Zen 专题文档。
- `COPY.md` 记录与 CLIProxyAPI 的行为对齐范围、明确差异和后续同步规则。

## 0.5.3

- 模型价格增加输入、输出、缓存命中三类价格；请求日志记录缓存 Token，并按缓存价计算成本。
- `pnpm run doctor` 改为从 `package.json` 与 `ADMIN_UI_VERSION` 动态读取版本，修复“管理 API 源码版本不匹配”误报。
- 供应商代理改为 Cloudflare Worker 原生 HTTP CONNECT / SOCKS5 TCP；代理启用后不再静默直连回退，并可对比 Worker 直连 IP 与代理出口 IP。
- OpenAI-compatible 供应商支持测试 API Key、获取模型、勾选公开模型、映射公开名称及设置供应商权重。
- 简化模型路由说明与状态展示：数字更小的优先级作为主线路，同级按权重分流，OpenAI 供应商自动管理的路由回到供应商页面配置。
- 额度耗尽账号在快照有效期内自动摘除；401/403/429/5xx 账号进入冷却；供应商连续网络/5xx 失败后熔断，并在恢复后自动重新加入路由。
- 保留 0.5.1 原始归档根目录 `CFlareAIProxy/` 与既有文件层级。

## 0.5.2

- 修复 Qoder 设备授权轮询：404/202 继续等待，短暂网络错误自动重试，并兼容嵌套 Token 与用户信息响应。
- Qoder 额度切换到 `/api/v2/quota/usage`，显示个人额度、组织资源包和重置时间。
- 账号池改为卡片布局，每个账号展示完整额度窗口、状态、错误和调度参数。
- 代理设置只要求 Proxy URL；缺少部署级转发能力时自动直连回退，不再抛出 Bridge 配置错误阻断授权和额度刷新。

## 0.5.1

- OpenAI-compatible 供应商表单可直接录入首个 API Key；编辑时可追加新 Key，已有账号不受影响。
- Codex 恢复管理台内授权：打开官方授权页后粘贴 localhost 完整回调 URL，Worker 使用原 PKCE 会话换取 Token；授权 JSON 与本地助手继续作为兜底。
- 概览增加最近 7 天按小时成功率热力图。
- OpenCode Zen 支持无账号匿名免费模型：动态发现 `big-pickle` 与实时 `*-free` 模型；付费模型仍要求 API Key。

除上述内容外，0.5.0 的内置渠道、自定义供应商、代理、账号池、路由、配额、模型、网关 Key 与部署结构保持不变。