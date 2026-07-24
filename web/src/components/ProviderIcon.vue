<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = withDefaults(defineProps<{ providerId: string; name?: string; size?: number }>(), { name: "", size: 24 });
const failed = ref(false);
const normalized = computed(() => props.providerId.toLowerCase());
const iconSources: Record<string, string> = {
  codex: "https://openai.com/favicon.ico",
  openai: "https://openai.com/favicon.ico",
  kimi: "https://statics.moonshot.cn/kimi-web-seo/favicon.ico",
  moonshot: "https://statics.moonshot.cn/kimi-web-seo/favicon.ico",
  qoder: "https://qoder.com/favicon.ico",
  opencode: "https://opencode.ai/favicon.svg",
  "opencode-zen": "https://opencode.ai/favicon.svg",
};
const iconUrl = computed(() => iconSources[normalized.value] ?? "");
const fallback = computed(() => (props.name || props.providerId).trim().slice(0, 1).toUpperCase() || "AI");
watch(() => props.providerId, () => { failed.value = false; });
</script>

<template>
  <span class="provider-icon" :style="{ width: `${size}px`, height: `${size}px` }" :title="name || providerId">
    <img
      v-if="iconUrl && !failed"
      :src="iconUrl"
      :alt="`${name || providerId} logo`"
      referrerpolicy="no-referrer"
      @error="failed = true"
    />
    <span v-else class="provider-icon__fallback">{{ fallback }}</span>
  </span>
</template>

<style scoped>
.provider-icon { display: inline-grid; place-items: center; flex: none; overflow: hidden; border-radius: 7px; background: rgba(148, 163, 184, .14); }
.provider-icon img { width: 82%; height: 82%; object-fit: contain; display: block; }
.provider-icon__fallback { font-size: .58em; font-weight: 800; letter-spacing: -.04em; }
</style>
