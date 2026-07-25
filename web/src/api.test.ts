import { describe, expect, it } from "vitest";
import { normalizeCredentialPageActivity } from "./api";

describe("normalizeCredentialPageActivity", () => {
  it("converts raw activity rows into the record shape used by account cards", () => {
    const payload = normalizeCredentialPageActivity({
      data: [{ id: "credential-1" }],
      activity: {
        "credential-1": [
          { bucket: 100, requests: 2, successes: 2, failures: 0, total_tokens: 40 },
          { bucket: 100, requests: 1, successes: 0, failures: 1, total_tokens: 5 },
          { bucket: 400, requests: "3", successes: "2", failures: "1", total_tokens: "60" },
        ],
      },
    });

    expect(payload.activity["credential-1"]).toEqual({
      buckets: [
        { bucket: 100, requests: 3, successes: 2, failures: 1, tokens: 45 },
        { bucket: 400, requests: 3, successes: 2, failures: 1, tokens: 60 },
      ],
      totals: { requests: 6, successes: 4, failures: 2 },
    });
  });

  it("keeps structured activity compatible while recalculating totals", () => {
    const payload = normalizeCredentialPageActivity({
      activity: {
        "credential-2": {
          buckets: [{ bucket: 200, requests: 4, successes: 3, failures: 1, tokens: 80 }],
          totals: { requests: 0, successes: 0, failures: 0 },
        },
      },
    });

    expect(payload.activity["credential-2"]).toEqual({
      buckets: [{ bucket: 200, requests: 4, successes: 3, failures: 1, tokens: 80 }],
      totals: { requests: 4, successes: 3, failures: 1 },
    });
  });

  it("leaves unrelated API payloads unchanged", () => {
    const payload = { data: ["ok"] };
    expect(normalizeCredentialPageActivity(payload)).toBe(payload);
  });
});
