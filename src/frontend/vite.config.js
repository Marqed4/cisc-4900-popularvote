import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  server: {
    port: 6967,
    proxy: {
      '/api': 'http://localhost:2167',
      '/socket.io': {
        target: 'http://localhost:2167',
        ws: true,
        changeOrigin: true
      }
    }
  }
})