# 模型、配额与 OpenCode

本文档解释 CFlareAIProxy 中“实际模型”“公开模型”“模型路由”“模型能力”和“配额快照”的关系，并区分 OpenCode Zen 上游与 OpenCode 客户端接入。

## 1. 三层模型概念

### 实际模型

实际模型是某个 provider 或账号从上游目录发现的原始模型，例如：

```text
provider_id = kimi
credential_id = kimi-account-1
model_id = kimi-k2.5
endpoint = chat
```

每条发现记录关联：

```text
provider_id
credential_id
model_id
endpoint
capabilities_json
discovered_at
enabled
```

这允许：

- 不同账号拥有不同模型权限；
- 同一模型在不同 endpoint 上能力不同；
- 保留模型能力元数据；
- 账号模型刷新失败时继续使用上一次成功目录。

### 公开模型

公开模型是客户端在 `/v1/models` 中看到并提交给 API 的名称，例如：

```text
coding-fast
opencode/big-pickle
kimi/kimi-k2.5
```

公开模型可以：

- 使用默认的 `source_id/upstream_model_id` 格式；
- 映射成更短的别名；
- 聚合多个供应商；
- 配置主线路和备用线路。

模型 ID 中原本包含 `/` 也可以使用。网关只在需要解析来源前缀时把第一个 `/` 视为分隔符。

### 模型路由

模型路由把公开模型映射到实际上游：

```text
public_model = coding-fast
provider_id = provider-a
upstream_model = model-x
endpoint = chat
priority = 10
weight = 3
```

同一个公开模型可以有多条路由。

## 2. 路由与可用性

```text
coding-fast
  ├─ priority 10 · provider-a/model-x · weight 3
  ├─ priority 10 · provider-b/model-y · weight 1
  └─ priority 20 · provider-c/model-z · fallback
```

执行规则：

1. 过滤禁用或处于熔断期的 provider；
2. 过滤没有可用账号的路由；
3. 使用数字最小的可用 priority；
4. 同级根据 weight 分流；
5. 每条路由可尝试多个账号；
6. 可重试失败后切换账号或下一条路由；
7. provider 恢复成功后重新加入健康集合。

账号可用性会考虑：

- 启用状态；
- 模型是否属于该账号；
- 额度快照是否耗尽；
- 最近认证、权限、限额或服务错误；
- 冷却时间；
- 最大并发；
- OAuth Token 是否可刷新。

## 3. 动态模型发现

模型发现通常按账号执行。成功时替换该账号旧目录；失败时保留上一次成功目录，避免一次临时网络错误清空全部模型。

常见来源：

- 内置渠道官方模型 API；
- OpenAI-compatible `/models`；
- OpenCode Zen 实时目录；
- provider 配置中的静态或手动覆盖。

OpenAI-compatible 供应商推荐在管理台执行：

1. 测试 API Key；
2. 读取 `/models`；
3. 勾选要公开的模型；
4. 设置公开别名；
5. 保存并生成路由。

未勾选的模型不会自动暴露给客户端。

## 4. 模型能力元数据

模型发现或路由配置可以包含：

```json
{
  "inputModalities": ["text", "image"],
  "outputModalities": ["text"],
  "reasoningLevels": ["low", "medium", "high"],
  "supportsTools": true,
  "supportsImages": true,
  "forceResponseModelMapping": false
}
```

兼容 snake_case：

```text
input_modalities
output_modalities
reasoning_levels
supports_tools
supports_images
force_response_model_mapping
```

路由级配置优先于发现数据。`GET /v1/models` 会把能力附加到公开模型：

```json
{
  "id": "coding-fast",
  "x_cflare_capabilities": {
    "supportsTools": true,
    "supportsImages": false
  }
}
```

网关在请求进入上游前校验：

- 模型明确不支持 tools 时拒绝工具请求；
- 模型明确不支持图片时拒绝图片输入；
- reasoning level 不在允许列表时拒绝请求。

这样可以把明显无效的请求在网关侧提前返回，而不是消耗上游额度。

## 5. 配额快照

配额快照可能来自：

- `api`：主动调用 provider 额度接口；
- `configured`：自定义 quota endpoint 与字段映射；
- `headers`：推理响应中的限流 Header。

Header 快照会与主动快照合并，避免单次请求返回的速率窗口覆盖套餐、Credits 或组织额度。

配额窗口可能包含：

```text
limit
remaining
used
used_percent
reset_at
```

