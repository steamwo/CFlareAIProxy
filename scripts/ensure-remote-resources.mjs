#!/usr/bin/env node
import { runWrangler, runWranglerCapture } from "./lib.mjs";

const requiredQueues = ["cflare-api-usage", "cflare-api-usage-dlq"];

function parseJsonOutput(output) {
  try { return JSON.parse(output); } catch {}
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start >= 0 && end > start) return JSON.parse(output.slice(start, end + 1));
  throw new Error("无法解析 wrangler queues list --json 的输出");
}

function queueNames(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.result) ? payload.result : [];
  return new Set(rows.flatMap((row) => {
    const name = row?.queue_name ?? row?.name ?? row?.queue;
    return typeof name === "string" ? [name] : [];
  }));
}

console.log("• 检查远程 Queues...");
const existing = queueNames(parseJsonOutput(runWranglerCapture(["queues", "list", "--json"])));
for (const name of requiredQueues) {
  if (existing.has(name)) {
    console.log(`  ✓ ${name} 已存在`);
    continue;
  }
  console.log(`  • 创建 ${name}`);
  runWrangler(["queues", "create", name]);
}
console.log("✓ 远程 Queue 资源已就绪");
