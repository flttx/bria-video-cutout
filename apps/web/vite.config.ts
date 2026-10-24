import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  server: {
    port: 5174,
    strictPort: true,
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
    proxy: { "/browser": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
});
