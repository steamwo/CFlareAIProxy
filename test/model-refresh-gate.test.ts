import { describe, expect, it, vi } from "vitest";
import { ModelRefreshGate } from "../src/rate-limiter";
import { refreshAllModels } from "../src/models";
import type { Env } from "../src/types";

describe("model refresh coordination", () => {
  it("coalesces overlapping work inside the fixed-name Durable Object", async () => {
    const gate = new ModelRefreshGate();
    let release!: (value: []) => void;
    const pending = new Promise<[]>((resolve) => { release = resolve; });
    const task = vi.fn(() => pending);

    const first = gate.run(task);
    const second = gate.run(task);
    expect(task).toHaveBeenCalledTimes(1);
    release([]);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);

    await gate.run(async () => []);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("routes every production sweep through the same named instance", async () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const fetch = vi.fn(async () => Response.json([]));
    const env = {
      RATE_LIMITER: {
        idFromName,
        get: () => ({ fetch }),
      } as unknown as DurableObjectNamespace,
    } as Env;

    await refreshAllModels(env);
    expect(idFromName).toHaveBeenCalledWith("model-refresh");
    expect(fetch).toHaveBeenCalledWith(
      "https://do.internal/models/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
