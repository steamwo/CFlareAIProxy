import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { visualizer } from "rollup-plugin-visualizer";
import { fileURLToPath, URL } from "node:url";

// Set ANALYZE=1 to emit .wrangler/bundle-stats.html for chunk composition analysis.
const analyze = process.env.ANALYZE === "1";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [
    vue(),
    ...(analyze
      ? [visualizer({
          filename: fileURLToPath(new URL("./.wrangler/bundle-stats.html", import.meta.url)),
          template: "treemap",
          gzipSize: true,
        })]
      : []),
  ],
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
