import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/dashboard',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.DASHBOARD_API ?? 'http://localhost:3000',
      '/health': process.env.DASHBOARD_API ?? 'http://localhost:3000',
    },
  },
  build: { outDir: '../../dist/dashboard', emptyOutDir: true },
});
