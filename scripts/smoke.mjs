#!/usr/bin/env node
import process from "node:process";
const base = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/$/, "");
const key = process.env.GATEWAY_API_KEY;
const health = await fetch(`${base}/health`);
console.log("health", health.status, await health.text());
if (key) {
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  console.log("models", models.status, await models.text());
} else {
  console.log("设置 GATEWAY_API_KEY 后可测试 /v1/models");
}
