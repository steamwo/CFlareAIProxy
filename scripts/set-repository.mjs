#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib.mjs";

const repository = process.argv[2]?.replace(/\/$/, "");
if (!repository || !/^https:\/\/(github\.com|gitlab\.com)\//i.test(repository)) {
  console.error("用法：npm run set-repository -- https://github.com/<owner>/<repo>");
  process.exit(1);
}
const path = join(root, "README.md");
const current = readFileSync(path, "utf8");
const next = current.replaceAll("https://github.com/YOUR_ACCOUNT/CFlareAIProxy", repository);
writeFileSync(path, next);
console.log(`✓ README 的一键部署地址已更新为 ${repository}`);
