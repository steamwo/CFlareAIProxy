# CFlareAIProxy 0.5.3 验证记录

验证日期：2026-07-23。

## 本次覆盖

- 模型价格：输入、输出、缓存命中价格与缓存 Token 成本计算。
- Doctor：管理 API 版本从源码和 `package.json` 动态对比。
- 代理：Worker 原生 HTTP CONNECT / SOCKS5、无静默直连回退、出口 IP 对比。
- OpenAI-compatible 供应商：API Key 测试、模型读取、公开模型选择、别名、供应商权重。
- 模型路由：优先级主备、同级权重、账号额度摘除、账号冷却、供应商熔断和恢复。
- Qoder 授权、账号卡片与个人/组织额度修复继续保留。

## 已完成的校验

- `node scripts/check-config.mjs`：通过。
- `node scripts/check-web.mjs`：通过。
- Worker 修改文件在严格模式与 `noUncheckedIndexedAccess` 下类型检查：通过；Cloudflare 平台类型使用未写入发布包的临时声明。
- Worker 全部 TypeScript 文件语法转译检查：通过。
- 所有 Vue SFC 脚本语法转译检查：通过。
- OpenAI 供应商、模型路由、价格、日志和代理相关 Vue 脚本严格类型检查：通过；Vue/Naive UI 临时声明不写入发布包。
- D1 migrations `0001`–`0006` 在空 SQLite 数据库顺序执行：通过；新增缓存价格和缓存 Token 字段存在。
- Qoder 个人/组织额度响应运行断言：通过。
- 路由健康状态运行断言：优先级排序、同级权重候选、连续失败熔断、熔断过滤和成功恢复：通过。
- `node scripts/doctor.mjs` 已确认输出“管理 API 版本与 package.json 一致（0.5.3）”；当前仅因依赖未安装而按预期报错。
- 最终 ZIP 与原始 `CFlareAIProxy-0.5.1(1).zip` 路径集合对照：原始顶层目录及既有文件路径均保留。

## 当前环境限制

当前沙箱访问依赖仓库超时，因此未使用项目真实 `node_modules` 运行 `vue-tsc`、Vite production build、Vitest、Wrangler dry-run 或端到端 Worker 启动。发布包不包含 `node_modules`、临时类型声明、构建目录、本地密钥或测试输出。
