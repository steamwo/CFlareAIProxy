#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_WORKER_NAME, hasLocalWrangler, root, runWranglerResult } from "./lib.mjs";

const checks = [];
const pass = (message) => checks.push({ ok: true, message });
const fail = (message) => checks.push({ ok: false, message });
const text = (value) => String(value ?? "").trim();

const major = Number(process.versions.node.split(".")[0]);
if (major > 20 || (major === 20 && Number(process.versions.node.split(".")[1]) >= 19)) pass(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node}（需要 20 或更高版本）`);

const packagePath = join(root, "package.json");
const configPath = join(root, "wrangler.jsonc");
let packageVersion = "";
if (existsSync(packagePath)) {
  pass("package.json 存在");
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  } catch (error) {
    fail(`package.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
} else fail("缺少 package.json");

if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.name === EXPECTED_WORKER_NAME) pass(`Worker 名称为 ${EXPECTED_WORKER_NAME}`);
    else fail(`wrangler.jsonc 的 name 必须为 ${EXPECTED_WORKER_NAME}`);

    const raw = JSON.stringify(config);
    if (!raw.includes("REPLACE_WITH")) pass("没有占位资源 ID");
    else fail("wrangler.jsonc 仍包含 REPLACE_WITH 占位值");

    const db = config.d1_databases?.find((item) => item.binding === "DB");
    if (db && !db.database_id) pass("D1 使用自动配置");
    else fail("D1 绑定缺失，或模板中写入了固定 database_id");

    const kv = config.kv_namespaces?.find((item) => item.binding === "CONFIG_CACHE");
    if (kv && !kv.id) pass("KV 使用自动配置");
    else fail("KV 绑定缺失，或模板中写入了固定 id");
  } catch (error) {
    fail(`wrangler.jsonc 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  fail("缺少 wrangler.jsonc");
}

if (hasLocalWrangler()) {
  const result = runWranglerResult(["--version"], { encoding: "utf8" });
  if (result.error) {
    fail(`Wrangler 无法启动：${result.error.message}`);
  } else if (result.status === 0) {
    const version = text(result.stdout) || text(result.stderr) || "版本检查通过";
    pass(`Wrangler ${version}`);
  } else {
    const detail = text(result.stderr) || text(result.stdout);
    const status = result.status === null ? "未知" : String(result.status);
    const signal = result.signal ? `，signal=${result.signal}` : "";
    fail(`Wrangler 无法运行（exit=${status}${signal}）：${detail || "没有返回错误信息"}`);
  }
} else {
  fail("尚未安装依赖；请运行 pnpm install（或 npm install）");
}


const ADMIN_IMPORT = /import\s*\{[^}]*\bcreateAdminApp\b[^}]*\}\s*from\s*["']\.\/admin["']/;
const ROOT_MOUNT = /app\.route\(\s*["']\/["']\s*,\s*([A-Za-z_$][\w$]*)\s*(\(\s*\))?\s*\)/g;

/**
 * Structural check: the admin app must be imported and mounted at the root.
 * Accepts both a direct `app.route("/", createAdminApp())` and an indirect
 * mount through a local binding — the wiring is the contract, not its spelling.
 */
function mountsAdminApp(source) {
  if (!ADMIN_IMPORT.test(source)) return false;
  for (const match of source.matchAll(ROOT_MOUNT)) {
    const identifier = match[1];
    if (!identifier) continue;
    if (identifier === "createAdminApp" && match[2]) return true;
    if (new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=\\s*createAdminApp\\s*\\(`).test(source)) return true;
  }
  return false;
}

const indexSourcePath = join(root, "src", "index.ts");
const adminSourcePath = join(root, "src", "admin.ts");
if (existsSync(indexSourcePath) && existsSync(adminSourcePath)) {
  const indexSource = readFileSync(indexSourcePath, "utf8");
  const adminSource = readFileSync(adminSourcePath, "utf8");
  if (mountsAdminApp(indexSource) && adminSource.includes('.basePath("/admin")')) {
    pass("管理 API /admin/api 路由接线完整");
  } else {
    fail("管理台路由接线不完整：src/index.ts 需要导入 createAdminApp 并用 app.route(\"/\", ...) 挂载，src/admin.ts 需要 .basePath(\"/admin\")");
  }
  const adminVersion = adminSource.match(/const\s+ADMIN_UI_VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? "";
  if (packageVersion && adminVersion === packageVersion) pass(`管理 API 版本与 package.json 一致（${adminVersion}）`);
  else fail(`管理 API 源码版本不匹配（package.json=${packageVersion || "未知"}，admin=${adminVersion || "未知"}）`);
}

const webIndex = join(root, "web", "index.html");
const webMain = join(root, "web", "src", "main.ts");
if (existsSync(webIndex) && existsSync(webMain)) pass("Vue 3 管理台源码存在");
else fail("缺少 web/ Vue 管理台源码");

const proxyMigrationPath = join(root, "migrations", "0004_provider_proxy.sql");
if (existsSync(proxyMigrationPath) && readFileSync(proxyMigrationPath, "utf8").includes("CREATE TABLE IF NOT EXISTS provider_proxies")) {
  pass("供应商代理 D1 migration 存在");
} else {
  fail("缺少供应商代理 migration 0004_provider_proxy.sql");
}

// Native TCP proxying must exist somewhere under src/, but which module owns
// the cloudflare:sockets import is an implementation detail that may move.
const nativeSocketOwner = readdirSync(join(root, "src"), { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
  .find((entry) => readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8").includes('from "cloudflare:sockets"'));
if (nativeSocketOwner) {
  pass("供应商代理使用 Cloudflare 原生 TCP（无需 Bridge）");
} else {
  fail("缺少 Cloudflare 原生 HTTP/SOCKS 代理实现：src/ 下没有任何模块导入 cloudflare:sockets");
}

const devVars = join(root, ".dev.vars");
if (!existsSync(devVars)) {
  pass(".dev.vars 尚未创建；首次 pnpm run dev 会自动生成");
} else {
  const content = readFileSync(devVars, "utf8");
  const missing = ["MASTER_KEY", "ADMIN_TOKEN"].filter(
    (key) => !new RegExp(`^${key}=.+$`, "m").test(content),
  );
  if (missing.length === 0) pass(".dev.vars 包含加密和会话签名密钥");
  else fail(`.dev.vars 缺少 ${missing.join(", ")}`);
  if (/^ADMIN_USERNAME=.+$/m.test(content) && /^ADMIN_PASSWORD=.+$/m.test(content)) {
    pass(".dev.vars 包含管理台用户名和密码");
  } else {
    pass("未设置独立登录密码；将兼容使用 admin + ADMIN_TOKEN 登录");
  }
}

for (const item of checks) {
  console.log(`${item.ok ? "✓" : "✗"} ${item.message}`);
}

if (checks.some((item) => !item.ok)) {
  console.error("\n诊断未通过。修复以上项目后重新运行 pnpm run doctor。");
  process.exit(1);
}

console.log("\nCFlareAIProxy 本地环境检查通过。运行 pnpm run dev 即可启动。\n");
