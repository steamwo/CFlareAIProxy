import { defineStore } from "pinia";
import type { GlobalThemeOverrides } from "naive-ui";

const stored = localStorage.getItem("cflare-theme");
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
export const useUiStore = defineStore("ui", {
  state: () => ({ dark: stored ? stored === "dark" : prefersDark, mobileMenu: false }),
  getters: {
    themeOverrides: (): GlobalThemeOverrides => ({
      common: { primaryColor: "#6366f1", primaryColorHover: "#818cf8", primaryColorPressed: "#4f46e5", borderRadius: "10px", borderRadiusSmall: "8px" },
      Card: { borderRadius: "16px" }, Button: { borderRadiusMedium: "10px" }, Input: { borderRadius: "10px" },
    }),
  },
  actions: { toggleTheme() { this.dark = !this.dark; localStorage.setItem("cflare-theme", this.dark ? "dark" : "light"); } },
});
