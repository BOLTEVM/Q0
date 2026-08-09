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
      }
    }
  }
})

