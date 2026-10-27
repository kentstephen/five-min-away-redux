import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
  build: {
    target: "es2022",
    lib: { entry: "src/widget.ts", formats: ["es"], fileName: () => "widget.js" },
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    emptyOutDir: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  worker: { format: "es", rollupOptions: { output: { inlineDynamicImports: true } } },
});
