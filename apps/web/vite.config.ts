import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.REDLINE_DEV_SERVER ?? 'http://localhost:2567';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    host: true,
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
});
