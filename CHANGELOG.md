# Changelog

## Unreleased

### Gateway runtime

- 推理主链路切换到新的 provider-aware proxy pipeline，统一账号选择、路由重试、上游错误分类、流式跟踪和 usage 写入。
- Codex Responses 适配增强：请求字段归一化、流内错误分类、中断流检测、完成事件处理和最终 output 重建。
- Codex 请求头、OAuth 参数和身份信息生命周期进一步对齐 CLIProxyAPI，并保留 SSE 帧元数据与 collaboration 命名空间。
- 新增 Codex multi-agent v2 请求/响应转换；路由可独立开关该能力，并向客户端暴露相应模型能力。
- Kimi 使用专用 adapter，补充 Chat / Responses / Completions 转换、工具消息关联修复、模型名归一化和流式 usage。
- OAuth Token 在推理前可自动刷新，并使用 Durable Object credential lock 避免同一账号并发刷新。
- 账号级 `proxy_url` / `proxyUrl` 覆盖 provider 与系统代理；支持 `direct` / `none` 显式直连。
- 统一上游网络、认证、权限、限额、参数、服务和流式错误语义，改善账号冷却、provider 熔断与故障切换。
- Anthropic、Google 与 Qoder 的流式和缓冲响应补齐错误检测；上游错误不再被误报为正常完成，并增加两种响应路径的等价性测试。
- 原生 HTTP CONNECT / SOCKS5 代理增加空闲超时，避免挂起连接长期占用账号池与并发租约；已移除不再使用的外部 Proxy Bridge。
- 长时间流式请求会在租约过期后继续正确结算 Token；五分钟用量聚合改为增量、幂等写入，避免跨批次少计或 Queue 重投重复计费。

### Models and routing

- 新增模型能力元数据：输入/输出模态、tools、图片、reasoning levels 与响应模型名回写。
- `/v1/models` 可为直接模型和公开路由模型返回 `x_cflare_capabilities`。
- Codex 客户端模型目录改为动态生成，并优先采用最新发现的模型元数据。
- 请求进入上游前会拒绝明确不支持的 tools、图片输入和 reasoning level。
- OpenCode Zen 增加官方线路到多镜像线路的故障转移，并允许通过 provider options 或 `OPENCODE_MIRRORS_URL` 追加镜像。
- OpenCode 官方认证或限额失败可记录到账号健康状态，同时在镜像成功时继续向客户端返回结果。
- Qoder 匿名模型可自动使用上游 `display_name` 完成公开模型路由；修复 Qoder 与 Codex 配额响应解析和耗尽状态展示。
- 禁用内置渠道后立即失效公开模型缓存；路由页按上游三元组复用账号可用性查询，减少重复 D1 读取。

### Observability and storage

- 新增可配置的请求明细日志与运行日志级别；基础调用统计保持独立，关闭明细日志不会停用概览和账号活跃度统计。
- 请求活动按五分钟聚合，概览与账号卡片改用有界聚合查询；请求明细保留 24 小时，活动聚合保留 90 天。
- 定时清理同时覆盖请求日志、活动聚合和过期 OAuth 会话；删除按批次执行，各任务相互隔离，避免积压时触发无界 D1 操作。
- 管理端账号、路由和 Key 列表增加防御性上限，并为高频管理查询与 Qoder 模型别名查找补充索引。

### Reliability, operations, and security

- 管理台登录增加按 IP 的递增退避与全局失败限流；管理 API 改为显式公开路径白名单，新端点默认需要认证。
- 新增可配置 Webhook 故障告警，覆盖供应商熔断、账号耗尽、Queue 死信和定时任务失败，并通过 KV 跨实例去重。
- 新增配置备份与事务式恢复；凭据保持密文，网关 Key 保持哈希，不在备份中泄露明文。
- 支持通过 `MASTER_KEY_PREVIOUS` 无停机轮换主加密密钥；损坏密文不会被误判为旧密钥数据。
- OAuth 设备授权轮询增加服务端最小转发间隔；配额和模型刷新限制单批账号数，并由 Cron 按最久未刷新优先持续推进。
- 管理端非法 JSON、数组或标量请求体统一返回 `400 INVALID_JSON`，不再误报服务端内部错误。

### Admin console

- 新增独立“授权”页面，集中处理 Codex PKCE、Kimi/Qoder 设备授权和授权 JSON 导入。
- 授权页支持 JSON 文件上传和账号凭据导出；Codex OAuth 全流程保留 ID Token 身份信息。
- 账号池、渠道、供应商、模型、路由、Key、价格和日志页面重新整理信息层级与状态展示。
- 账号池改为卡片视图，统一展示额度窗口、耗尽状态、活跃度和路由分组；概览增加账号活动热力数据。
- 会话过期后会自动重新校验并跳转登录页；路由与模型页面补充骨架屏、空状态和大列表渐进展开。
- 新增系统 Logo、provider 图标、响应式侧栏、移动端抽屉和主题切换。
- 增加旧 Vite chunk 失效后的自动刷新恢复，减少跨版本部署后页面卡死。
- 管理台产物按 Vue 与 UI 运行时拆分稳定缓存，并补充键盘操作、屏幕阅读器标签和删除确认等交互细节。
- Static Assets 增加安全响应 Header。

### Deployment and validation

- 生产 Worker 名称统一为 `cfap`，Wrangler 入口改为 `src/worker.ts`，并补齐 `AccountPool` 与 `RateLimiter` 的具名导出。
- CI 与部署统一使用 Node 22、pnpm 和冻结锁文件；`doctor`、配置检查及部署 dry-run 与当前 Worker 名称和路由接线保持一致。
- 新增前后端 API 类型字段契约检查，按声明名识别意外的响应结构漂移。

### Documentation

- 重做 `README.md`，增加架构图、上游矩阵、快速接入、路由、能力元数据、代理、部署和安全说明。
- 新增 `docs/API_USAGE.md`。
- 新增 `docs/OPERATIONS.md`，说明登录限流、故障告警、配置备份与恢复、主密钥轮换和定时任务。
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
