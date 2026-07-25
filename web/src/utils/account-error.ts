export type AccountIssueTone = "warning" | "error";

export interface AccountIssueSummary {
  code: string;
  label: string;
  hint: string;
  tone: AccountIssueTone;
}

const result = (code: string, label: string, hint: string, tone: AccountIssueTone = "warning"): AccountIssueSummary => ({
  code,
  label,
  hint,
  tone,
});

export function summarizeAccountError(message: string | null | undefined): AccountIssueSummary | null {
  const source = message?.trim();
  if (!source) return null;

  const normalized = source.toLowerCase();
  const statusMatch = source.match(/\b(?:http\s*)?([45]\d{2})\b/i);
  const status = statusMatch?.[1];

  if (status === "401" || /unauthori[sz]ed|invalid[_ -]?token|token.*expired|credential.*expired/.test(normalized)) {
    return result(status ? `HTTP ${status}` : "AUTH", "授权已失效", "请重新授权或更新账号凭据。", "error");
  }
  if (status === "403" || /forbidden|access denied|permission denied/.test(normalized)) {
    return result(status ? `HTTP ${status}` : "FORBIDDEN", "上游拒绝访问", "检查账号权限、代理出口或上游访问策略。", "error");
  }
  if (status === "429" || /rate.?limit|too many requests|请求过于频繁/.test(normalized)) {
    return result(status ? `HTTP ${status}` : "RATE LIMIT", "请求频率受限", "等待限流窗口恢复，系统会继续尝试可用线路。");
  }
  if (status?.startsWith("5") || /bad gateway|service unavailable|upstream.*error/.test(normalized)) {
    return result(status ? `HTTP ${status}` : "UPSTREAM", "上游服务异常", "上游暂时不可用，稍后刷新状态。", "error");
  }
  if (/timeout|timed out|deadline exceeded|aborted/.test(normalized)) {
    return result("TIMEOUT", "上游响应超时", "检查网络与代理链路，或稍后重试。");
  }
  if (/proxy|socks|tunnel/.test(normalized)) {
    return result("PROXY", "代理连接失败", "检查账号或系统代理配置。", "error");
  }
  if (/network|fetch failed|connection refused|connection reset|dns/.test(normalized)) {
    return result("NETWORK", "网络连接失败", "检查 Worker 出口、DNS 或上游网络状态。", "error");
  }
  if (/quota|credit|balance|额度/.test(normalized)) {
    return result("QUOTA", "额度刷新失败", "当前额度暂不可用，可手动刷新后重试。");
  }
  if (/<!doctype|<html|text\/html/.test(normalized)) {
    return result("RESPONSE", "上游响应格式异常", "上游返回了非预期页面，未展示原始内容。", "error");
  }

  return result(status ? `HTTP ${status}` : "ERROR", "账号服务异常", "查看账号、代理和上游状态后重试。", "error");
}
