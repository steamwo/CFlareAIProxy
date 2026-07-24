<script setup lang="ts">
import { onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NFormItem, NSelect, NSpace, NSwitch, NTag, useMessage } from "naive-ui";
import { RefreshCw, Route, Save } from "@lucide/vue";
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
  { label: "错误 · 仅输出错误，长期保存 5xx/内部错误明细", value: "error" },
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
  <page-header title="系统设置" description="控制系统默认代理、请求统计和运行日志。">
    <n-button :loading="loading" @click="load"><template #icon><refresh-cw /></template>刷新</n-button>
  </page-header>

  <div class="settings-grid">
    <n-card title="请求日志与统计">
      <template #header-extra>
        <n-tag :type="logging.requestLoggingEnabled ? 'success' : 'default'">
          {{ logging.requestLoggingEnabled ? '已开启' : '已关闭' }}
        </n-tag>
      </template>
      <n-alert type="info" :bordered="false" class="settings-alert">
        开启后，成功和失败请求先在 RateLimiter Durable Object 中按 5 分钟聚合，再以聚合消息写入 Queue；成功请求不会永久保存明细，失败请求才会进入错误日志表。
      </n-alert>
      <n-alert type="warning" :bordered="false" class="settings-alert">
        关闭后不会产生新的请求统计，账号池近 2 小时状态和概览调用量将逐渐变为空。调试级别还会增加 Workers Logs 写入量，免费版不建议长期启用。
      </n-alert>
      <n-form-item label="记录请求统计">
        <n-switch v-model:value="logging.requestLoggingEnabled" />
      </n-form-item>
      <n-form-item label="运行日志级别">
        <n-select v-model:value="logging.level" :options="levelOptions" />
      </n-form-item>
      <n-button type="primary" :loading="savingLogging" @click="saveLogging">
        <template #icon><save /></template>保存日志设置
      </n-button>
    </n-card>

    <n-card title="系统默认代理">
      <template #header-extra>
        <n-tag :type="proxy?.enabled ? 'success' : 'default'">
          {{ proxy?.enabled ? `${proxy.proxyProtocol}://${proxy.proxyHost}` : '直连' }}
        </n-tag>
      </template>
      <n-alert type="info" :bordered="false" class="settings-alert">
        只需要设置一个 Proxy URL。未设置覆盖代理的内置渠道和 OpenAI-compatible 供应商会继承它。
      </n-alert>
      <n-alert v-if="proxy?.enabled && proxy.runtimeReady === false" type="warning" :bordered="false">
        该代理协议无法由当前 Worker 原生处理。请改用 http://、socks5:// 或 socks5h://；系统不会静默回退直连。
      </n-alert>
      <n-space style="margin-top:18px">
        <n-button type="primary" @click="modal = true"><template #icon><route /></template>设置 Proxy URL</n-button>
      </n-space>
    </n-card>
  </div>

  <proxy-editor v-model:show="modal" :summary="proxy || undefined" title="系统默认代理" @changed="load" />
</template>

<style scoped>
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; align-items: start; }
.settings-alert { margin-bottom: 14px; }
</style>
