# 实际模型、配额与 OpenCode

## 动态模型发现

每条发现记录关联：

```text
provider_id
credential_id
model_id
endpoint
```

这允许不同账号拥有不同模型权限。刷新成功时替换该账号的旧目录；失败时保留上一次成功目录。

公共模型格式：

```text
source_id/upstream_model_id
```

模型 ID 中原本含 `/` 也可以使用，因为网关只把第一个 `/` 视为来源分隔符。

## OpenCode 的两个方向

### OpenCode Zen 作为上游

```text
CFlareAIProxy → OpenCode Zen
```

供应商类型为 `opencode`，通过 Zen 实际模型目录与多协议端点转发。详见 [OPENCODE_UPSTREAM.md](OPENCODE_UPSTREAM.md)。

### OpenCode 客户端连接 CFlareAIProxy

```text
OpenCode 客户端 → CFlareAIProxy
```

管理台“客户端集成”生成的是一个 OpenAI-compatible 自定义 Provider 配置。配置中的模型来自当前 `/v1/models`，密钥通过：

```text
CFLARE_API_KEY
```

环境变量引用，不应把完整网关密钥提交到 Git。

这项客户端配置功能与 Zen 上游适配互相独立，可同时使用。

## 配额来源

配额快照可能来自：

- `api`：主动调用供应商额度接口；
- `configured`：自定义配额端点和映射；
- `headers`：普通推理响应的标准限流 Header。

Header 快照会与主动快照合并，避免套餐和 Credits 被覆盖。

## 通用配额字段映射

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

重置值支持 Unix 秒、Unix 毫秒、相对秒数、持续时间字符串和可解析日期字符串。
