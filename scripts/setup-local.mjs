#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { root, runWrangler } from "./lib.mjs";

const path = join(root, ".dev.vars");
if (!existsSync(path)) {
  const username = "admin";
  const password = randomBytes(18).toString("base64url");
  const content = [
    `MASTER_KEY=${randomBytes(32).toString("base64")}`,
    `ADMIN_TOKEN=${randomBytes(32).toString("hex")}`,
    `ADMIN_USERNAME=${username}`,
    `ADMIN_PASSWORD=${password}`,
    "",
  ].join("\n");
  writeFileSync(path, content, { mode: 0o600 });
  console.log("✓ 已生成 .dev.vars（不会提交到 Git）");
  console.log(`  管理台用户名：${username}`);
  console.log(`  管理台密码：  ${password}`);
  console.log("  请保存以上密码；也可以直接编辑 .dev.vars 修改。");
} else {
  const text = readFileSync(path, "utf8");
  const required = ["MASTER_KEY", "ADMIN_TOKEN"];
  const missing = required.filter((key) => !new RegExp(`^${key}=.+$`, "m").test(text));
  if (missing.length) {
    console.error(`.dev.vars 缺少：${missing.join(", ")}`);
    process.exit(1);
  }
  if (!/^ADMIN_USERNAME=.+$/m.test(text) || !/^ADMIN_PASSWORD=.+$/m.test(text)) {
    console.warn("! 当前 .dev.vars 未设置 ADMIN_USERNAME / ADMIN_PASSWORD；管理台将使用用户名 admin，并把 ADMIN_TOKEN 作为兼容登录密码。");
  }
  console.log("• 使用现有 .dev.vars");
}

console.log("• 初始化本地 D1 数据库...");
runWrangler(["d1", "migrations", "apply", "DB", "--local"]);
console.log("✓ 本地环境已就绪");
