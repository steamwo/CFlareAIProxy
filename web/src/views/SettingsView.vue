<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  NAlert, NButton, NCard, NDivider, NFormItem, NSelect, NSpace, NSwitch, NTag, useMessage,
} from "naive-ui";
import { Network, RefreshCw, Route, Save, ScrollText } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import ProxyEditor from "../components/ProxyEditor.vue";
import { api, jsonBody } from "../api";
import type { ProxySummary } from "../types";

type LogLevel = "error" | "warn" | "info" | "debug";
interface LoggingSettings {
  requestLoggingEnabled: boolean;
  level: LogLevel;
}

const proxy = ref<ProxySummary | null>(null);
const logging = ref<LoggingSettings>({ requestLoggingEnabled: true, level: "error" });
const loading = ref(false);
const savingLogging = ref(false);
const modal = ref(false);
const message = useMessage();
const levelOptions = [
  { label: "错误 · 仅输出错误，长期保存 5xx / 内部错误明细", value: "error" },
  { label: "警告 · 输出警告和错误，长期保存全部失败明细", value: "warn" },
  { label: "信息 · 增加队列批次等运行信息", value: "info" },
  { label: "调试 · 输出每次请求完成信息，日志量最大", value: "debug" },
];

async function load() {
  loading.value = true;
  try {
    const [proxyResult, loggingResult] = await Promise.all([
      api<{ data: ProxySummary }>("/settings/proxy"),
      api<{ data: LoggingSettings }>("/settings/logging"),
    ]);
    proxy.value = proxyResult.data;
    logging.value = loggingResult.data;
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function saveLogging() {
  savingLogging.value = true;
  try {
    const result = await api<{ data: LoggingSettings }>("/settings/logging", {
      method: "PUT",
      body: jsonBody(logging.value),
    });
    logging.value = result.data;
    message.success("日志设置已保存");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingLogging.value = false;
  }
}

onMounted(load);
</script>

<template>
  <page-header title="系统设置" description="集中管理运行日志与系统默认网络策略。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <n-card class="settings-shell" :bordered="false">
    <section class="settings-section">
      <div class="section-heading">
        <span class="section-icon"><scroll-text :size="18" /></span>
        <div>
          <h2>请求日志与基础统计</h2>
          <p>控制单次错误明细和 Worker 运行日志；基础聚合统计始终保持开启。</p>
        </div>
        <n-tag :type="logging.requestLoggingEnabled ? 'success' : 'default'" round>
          {{ logging.requestLoggingEnabled ? '日志已开启' : '日志已关闭' }}
        </n-tag>
      </div>

      <n-alert type="info" :bordered="false" class="section-alert">
        成功与失败请求会按 5 分钟聚合写入 Queue。成功请求不会永久保存单次明细，关闭日志也不会影响账号池健康度和概览统计。
      </n-alert>

      <div class="setting-list">
        <div class="setting-row">
          <div class="setting-copy">
            <strong>请求明细与运行日志</strong>
            <span>保存错误请求明细，并按所选级别输出结构化 Worker 日志。</span>
          </div>
          <n-switch v-model:value="logging.requestLoggingEnabled" />
        </div>
        <div class="setting-row setting-row--control">
          <div class="setting-copy">
            <strong>运行日志级别</strong>
            <span>生产环境建议使用“错误”或“警告”，避免产生不必要的日志量。</span>
          </div>
          <n-form-item :show-label="false" :show-feedback="false" class="setting-control">
            <n-select v-model:value="logging.level" :options="levelOptions" :disabled="!logging.requestLoggingEnabled" />
          </n-form-item>
        </div>
      </div>

      <div class="section-actions">
        <n-button type="primary" :loading="savingLogging" @click="saveLogging">
          <template #icon><save /></template>保存日志设置
        </n-button>
      </div>
    </section>

    <n-divider />

    <section class="settings-section">
      <div class="section-heading">
        <span class="section-icon"><network :size="18" /></span>
        <div>
          <h2>系统默认代理</h2>
          <p>为没有账号级或供应商级覆盖配置的请求提供统一出口。</p>
        </div>
        <n-tag :type="proxy?.enabled ? 'success' : 'default'" round>
          {{ proxy?.enabled ? `${proxy.proxyProtocol}://${proxy.proxyHost}` : '直连' }}
        </n-tag>
      </div>

      <div class="setting-list">
        <div class="setting-row setting-row--control">
          <div class="setting-copy">
            <strong>默认 Proxy URL</strong>
            <span>支持 http://、socks5:// 和 socks5h://。账号或供应商单独设置后会覆盖这里。</span>
          </div>
          <n-space align="center" justify="end" class="setting-control">
            <n-button type="primary" secondary @click="modal = true">
              <template #icon><route /></template>{{ proxy?.enabled ? '修改代理' : '设置代理' }}
            </n-button>
          </n-space>
        </div>
      </div>

      <n-alert v-if="proxy?.enabled && proxy.runtimeReady === false" type="warning" :bordered="false" class="section-alert section-alert--bottom">
        当前 Worker 无法原生处理该代理协议。系统不会静默回退直连，请改用受支持的协议。
      </n-alert>
    </section>
  </n-card>

  <proxy-editor v-model:show="modal" :summary="proxy || undefined" title="系统默认代理" @changed="load" />
</template>

<style scoped>
.settings-shell { border: 1px solid var(--n-border-color); border-radius: 16px; box-shadow: 0 10px 28px rgba(15, 23, 42, .045); }
.settings-shell :deep(.n-card__content) { padding: 22px 24px; }
.settings-section { display: flex; flex-direction: column; gap: 18px; }
.section-heading { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.section-heading h2 { margin: 0; font-size: 16px; line-height: 1.35; }
.section-heading p { margin: 4px 0 0; color: var(--n-text-color-3); font-size: 12px; }
.section-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; color: #2563eb; background: rgba(59, 130, 246, .1); }
.section-alert { margin-left: 50px; }
.setting-list { margin-left: 50px; border: 1px solid var(--n-border-color); border-radius: 12px; overflow: hidden; }
.setting-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 24px; min-height: 72px; padding: 14px 16px; }
.setting-row + .setting-row { border-top: 1px solid var(--n-border-color); }
.setting-row:hover { background: color-mix(in srgb, var(--n-color-embedded) 58%, transparent); }
.setting-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.setting-copy strong { font-size: 13px; }
.setting-copy span { color: var(--n-text-color-3); font-size: 11px; line-height: 1.55; }
.setting-control { width: min(420px, 40vw); margin: 0; }
.section-actions { display: flex; justify-content: flex-end; margin-left: 50px; }
.section-alert--bottom { margin-top: 0; }
@media (max-width: 720px) {
  .settings-shell :deep(.n-card__content) { padding: 18px; }
  .section-heading { grid-template-columns: 36px minmax(0, 1fr); }
  .section-heading > .n-tag { grid-column: 2; justify-self: start; }
  .section-alert, .setting-list, .section-actions { margin-left: 0; }
  .setting-row { grid-template-columns: 1fr; gap: 12px; }
  .setting-control { width: 100%; }
  .section-actions { justify-content: stretch; }
  .section-actions :deep(.n-button) { width: 100%; }
}
</style>
