import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
    watch: { ignored: ['**/server/**', '**/test-results/**', '**/playwright-report/**'] },
  },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { rollupOptions: { output: { manualChunks: (id) => id.includes('/node_modules/three/') ? 'three' : undefined } } },
});
