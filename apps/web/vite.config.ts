import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

export default defineConfig(({mode})=>{
  // Read only on the web server. Never expose these credentials through VITE_*.
  const env=loadEnv(mode,fileURLToPath(new URL('.',import.meta.url)),'CUTOUT_API_');
  const target=env.CUTOUT_API_BASE_URL||'http://127.0.0.1:3001';
  const pathPrefix=(env.CUTOUT_API_PATH_PREFIX||'').replace(/\/+$/,'');
  if(!/^(\/[A-Za-z0-9_-]+)*$/.test(pathPrefix))throw new Error('CUTOUT_API_PATH_PREFIX must be an absolute path prefix without a query or fragment.');
  const username=env.CUTOUT_API_USERNAME,password=env.CUTOUT_API_PASSWORD;
  if(mode==='server'&&(username||password)&&(!username||!password))throw new Error('CUTOUT_API_USERNAME and CUTOUT_API_PASSWORD must both be set.');
  const authorization=username&&password?'Basic '+Buffer.from(`${username}:${password}`).toString('base64'):undefined;
  return {
  ...(mode==='server'?{publicDir:false,build:{outDir:'dist-server'}}:{}),
  plugins: [react()],
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  server: {
    port: 5174,
    strictPort: true,
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
    proxy: {
      ...(mode==='server'?{"/bria-cutout/api": {
        target,changeOrigin:false,proxyTimeout:600000,
        // Browser URLs are namespaced; direct API deployments still use /api internally.
        rewrite:path=>`${pathPrefix}${path.slice('/bria-cutout'.length)}`,
        ...(authorization?{headers:{Authorization:authorization}}:{}),
      }}:{}),
      "/browser": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/native": { target: "http://127.0.0.1:3002", changeOrigin: true, proxyTimeout: 1_900_000 },
    },
  },
};});