当有效快照明确显示额度耗尽时，该账号会在快照有效期内从候选池中摘除。到达重置时间或刷新得到新快照后可重新加入。

## 6. 通用配额字段映射

OpenAI-compatible 或 custom provider 可以在 options 中配置：

```json
{
  "quota_url": "https://provider.example/account/quota",
  "quota_method": "GET",
  "quota_headers": {
    "x-extra-header": "value"
  },
  "quota_windows": [
    {
      "key": "daily",
      "label": "每日",
      "limit_path": "data.daily.total",
      "remaining_path": "data.daily.remaining",
      "reset_path": "data.daily.reset_at"
    },
    {
      "key": "monthly",
      "label": "每月",
      "used_percent_path": "data.monthly.used_percent",
      "reset_path": "data.monthly.reset_after_seconds"
    }
  ]
}
```

重置值支持：

- Unix 秒；
- Unix 毫秒；
- 相对秒数；
- 持续时间字符串；
- 可解析日期字符串。

字段路径应以真实响应为准。配置错误时不要把未知值解释成“额度为零”。

## 7. Token 与费用

请求日志尽量归一化：

```text
prompt_tokens
completion_tokens
cached_tokens
total_tokens
```

价格表按公开模型维护：

- 输入价格；
- 输出价格；
- 缓存命中价格。

费用是网关侧估算。上游对 reasoning、tool、cache write/read 或其他 Token 的拆分可能更细，最终账单仍以供应商为准。

## 8. OpenCode 的两个方向

### OpenCode Zen 作为上游

```text
CFlareAIProxy → OpenCode Zen
```

provider 类型为 `opencode`。CFlareAIProxy 会根据模型分类选择 Zen 的 Responses、Anthropic Messages、Google GenerateContent 或 Chat 端点，并把结果转换回客户端请求的 OpenAI 风格。

详见 [OpenCode Zen 上游适配](OPENCODE_UPSTREAM.md)。

### OpenCode 客户端连接 CFlareAIProxy

```text
OpenCode 客户端 → CFlareAIProxy
```

此时 CFlareAIProxy 对 OpenCode 客户端只是一个 OpenAI-compatible provider。客户端配置应引用环境变量：

```text
CFLARE_API_KEY
```

不要把完整网关 Key 写入并提交到 `opencode.json` 或 Git 仓库。

这两个方向互相独立，可以同时使用：

```text
OpenCode 客户端
  → CFlareAIProxy
    → OpenCode Zen / Codex / Kimi / 其他上游
```

## 9. OpenCode 匿名免费模型

没有 OpenCode API Key 时，网关可以维护匿名免费模型目录。当前规则以实时目录为基础，只尝试明确符合免费规则的模型，例如：

```text
big-pickle
*-free
```

付费模型不会在无 Key 时尝试。

匿名目录和可用性会随 Zen 实时服务变化，不应在文档中维护永久静态模型名单。客户端始终以 `/v1/models` 返回结果为准。

## 10. OpenCode 官方与镜像故障转移

配置 API Key 的账号：

```text
官方 Zen
  ↓ 失败
镜像 A
  ↓ 失败
镜像 B
  ↓ 失败
镜像 C
```

匿名免费凭据会直接使用镜像候选。

默认镜像由代码提供，也可以通过以下位置追加：

```text
provider.options.mirror_urls
OPENCODE_MIRRORS_URL
```

值可使用数组、逗号或换行分隔。URL 必须为 HTTP/HTTPS。

镜像成功不代表官方凭据健康。若官方返回认证或限额错误，网关会保留该失败信息用于账号冷却或状态提示，同时可将镜像成功结果返回客户端。

## 11. 常见排查

| 现象 | 检查项 |
| --- | --- |
| `/v1/models` 没有预期模型 | Key 的 allowed models、模型是否公开、账号模型刷新、路由是否启用。 |
| 模型存在但请求 `MODEL_NOT_FOUND` | endpoint 是否匹配、公开模型路由是否存在。 |
| `NO_CREDENTIAL_AVAILABLE` | 账号是否禁用、冷却、额度耗尽、并发满或不拥有该模型。 |
| tools / image 被 400 拒绝 | `x_cflare_capabilities` 与路由级能力覆盖。 |
| 配额一直为空 | provider 是否有额度 API、字段映射、账号代理与刷新错误。 |
| OpenCode 官方失败但请求成功 | 可能已使用镜像故障转移，检查账号错误与请求日志。 |
| OpenCode 匿名模型消失 | 实时目录已变化，重新刷新并以 `/v1/models` 为准。 |