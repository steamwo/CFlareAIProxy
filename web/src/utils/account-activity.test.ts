import { describe, expect, it } from "vitest";
import {
  ACTIVITY_BUCKET_SECONDS, ACTIVITY_CELL_COUNT, activityCellLabel, activityCells,
  activitySummary, emptyActivityRecord, successRateClass, type ActivityRecord,
} from "./account-activity";

// Fixed clock so bucket alignment is deterministic.
const NOW_MS = 1_700_000_000_000;
const CURRENT_BUCKET = Math.floor(NOW_MS / 1000 / ACTIVITY_BUCKET_SECONDS) * ACTIVITY_BUCKET_SECONDS;

function record(buckets: ActivityRecord["buckets"]): ActivityRecord {
  const totals = buckets.reduce(
    (result, row) => ({
      requests: result.requests + row.requests,
      successes: result.successes + row.successes,
      failures: result.failures + row.failures,
    }),
    { requests: 0, successes: 0, failures: 0 },
  );
  return { buckets, totals };
}

describe("activityCells", () => {
  it("always renders a fixed-width strip ending at the current bucket", () => {
    const cells = activityCells(emptyActivityRecord(), NOW_MS);

    expect(cells).toHaveLength(ACTIVITY_CELL_COUNT);
    expect(cells[ACTIVITY_CELL_COUNT - 1]?.bucket).toBe(CURRENT_BUCKET);
    expect(cells[0]?.bucket).toBe(CURRENT_BUCKET - (ACTIVITY_CELL_COUNT - 1) * ACTIVITY_BUCKET_SECONDS);
    expect(cells.every((cell) => cell.status === "idle" && cell.level === 0)).toBe(true);
  });

  it("places sparse buckets at their aligned slot and leaves the rest idle", () => {
    const cells = activityCells(
      record([{ bucket: CURRENT_BUCKET, requests: 4, successes: 4, failures: 0, tokens: 90 }]),
      NOW_MS,
    );

    expect(cells[ACTIVITY_CELL_COUNT - 1]).toMatchObject({ requests: 4, status: "success", tokens: 90 });
    expect(cells[0]?.status).toBe("idle");
  });

  it("classifies mixed and fully failed buckets", () => {
    const cells = activityCells(
      record([
        { bucket: CURRENT_BUCKET, requests: 3, successes: 2, failures: 1, tokens: 10 },
        { bucket: CURRENT_BUCKET - ACTIVITY_BUCKET_SECONDS, requests: 2, successes: 0, failures: 2, tokens: 5 },
      ]),
      NOW_MS,
    );

    expect(cells[ACTIVITY_CELL_COUNT - 1]?.status).toBe("mixed");
    expect(cells[ACTIVITY_CELL_COUNT - 2]?.status).toBe("failure");
  });

  it("scales levels between 1 and 4 against the busiest bucket", () => {
    const cells = activityCells(
      record([
        { bucket: CURRENT_BUCKET, requests: 100, successes: 100, failures: 0, tokens: 0 },
        { bucket: CURRENT_BUCKET - ACTIVITY_BUCKET_SECONDS, requests: 1, successes: 1, failures: 0, tokens: 0 },
      ]),
      NOW_MS,
    );

    expect(cells[ACTIVITY_CELL_COUNT - 1]?.level).toBe(4);
    const quiet = cells[ACTIVITY_CELL_COUNT - 2]?.level ?? 0;
    expect(quiet).toBeGreaterThanOrEqual(1);
    expect(quiet).toBeLessThan(4);
  });

  it("ignores buckets outside the visible window", () => {
    const cells = activityCells(
      record([{ bucket: CURRENT_BUCKET - 100 * ACTIVITY_BUCKET_SECONDS, requests: 9, successes: 9, failures: 0, tokens: 1 }]),
      NOW_MS,
    );

    expect(cells.every((cell) => cell.requests === 0)).toBe(true);
  });
});

describe("activitySummary and successRateClass", () => {
  it("derives the success rate and avoids dividing by zero", () => {
    expect(activitySummary(record([{ bucket: 1, requests: 4, successes: 3, failures: 1, tokens: 0 }])).successRate).toBe(75);
    expect(activitySummary(emptyActivityRecord()).successRate).toBe(0);
  });

  it("maps rates onto the badge classes at their thresholds", () => {
    expect(successRateClass({ requests: 0, successes: 0, failures: 0, successRate: 0 })).toBe("status-rate--empty");
    expect(successRateClass({ requests: 10, successes: 10, failures: 0, successRate: 95 })).toBe("status-rate--high");
    expect(successRateClass({ requests: 10, successes: 8, failures: 2, successRate: 80 })).toBe("status-rate--medium");
    expect(successRateClass({ requests: 10, successes: 7, failures: 3, successRate: 79.9 })).toBe("status-rate--low");
  });
});

describe("activityCellLabel", () => {
  it("describes each cell state for assistive technology", () => {
    const [idle, success, failure, mixed] = activityCells(
      record([
        { bucket: CURRENT_BUCKET, requests: 3, successes: 2, failures: 1, tokens: 0 },
        { bucket: CURRENT_BUCKET - ACTIVITY_BUCKET_SECONDS, requests: 2, successes: 0, failures: 2, tokens: 0 },
        { bucket: CURRENT_BUCKET - 2 * ACTIVITY_BUCKET_SECONDS, requests: 2, successes: 2, failures: 0, tokens: 0 },
      ]),
      NOW_MS,
    ).slice(-4);

    expect(idle && activityCellLabel(idle, "10:00")).toBe("10:00：无请求");
    expect(success && activityCellLabel(success, "10:05")).toBe("10:05：2 次请求，全部成功");
    expect(failure && activityCellLabel(failure, "10:10")).toBe("10:10：2 次请求，全部失败");
    expect(mixed && activityCellLabel(mixed, "10:15")).toBe("10:15：3 次请求，成功 2 次，失败 1 次");
  });
});
