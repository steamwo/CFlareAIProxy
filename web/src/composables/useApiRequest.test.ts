import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { errorText, useApiRequest } from "./useApiRequest";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("naive-ui", () => ({ useMessage: () => toast }));

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.warning.mockReset();
});

describe("errorText", () => {
  it("prefers the Error message and stringifies everything else", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
  });
});

describe("useApiRequest", () => {
  it("toggles loading around the task and returns its value", async () => {
    const { loading, run } = useApiRequest();
    const seen: boolean[] = [];

    const value = await run(async () => {
      seen.push(loading.value);
      return "done";
    });

    expect(value).toBe("done");
    expect(seen).toEqual([true]);
    expect(loading.value).toBe(false);
  });

  it("shows the success toast, including the dynamic form", async () => {
    const { run } = useApiRequest();

    await run(async () => 3, { success: "已保存" });
    await run(async () => 7, { success: (count) => `获取到 ${count} 个模型` });

    expect(toast.success).toHaveBeenNthCalledWith(1, "已保存");
    expect(toast.success).toHaveBeenNthCalledWith(2, "获取到 7 个模型");
  });

  it("reports failures as an error toast and resolves undefined", async () => {
    const { loading, run } = useApiRequest();

    const value = await run(async () => {
      throw new Error("上游异常");
    });

    expect(value).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith("上游异常");
    expect(loading.value).toBe(false);
  });

  it("honours the warning tone and the silent tone", async () => {
    const { run } = useApiRequest();

    await run(async () => { throw new Error("轻微问题"); }, { failureTone: "warning" });
    await run(async () => { throw new Error("自行展示"); }, { failureTone: "none" });

    expect(toast.warning).toHaveBeenCalledWith("轻微问题");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays silent on 401 because the global handler already redirects", async () => {
    const { run } = useApiRequest();

    const value = await run(async () => {
      throw new ApiError("会话过期", 401);
    });

    expect(value).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("rethrows when asked, after reporting", async () => {
    const { run } = useApiRequest();

    await expect(run(async () => { throw new Error("致命"); }, { rethrow: true })).rejects.toThrow("致命");
    expect(toast.error).toHaveBeenCalledWith("致命");
  });

  it("tracks a caller-supplied loading ref instead of the shared one", async () => {
    const { loading, run } = useApiRequest();
    const saving = ref(false);
    const seen: Array<[boolean, boolean]> = [];

    await run(async () => { seen.push([loading.value, saving.value]); }, { loading: saving });

    expect(seen).toEqual([[false, true]]);
    expect(saving.value).toBe(false);
  });

  it("skips loading bookkeeping entirely when passed null", async () => {
    const { loading, run } = useApiRequest();

    await run(async () => { expect(loading.value).toBe(false); }, { loading: null });

    expect(loading.value).toBe(false);
  });

  it("reportError surfaces manually caught failures and returns the text", () => {
    const { reportError } = useApiRequest();

    expect(reportError(new Error("手动"))).toBe("手动");
    expect(toast.error).toHaveBeenCalledWith("手动");

    expect(reportError(new ApiError("会话过期", 401))).toBe("会话过期");
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
