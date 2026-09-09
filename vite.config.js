import { defineConfig } from 'vite';

const deviceOnly = process.env.VITE_MILO_DEVICE_ONLY === '1';
const isolationHeaders = deviceOnly ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : undefined;
const proxy = { '/api/codex': 'http://127.0.0.1:8791', '/api/voice': 'http://127.0.0.1:8792', ...(deviceOnly ? {} : { '/api': 'http://127.0.0.1:8787' }) };
export default defineConfig({
  worker: { format: 'es' },
  server: {
    headers: isolationHeaders,
    proxy,
    watch: { ignored: ['**/server/**', '**/test-results/**', '**/playwright-report/**'] },
  },
  preview: { headers: isolationHeaders, proxy },
  build: { rollupOptions: { output: { manualChunks: (id) => id.includes('/node_modules/three/') ? 'three' : undefined } } },
});
