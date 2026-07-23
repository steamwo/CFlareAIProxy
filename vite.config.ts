import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "admin/assets",
    sourcemap: false,
    target: "es2022",
  },
});
