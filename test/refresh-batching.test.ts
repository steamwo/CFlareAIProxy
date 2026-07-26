import { describe, expect, it, vi } from "vitest";
import { QUOTA_REFRESH_BATCH_LIMIT, refreshAllQuotas } from "../src/quota";
import { MODEL_REFRESH_BATCH_LIMIT, refreshAllModels } from "../src/models";

/**
 * Both sweeps used to walk every enabled account in one HTTP handler. Each account costs an
 * upstream request plus several D1 round trips, so an unbounded sweep is a deployment that
 * works right up until someone adds the account that crosses the Worker's subrequest
 * ceiling. These tests pin the bound and the ordering that makes the bound safe: without
 * oldest-first ordering, a pool larger than one batch would refresh the same head forever
 * and the tail would never be checked at all.
 */

interface Capture {
  sql: string[];
  binds: unknown[][];
}

function createDb(capture: Capture, credentialIds: string[]) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => {
        capture.sql.push(sql);
        capture.binds.push(args);
        return {
          all: async () => ({ results: credentialIds.map((id) => ({ id })) }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
        };
      },
      all: async () => ({ results: credentialIds.map((id) => ({ id })) }),
      // Only the opencode probe reaches this path; reporting it disabled keeps the anonymous
      // catalogue refresh out of the way of what these tests measure.
      first: async () => ({ enabled: 0 }),
      run: async () => ({ meta: { changes: 0 } }),
    })),
  };
}

describe("quota refresh batching", () => {
  it("asks the database for at most one batch", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllQuotas(env);
    expect(capture.sql[0]).toContain("LIMIT ?");
    expect(capture.binds[0]?.[0]).toBe(QUOTA_REFRESH_BATCH_LIMIT);
  });

  it("takes the least recently checked accounts first", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllQuotas(env);
    // Oldest-first is what lets successive runs rotate through a pool bigger than a batch.
    expect(capture.sql[0]).toMatch(/ORDER BY\s+COALESCE\(q\.fetched_at, 0\) ASC/);
  });

  it("honours an explicit limit", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllQuotas(env, 5);
    expect(capture.binds[0]?.[0]).toBe(5);
  });
});

describe("model refresh batching", () => {
  it("asks the database for at most one batch", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllModels(env);
    expect(capture.sql[0]).toContain("LIMIT ?");
    expect(capture.binds[0]?.[0]).toBe(MODEL_REFRESH_BATCH_LIMIT);
  });

  it("takes the least recently discovered catalogues first", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllModels(env);
    expect(capture.sql[0]).toMatch(/ORDER BY\s+COALESCE\(d\.discovered_at, 0\) ASC/);
  });
});
