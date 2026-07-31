/**
 * Declared contract between the Worker's types (`src/**`) and the admin console's
 * types (`web/src/**`).
 *
 * Why this exists: the two type files are hand-written and independent, so a backend
 * response-shape change is only caught by someone remembering to edit the console.
 * This contract turns that memory into a build failure.
 *
 * Why it is a field-name comparison and not a structural/type comparison: the two sides
 * legitimately model the same wire field differently (the backend narrows `endpoint` to
 * `GatewayEndpoint`, the console widens it to `string`; the backend has `status` as a
 * union, the console as `string`). Comparing declared types would fire on those by design
 * and force the console to import Worker types it cannot see. Field *names* are the part
 * that must agree, because that is what JSON carries.
 *
 * Each pair lists the differences that are intentional, with the reason. Anything not
 * listed here is drift and fails. An entry that no longer describes a real difference also
 * fails, so this list cannot silently rot into a blanket suppression.
 */
export const TYPE_CONTRACT = {
  /**
   * Interfaces are matched by declared name across the whole tree, never by file path or
   * line, so moving or reformatting a declaration is a free refactor.
   */
  interfaces: [
    {
      backend: "CredentialRow",
      frontend: "Credential",
      note: "GET /admin/api/credentials 与 GET /admin/api/accounts 的行结构",
      backendOnly: {
        secret_ciphertext: "处理器解构丢弃，密文永不出网",
        refresh_ciphertext: "处理器解构丢弃，仅以 has_refresh_token 布尔值暴露",
      },
      frontendOnly: {
        metadata: "处理器由 metadata_json 解析后附加",
      },
    },
    {
      backend: "ModelRouteRow",
      frontend: "ModelRoute",
      note: "GET /admin/api/routes 的行结构",
      backendOnly: {
        created_at: "随行下发，但路由页面不展示时间戳",
        updated_at: "随行下发，但路由页面不展示时间戳",
      },
      frontendOnly: {
        health: "处理器由 routing-health 熔断状态附加",
        availability: "处理器按可用账号数与熔断状态计算后附加",
      },
    },
    {
      backend: "GatewayKeyRow",
      frontend: "GatewayKey",
      note: "GET /admin/api/keys 的行结构",
      backendOnly: {
        key_hash: "处理器解构丢弃，网关密钥仅存哈希且只在创建时展示一次",
        updated_at: "随行下发，但密钥页面不展示更新时间",
      },
      frontendOnly: {},
    },
    {
      backend: "DiscoveredModelRow",
      frontend: "DiscoveredModel",
      note: "GET /admin/api/models 的行结构",
      backendOnly: {
        capabilities_json: "能力元数据经 /v1/models 暴露，管理台模型页面不消费",
        raw_json: "上游原始响应留档，不进管理台",
      },
      frontendOnly: {},
    },
    {
      backend: "QuotaSnapshotRow",
      frontend: "QuotaSnapshot",
      note: "GET /admin/api/accounts 响应中的 quotas 数组",
      backendOnly: {},
      frontendOnly: {
        snapshot: "处理器由 quota_json 解析后附加",
      },
    },
    {
      backend: "QuotaWindow",
      frontend: "QuotaWindow",
      note: "配额快照内的单个额度窗口",
      backendOnly: {
        source: "单窗口来源用于服务端可用性判定，管理台按窗口展示时不区分来源",
      },
      frontendOnly: {},
    },
    {
      // Zero intentional differences: this pair must stay field-for-field identical.
      backend: "ProviderProxySummary",
      frontend: "ProxySummary",
      note: "渠道与供应商列表内联的代理摘要",
      backendOnly: {},
      frontendOnly: {},
    },
    {
      backend: "ProviderRow",
      frontend: "Channel",
      note: "GET /admin/api/channels 展开的供应商行",
      backendOnly: {
        endpoints_json: "内置渠道端点由代码注册表决定，管理台不可编辑",
        auth_json: "鉴权配置含敏感形状，不进管理台",
        headers_json: "上游请求头由代码注册表决定，管理台不可编辑",
        options_json: "处理器只投影所需字段，不下发原始 JSON",
        created_at: "随行下发，但渠道页面不展示时间戳",
        updated_at: "随行下发，但渠道页面不展示时间戳",
      },
      frontendOnly: {
        description: "处理器由内置渠道注册表附加",
        authMode: "处理器由内置渠道注册表附加",
        accountCount: "处理器按 provider 聚合账号数后附加",
        enabledAccountCount: "处理器按 provider 聚合启用账号数后附加",
        modelCount: "处理器按 provider 聚合已发现模型数后附加",
        proxy: "处理器附加代理摘要",
      },
    },
    {
      backend: "ProviderRow",
      frontend: "Provider",
      note: "GET /admin/api/providers 展开的供应商行",
      backendOnly: {
        endpoints_json: "标准 OpenAI 端点由 standardOpenAiConfig 生成，管理台按 apiMode 编辑",
        auth_json: "鉴权配置含敏感形状，不进管理台",
        headers_json: "标准请求头由 standardOpenAiConfig 生成，管理台不可编辑",
        options_json: "处理器只投影 apiMode/routingWeight/modelSelections",
        created_at: "随行下发，但供应商页面不展示时间戳",
        updated_at: "随行下发，但供应商页面不展示时间戳",
      },
      frontendOnly: {
        apiMode: "处理器由 options_json.api_mode 投影",
        routingWeight: "处理器由 options_json.routing_weight 投影",
        modelSelections: "处理器由 options_json.selected_models 投影",
        proxy: "处理器附加代理摘要",
      },
    },
  ],

  /**
   * String-literal unions duplicated verbatim on both sides. A member added only on the
   * backend means the console renders a value its dropdown cannot produce or label.
   */
  unions: [
    {
      backend: "PoolStrategy",
      frontend: "PoolStrategy",
      note: "账号池调度策略，管理台下拉选项必须与后端可选值一致",
    },
  ],
};
