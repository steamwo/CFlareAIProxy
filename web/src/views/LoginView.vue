<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NButton, NCard, NForm, NFormItem, NIcon, NInput, NText, useMessage } from "naive-ui";
import { KeyRound } from "@lucide/vue";
import SystemLogo from "../components/SystemLogo.vue";
import { useSessionStore } from "../stores/session";

const username = ref("admin");
const password = ref("");
const route = useRoute();
const router = useRouter();
const store = useSessionStore();
const message = useMessage();
async function submit() {
  try {
    await store.login(username.value, password.value);
    message.success("登录成功");
    await router.replace(typeof route.query.redirect === "string" ? route.query.redirect : "/");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  }
}
</script>

<template>
  <div class="login-shell">
    <n-card class="login-card" size="large" :bordered="false">
      <div class="brand-row"><system-logo :size="50" /><div><h1>CFlareAIProxy</h1><p>Cloudflare Workers AI Gateway</p></div></div>
      <n-form @submit.prevent="submit">
        <n-form-item label="管理员用户名"><n-input v-model:value="username" size="large" autocomplete="username" /></n-form-item>
        <n-form-item label="管理员密码">
          <n-input v-model:value="password" type="password" show-password-on="click" size="large" autocomplete="current-password" @keyup.enter="submit">
            <template #prefix><n-icon><key-round /></n-icon></template>
          </n-input>
        </n-form-item>
        <n-button block type="primary" size="large" :loading="store.loading" @click="submit">登录管理台</n-button>
      </n-form>
      <n-text depth="3" style="display:block;text-align:center;margin-top:18px;font-size:12px">凭据仅用于创建 HttpOnly 会话，不会写入浏览器存储。</n-text>
    </n-card>
  </div>
</template>
