<script setup lang="ts">
import { NButton, NPopconfirm } from "naive-ui";
import { Trash2 } from "@lucide/vue";

withDefaults(defineProps<{
  /** Confirmation copy shown in the popover. */
  content: string;
  /** Button text. Leave empty to render the icon-only circular variant. */
  label?: string;
  /** Accessible name; required for the icon-only variant, which has no text. */
  ariaLabel?: string;
  size?: "tiny" | "small" | "medium";
  disabled?: boolean;
}>(), { label: "删除", ariaLabel: "", size: "small", disabled: false });

const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <n-popconfirm @positive-click="emit('confirm')">
    <template #trigger>
      <n-button
        v-if="label"
        :size="size"
        type="error"
        secondary
        :disabled="disabled"
        :aria-label="ariaLabel || label"
      >
        {{ label }}
      </n-button>
      <n-button
        v-else
        quaternary
        circle
        :size="size"
        type="error"
        :disabled="disabled"
        :aria-label="ariaLabel || '删除'"
        :title="ariaLabel || '删除'"
      >
        <trash-2 :size="15" />
      </n-button>
    </template>
    {{ content }}
  </n-popconfirm>
</template>
