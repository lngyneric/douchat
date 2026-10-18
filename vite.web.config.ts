import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The web app: the desktop renderer on top of src/web/webApi.ts. It is served
 * by douchat-tanstack from /app (and as app.douchat.ai), so /api is the same
 * origin. In development, /api and the login page go to the local service.
 */
const service = process.env.DOUCHAT_SERVICE_URL || 'http://localhost:3004'

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: '/app/',
  publicDir: resolve(__dirname, 'src/renderer/public'),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  },
  server: {
    port: 5276,
    strictPort: true,
    proxy: {
      '/api': { target: service, changeOrigin: true },
      '/v1': { target: service, changeOrigin: true },
      '/desktop-auth': { target: service, changeOrigin: true }
    }
  }
})
