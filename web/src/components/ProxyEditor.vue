<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NFormItem, NInput, NModal, NSpace, NTag, useMessage } from "naive-ui";
import { api, jsonBody } from "../api";
import type { ProxySummary } from "../types";

const props = defineProps<{ providerId?: string; summary?: ProxySummary; title?: string }>();
const emit = defineEmits<{ changed: [] }>();
const visible = defineModel<boolean>("show", { default: false });
const value = ref("");
const saving = ref(false);
const testing = ref(false);
const testResult = ref<{
  directIp?: string;
  exitIp?: string;
  ipChanged?: boolean;
  latencyMs?: number;
  warning?: string;
  httpsReady?: boolean;
  testTransport?: "http" | "https";
  tlsError?: string;
} | null>(null);
const message = useMessage();
watch(visible, (open) => { if (open) { value.value = ""; testResult.value = null; } });
const endpoint = computed(() => props.providerId ? `/providers/${props.providerId}/proxy` : "/settings/proxy");

async function save() {
  saving.value = true;
  try {
    const result = await api<{ data?: ProxySummary }>(endpoint.value, { method: "PUT", body: jsonBody({ proxyUrl: value.value.trim() }) });
    if (result.data?.enabled && result.data.runtimeReady === false) message.error("代理格式已保存，但当前运行时不支持该协议");
    else message.success("代理已保存；后续请求失败时不会偷偷回退直连");
    emit("changed");
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { saving.value = false; }
}
async function clear() {
  saving.value = true;
  try { await api(endpoint.value, { method: "DELETE" }); message.success("已恢复默认代理"); visible.value = false; emit("changed"); }
  catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { saving.value = false; }
}
async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    const testEndpoint = props.providerId ? `/providers/${props.providerId}/proxy/test` : "/settings/proxy/test";
    const result = await api<{
      directIp?: string;
      exitIp?: string;
      ipChanged?: boolean;
      latencyMs?: number;
      warning?: string;
      httpsReady?: boolean;
      testTransport?: "http" | "https";
      tlsError?: string;
    }>(testEndpoint, { method: "POST" });
    testResult.value = result;
    if (result.httpsReady === false) message.warning(result.warning || "代理可连接，但 HTTPS 隧道不可用");
    else if (result.ipChanged === false) message.warning(result.warning || "代理出口与 Worker 直连出口相同");
    else message.success(`代理出口已生效：${result.exitIp ?? "已连接"}`);
  } catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
  finally { testing.value = false; }
}
</script>

<template>
  <n-modal v-model:show="visible" preset="card" :title="title || (providerId ? '设置覆盖代理' : '设置系统代理')" style="width:min(620px,calc(100vw - 32px))">
    <n-alert type="info" :bordered="false" style="margin-bottom:16px">
      只填代理 URL：<span class="mono">http://user:pass@host:port</span>、<span class="mono">socks5://host:port</span> 或 <span class="mono">socks5h://host:port</span>。
      Codex 换 Token、模型、额度和推理会共用这个出口。代理失败会直接报错，不会静默改走 Worker IP。
    </n-alert>
    <n-form-item label="代理 URL"><n-input v-model:value="value" clearable placeholder="http://user:pass@host:port 或 socks5://host:port" /></n-form-item>
    <n-alert
      v-if="testResult"
      :type="testResult.httpsReady === false || testResult.ipChanged === false ? 'warning' : 'success'"
      :bordered="false"
      style="margin-bottom:16px"
    >
      Worker 直连：<span class="mono">{{ testResult.directIp || '未知' }}</span><br />
      代理出口：<span class="mono">{{ testResult.exitIp || '未知' }}</span>
      <span v-if="testResult.latencyMs"> · {{ testResult.latencyMs }} ms</span><br />
      HTTPS 隧道：<strong>{{ testResult.httpsReady === false ? '不可用' : '可用' }}</strong>
      <span v-if="testResult.testTransport"> · 出口检测使用 {{ testResult.testTransport.toUpperCase() }}</span>
      <template v-if="testResult.warning"><br />{{ testResult.warning }}</template>
      <template v-if="testResult.tlsError"><br /><span class="mono">{{ testResult.tlsError }}</span></template>
    </n-alert>
    <n-space justify="space-between">
      <n-space>
        <n-tag v-if="summary?.enabled" :type="summary.runtimeReady === false ? 'error' : 'success'">当前：{{ summary.proxyProtocol }}://{{ summary.proxyHost }}</n-tag>
        <n-tag v-else>当前直连</n-tag>
      </n-space>
      <n-space>
        <n-button :loading="testing" :disabled="!summary?.enabled" @click="test">验证出口 IP</n-button>
        <n-button secondary type="warning" :loading="saving" @click="clear">{{ providerId ? "清除覆盖" : "清除系统代理" }}</n-button>
        <n-button type="primary" :loading="saving" :disabled="!value.trim()" @click="save">保存</n-button>
      </n-space>
    </n-space>
  </n-modal>
</template>
