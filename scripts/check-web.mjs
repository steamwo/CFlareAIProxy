#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib.mjs";
const required=["web/index.html","web/src/main.ts","web/src/App.vue","web/src/router.ts","web/src/views/ChannelsView.vue","web/src/views/ProvidersView.vue","web/src/views/AuthorizationView.vue","vite.config.ts"];
const errors=[];
for(const file of required) if(!existsSync(join(root,file))) errors.push(`缺少 ${file}`);
const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
for(const dep of ["vue","naive-ui","pinia","vue-router"]) if(!pkg.dependencies?.[dep]) errors.push(`缺少前端依赖 ${dep}`);
const config=JSON.parse(readFileSync(join(root,"wrangler.jsonc"),"utf8"));
if(config.assets?.directory!=="./dist") errors.push("assets.directory 必须为 ./dist");
if(config.assets?.not_found_handling!=="single-page-application") errors.push("管理台必须启用 SPA fallback");
const admin=readFileSync(join(root,"src/admin.ts"),"utf8");
if(admin.includes("ADMIN_SCRIPT")||admin.includes("ADMIN_CSS")||admin.includes("adminPage(")) errors.push("后端仍引用旧的内嵌管理页面");
if(!admin.includes('basePath("/admin")')) errors.push("管理 API 未挂载到 /admin");
const providers=readFileSync(join(root,"web/src/views/ProvidersView.vue"),"utf8");
if(!providers.includes("form.apiKey")||!providers.includes("首个 API Key")) errors.push("OpenAI-compatible 供应商表单缺少 API Key");
const authorization=readFileSync(join(root,"web/src/views/AuthorizationView.vue"),"utf8");
if(!authorization.includes("callbackUrl")||!authorization.includes("/exchange")) errors.push("Codex 管理台回调授权未接线");
const router=readFileSync(join(root,"web/src/router.ts"),"utf8");
if(!router.includes('path: "authorization"')||!router.includes("AuthorizationView.vue")) errors.push("独立授权页面未接入路由");
const dashboard=readFileSync(join(root,"web/src/views/DashboardView.vue"),"utf8");
if(!dashboard.includes("heatmapRows")||!dashboard.includes("服务可用性热力图")) errors.push("概览热力图未接线");
if(errors.length){console.error(errors.map(v=>`✗ ${v}`).join("\n"));process.exit(1)}
console.log("✓ Vue 3 + Vite + Naive UI 管理台结构检查通过");
