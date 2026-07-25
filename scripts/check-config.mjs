#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib.mjs";

const EXPECTED_WORKER_NAME = "cfap";
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const errors = [];
if (config.name !== EXPECTED_WORKER_NAME) errors.push(`Worker name must be ${EXPECTED_WORKER_NAME}`);
if (String(JSON.stringify(config)).includes("REPLACE_WITH")) errors.push("wrangler.jsonc contains placeholder resource IDs");
const db = config.d1_databases?.find((item) => item.binding === "DB");
if (!db) errors.push("Missing DB binding");
if (db?.database_id) errors.push("DB should use automatic provisioning and must not contain a template database_id");
const kv = config.kv_namespaces?.find((item) => item.binding === "CONFIG_CACHE");
if (!kv) errors.push("Missing CONFIG_CACHE binding");
if (kv?.id) errors.push("CONFIG_CACHE should use automatic provisioning and must not contain a template id");
for (const required of ["AccountPool", "RateLimiter"]) {
  if (!config.migrations?.some((m) => m.new_sqlite_classes?.includes(required))) errors.push(`Missing SQLite Durable Object migration for ${required}`);
}
const entrypointPath = typeof config.main === "string" ? join(root, config.main) : null;
if (!entrypointPath || !existsSync(entrypointPath)) {
  errors.push("Worker entrypoint file is missing");
} else {
  const entrypoint = readFileSync(entrypointPath, "utf8");
  for (const required of ["AccountPool", "RateLimiter"]) {
    const namedExport = new RegExp(`export\\s*\\{[^}]*\\b${required}\\b[^}]*\\}`, "s");
    const directExport = new RegExp(`export\\s+(?:class|const|function)\\s+${required}\\b`);
    if (!namedExport.test(entrypoint) && !directExport.test(entrypoint)) {
      errors.push(`Worker entrypoint must export Durable Object ${required}`);
    }
  }
}
for (const scriptName of ["deploy", "deploy:worker"]) {
  const command = packageJson.scripts?.[scriptName];
  if (typeof command !== "string" || !command.includes("node scripts/deploy.mjs")) {
    errors.push(`${scriptName} must run node scripts/deploy.mjs so secrets and remote D1 migrations are initialized`);
  }
}
if (errors.length) {
  console.error(errors.map((item) => `✗ ${item}`).join("\n"));
  process.exit(1);
}
console.log("✓ wrangler.jsonc and deployment entrypoint checks passed");