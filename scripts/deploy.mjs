#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWranglerResult } from "./lib.mjs";

const extra = process.argv.slice(2);
const dryRun = extra.includes("--dry-run");

function commandOutput(result) {
  return [result.stdout, result.stderr]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function runWrangler(args, options = {}) {
  const result = runWranglerResult(args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}

function parseSecretList(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("Unable to parse wrangler secret list output");
  const rows = JSON.parse(output.slice(start, end + 1));
  return new Set(Array.isArray(rows) ? rows.flatMap((row) => typeof row?.name === "string" ? [row.name] : []) : []);
}

function listRemoteSecretNames() {
  const result = runWranglerResult(["secret", "list", "--format", "json"], { encoding: "utf8" });
  if (!result.error && result.status === 0) return parseSecretList(commandOutput(result));

  const detail = commandOutput(result);
  if (/10090|not found|does not exist|could not find/i.test(detail)) {
    // The Worker does not exist yet. The generated secrets will be uploaded
    // atomically with its first deployment.
    return new Set();
  }
  if (result.error) throw result.error;
  throw new Error(detail || "Unable to list Worker secrets");
}

function generateMissingInternalSecrets(existing) {
  const generated = {};
  if (!existing.has("ADMIN_TOKEN")) {
    generated.ADMIN_TOKEN = randomBytes(32).toString("hex");
  }
  if (!existing.has("MASTER_KEY")) {
    generated.MASTER_KEY = randomBytes(32).toString("base64");
  }
  return generated;
}

if (!dryRun) {
  await import("./ensure-remote-resources.mjs");
}

let temporaryDirectory;
try {
  const deployArgs = ["deploy", ...extra];
  if (!dryRun) {
    console.log("• 检查 Worker 内部密钥...");
    const generated = generateMissingInternalSecrets(listRemoteSecretNames());
    const names = Object.keys(generated);
    if (names.length) {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "cflare-api-secrets-"));
      const secretsFile = join(temporaryDirectory, "secrets.json");
      writeFileSync(secretsFile, JSON.stringify(generated), { encoding: "utf8", mode: 0o600 });
      deployArgs.push("--secrets-file", secretsFile);
      for (const name of names) console.log(`  ✓ ${name} 不存在，已安全生成并随本次部署上传`);
    } else {
      console.log("  ✓ ADMIN_TOKEN 与 MASTER_KEY 已存在，将保留原值");
    }
  }

  console.log("• 部署 Worker；Wrangler 将自动配置 D1/KV，并注册 Durable Objects/Queues...");
  runWrangler(deployArgs);

  if (!dryRun) {
    console.log("• 应用远程 D1 迁移...");
    runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--yes"]);
    console.log("• 验证远程 D1 schema...");
    runWrangler([
      "d1", "execute", "DB", "--remote", "--yes", "--json",
      "--command", "SELECT COUNT(*) AS provider_count FROM providers",
    ]);
    console.log("✓ CFlareAPI 部署、密钥初始化和数据库迁移完成");
  }
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
