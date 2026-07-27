import { describe, expect, it, vi } from "vitest";
import { ModelRefreshGate } from "../src/rate-limiter";
import { refreshAllModels, refreshProviderModels } from "../src/models";
import type { Env } from "../src/types";

describe("model refresh coordination", () => {
  it("coalesces equal scopes and serialises different scopes", async () => {
    const gate = new ModelRefreshGate();
    let release!: (value: string[]) => void;
    const pending = new Promise<string[]>((resolve) => { release = resolve; });
    const firstTask = vi.fn(() => pending);
    const secondTask = vi.fn(async () => ["second"]);

    const first = gate.run("provider:p1", firstTask);
    const duplicate = gate.run("provider:p1", firstTask);
    const second = gate.run("all", secondTask);
    await Promise.resolve();
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).not.toHaveBeenCalled();

    release(["first"]);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([["first"], ["first"]]);
    await expect(second).resolves.toEqual(["second"]);
    expect(secondTask).toHaveBeenCalledTimes(1);
  });

  it("routes full and provider sweeps through the same named instance", async () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const fetch = vi.fn(async (url: string) => url.endsWith("/models/refresh")
      ? Response.json([])
      : Response.json({ providerId: "p1", results: [], processed: 0, total: 0, remaining: 0 }));
    const env = {
      RATE_LIMITER: {
        idFromName,
        get: () => ({ fetch }),
      } as unknown as DurableObjectNamespace,
    } as Env;

    await refreshAllModels(env);
    await refreshProviderModels(env, "p1");
    expect(idFromName).toHaveBeenNthCalledWith(1, "model-refresh");
    expect(idFromName).toHaveBeenNthCalledWith(2, "model-refresh");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://do.internal/models/refresh",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://do.internal/models/refresh/provider/p1",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
