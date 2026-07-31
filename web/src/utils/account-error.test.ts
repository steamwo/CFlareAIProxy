import { describe, expect, it } from "vitest";
import { summarizeAccountError } from "./account-error";

describe("summarizeAccountError", () => {
  it("collapses an HTML 403 response into a permission error", () => {
    const summary = summarizeAccountError("OpenAI Codex quota returned 403: <html><body>blocked</body></html>");
    expect(summary).toEqual({
      code: "HTTP 403",
      label: "上游拒绝访问",
      hint: "检查账号权限、代理出口或上游访问策略。",
      tone: "error",
    });
  });

  it("classifies rate limits and timeouts without exposing raw content", () => {
    expect(summarizeAccountError("429 Too Many Requests")?.label).toBe("请求频率受限");
    expect(summarizeAccountError("upstream request timed out")?.code).toBe("TIMEOUT");
  });

  it("returns null when no error exists", () => {
    expect(summarizeAccountError(null)).toBeNull();
    expect(summarizeAccountError("  ")).toBeNull();
  });
});
