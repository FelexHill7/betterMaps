import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://localhost:5178';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    // Listen on the LAN so you can open the app on an actual phone while testing.
    host: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
