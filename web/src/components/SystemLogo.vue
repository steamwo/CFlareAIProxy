<script setup lang="ts">
withDefaults(defineProps<{ size?: number; title?: string }>(), { size: 42, title: "CFlareAIProxy" });
</script>

<template>
  <svg
    class="system-logo"
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    role="img"
    :aria-label="title"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="cflare-logo-bg" x1="8" y1="6" x2="56" y2="60" gradientUnits="userSpaceOnUse">
        <stop stop-color="#111827" />
        <stop offset="1" stop-color="#075985" />
      </linearGradient>
      <linearGradient id="cflare-logo-cloud" x1="12" y1="28" x2="52" y2="46" gradientUnits="userSpaceOnUse">
        <stop stop-color="#F6821F" />
        <stop offset="1" stop-color="#FBAD41" />
      </linearGradient>
      <linearGradient id="cflare-logo-ai" x1="24" y1="23" x2="42" y2="41" gradientUnits="userSpaceOnUse">
        <stop stop-color="#67E8F9" />
        <stop offset="1" stop-color="#38BDF8" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#cflare-logo-bg)" />
    <path d="M12 43.5c0-4.1 3.2-7.4 7.2-7.7A12.7 12.7 0 0 1 43.4 32a8.3 8.3 0 0 1 8.6 8.3c0 1.1-.2 2.2-.6 3.2H12Z" fill="url(#cflare-logo-cloud)" />
    <path d="M36.5 19.5a10.5 10.5 0 0 1 13.8 9.3 12 12 0 0 0-9.8-2.1 15.4 15.4 0 0 0-4-7.2Z" fill="#FDBA2D" />
    <path d="m22.5 22-5 10 5 10M41.5 22l5 10-5 10" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" opacity=".96" />
    <path d="M27.5 29.5 32 26l4.5 3.5v5L32 38l-4.5-3.5v-5Z" fill="url(#cflare-logo-ai)" stroke="#E0F2FE" stroke-width="1.4" />
    <circle cx="32" cy="32" r="2" fill="#fff" />
    <path d="M32 26v-3.5M27.5 29.5l-3-1.8M36.5 29.5l3-1.8M27.5 34.5l-3 1.8M36.5 34.5l3 1.8" stroke="#A5F3FC" stroke-width="1.5" stroke-linecap="round" />
    <circle cx="32" cy="21" r="1.5" fill="#fff" />
    <circle cx="23" cy="27" r="1.5" fill="#fff" />
    <circle cx="41" cy="27" r="1.5" fill="#fff" />
    <path d="m48.5 13 .9 2.5 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.5Z" fill="#E0F2FE" />
  </svg>
</template>

<style scoped>
.system-logo { display: block; flex: none; }
</style>
