import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function missingWranglerError() {
  return new Error(
    "未找到本地 Wrangler。请先在项目目录运行 pnpm install（或 npm install）。",
  );
}

/**
 * Return a cross-platform Wrangler invocation.
 *
 * On Windows, executing node_modules/.bin/wrangler.cmd directly through
 * child_process can fail with EINVAL/ENOENT on some Node + pnpm setups.
 * Running Wrangler's JavaScript entry point with the current Node executable
 * avoids cmd.exe quoting and shell-wrapper differences.
 */
export function wranglerInvocation() {
  const jsEntry = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  if (existsSync(jsEntry)) {
    return {
      command: process.execPath,
      prefixArgs: [jsEntry],
      display: `${process.execPath} ${jsEntry}`,
    };
  }

  // Fallback for unusual dependency layouts. Unix shims are executable
  // directly; Windows .cmd files require a shell.
  const shim = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  if (existsSync(shim)) {
    return {
      command: shim,
      prefixArgs: [],
      display: shim,
      shell: process.platform === "win32",
    };
  }

  throw missingWranglerError();
}

export function hasLocalWrangler() {
  try {
    wranglerInvocation();
    return true;
  } catch {
    return false;
  }
}

export function runWranglerResult(args, options = {}) {
  let invocation;
  try {
    invocation = wranglerInvocation();
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  return spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: root,
    env: process.env,
    shell: invocation.shell ?? false,
    ...options,
  });
}

export function spawnWrangler(args, options = {}) {
  const invocation = wranglerInvocation();
  return spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd: root,
    env: process.env,
    shell: invocation.shell ?? false,
    ...options,
  });
}

export function runWrangler(args, options = {}) {
  const result = runWranglerResult(args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

export function runWranglerCapture(args) {
  const result = runWranglerResult(args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const detail = [result.stdout, result.stderr]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(detail || `wrangler ${args.join(" ")} 执行失败`);
  }
  return String(result.stdout ?? "");
}
