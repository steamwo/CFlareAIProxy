import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production deploy ordering", () => {
  it("applies and verifies remote D1 migrations before publishing the Worker", () => {
    const source = readFileSync(new URL("../scripts/deploy.mjs", import.meta.url), "utf8");
    const migrate = source.indexOf('runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--yes"]);');
    const verify = source.indexOf('"--command", "SELECT COUNT(*) AS provider_count FROM providers"');
    const deploy = source.indexOf("runWrangler(deployArgs);");

    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(migrate);
    expect(deploy).toBeGreaterThan(verify);
  });
});
