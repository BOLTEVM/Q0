import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3069,
    proxy: {
      '/api-explorer': {
        target: 'https://quaiscan.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-explorer/, '')
      },
      '/api-quai-v2': {
        target: 'https://explorer.qu.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-quai-v2/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        }
      }
    }
  }
})

