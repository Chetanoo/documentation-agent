import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // ~180 kB gzipped, mostly `ai` + its zod stream validation and react-dom: expected for a useChat app.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    // The Fastify API runs separately (npm run dev:api in the repo root).
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } },
  },
});
