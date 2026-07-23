#!/usr/bin/env node
import { runWrangler } from "./lib.mjs";

const extra = process.argv.slice(2);
const dryRun = extra.includes("--dry-run");

if (!dryRun) {
  await import("./ensure-remote-resources.mjs");
}

console.log("• 部署 Worker；Wrangler 将自动配置 D1/KV，并注册 Durable Objects/Queues...");
runWrangler(["deploy", ...extra]);

if (!dryRun) {
  console.log("• 应用远程 D1 迁移...");
  runWrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  console.log("✓ CFlareAPI 部署和数据库迁移完成");
}
