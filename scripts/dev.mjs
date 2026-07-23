#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { root, spawnWrangler } from "./lib.mjs";
await import("./setup-local.mjs");
const viteEntry=join(root,"node_modules","vite","bin","vite.js");
if(!existsSync(viteEntry)){console.error("缺少 Vite。请先运行 pnpm install（或 npm install）。");process.exit(1)}
const build=spawn(process.execPath,[viteEntry,"build"],{cwd:root,stdio:"inherit"});
const code=await new Promise(resolve=>build.on("exit",resolve));
if(code!==0) process.exit(Number(code)||1);
const web=spawn(process.execPath,[viteEntry,"build","--watch"],{cwd:root,stdio:"inherit"});
let worker;
try{worker=spawnWrangler(["dev","--local",...process.argv.slice(2)],{stdio:"inherit"});}
catch(error){web.kill();console.error(`无法启动 Wrangler：${error instanceof Error?error.message:String(error)}`);process.exit(1)}
let stopping=false;
function stop(signal){if(stopping)return;stopping=true;web.kill(signal);worker.kill(signal);}
for(const signal of ["SIGINT","SIGTERM"]) process.on(signal,()=>stop(signal));
web.on("error",error=>{console.error(`Vite 构建监听失败：${error.message}`);stop("SIGTERM")});
worker.on("error",error=>{console.error(`Wrangler 进程启动失败：${error.message}`);stop("SIGTERM")});
worker.on("exit",(exitCode,signal)=>{stop(signal||"SIGTERM");process.exit(exitCode??1)});
