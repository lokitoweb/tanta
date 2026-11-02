import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@tanta/tokens': fileURLToPath(new URL('../../packages/tokens/dist', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    // Web y API por el mismo origen: así un túnel (Cloudflare) expone una sola URL https
    // y no hay CORS ni cookies entre dominios. En producción lo hace Caddy igual.
    proxy: { '/api': { target: 'http://127.0.0.1:3001', xfwd: true } },
    allowedHosts: ['.trycloudflare.com', '.cfargotunnel.com'],
    // OneDrive crea carpetas *.tmpdir al sincronizar; si Vite las vigila, el proceso cae con EBUSY.
    watch: {
      ignored: ['**/*.tmpdir/**', '**/node_modules/**', '**/.pnpm-store/**', '**/dist/**'],
    },
  },
});
