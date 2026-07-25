#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib.mjs";
const base=(process.env.GATEWAY_URL||"http://127.0.0.1:8787").replace(/\/$/,"");let failures=0;
const ok=m=>console.log(`✓ ${m}`),fail=m=>{failures++;console.error(`✗ ${m}`)};
async function req(path,options={}){try{return await fetch(`${base}${path}`,{redirect:"manual",...options})}catch(e){fail(`${path} 无法连接：${e instanceof Error?e.message:String(e)}`);return null}}
async function expect(path,status,options={}){const r=await req(path,options);if(!r)return null;if(r.status===status)ok(`${path} → ${status}`);else fail(`${path} 预期 ${status}，实际 ${r.status}: ${(await r.text()).slice(0,180)}`);return r}
const admin=await expect("/admin",200);if(admin){const html=await admin.text();if(html.includes('id="app"')&&html.includes("/admin/assets/"))ok("/admin 返回 Vue SPA");else fail("/admin 不是 Vue 构建产物")}
await expect("/admin/channels",200);await expect("/admin/api/version",200);
function vars(){const file=join(root,".dev.vars");if(!existsSync(file))return{};return Object.fromEntries(readFileSync(file,"utf8").split(/\r?\n/).map(v=>v.trim()).filter(v=>v&&!v.startsWith("#")&&v.includes("=")).map(v=>{const i=v.indexOf("=");return[v.slice(0,i),v.slice(i+1)]}))}
const env={...vars(),...process.env},username=env.ADMIN_USERNAME||"admin",password=env.ADMIN_PASSWORD||env.ADMIN_TOKEN;
if(password){const login=await expect("/admin/api/login",200,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,password})});const cookie=login?.headers.get("set-cookie")?.split(";",1)[0];if(cookie){ok("登录成功并收到会话 Cookie");for(const path of ["/admin/api/session","/admin/api/channels","/admin/api/providers","/admin/api/settings/proxy","/admin/api/models","/admin/api/quotas"])await expect(path,200,{headers:{cookie}});const overview=await expect("/admin/api/overview",200,{headers:{cookie}});if(overview){const payload=await overview.json().catch(()=>null);if(Array.isArray(payload?.availability))ok("概览 API 返回可用性热力图数据");else fail("概览 API 缺少 availability 数组")}}else if(login)fail("登录响应缺少 Set-Cookie")}else console.log("• 未找到管理员密码，跳过登录测试");
if(failures){console.error(`\n管理台冒烟测试失败：${failures} 项。`);process.exit(1)}console.log("\nCFlareAIProxy Vue 管理台冒烟测试通过。\n");
