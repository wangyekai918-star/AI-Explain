import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  plugins: [vue()],
  build: { rollupOptions: { input: { main: 'index.html', player: 'demo/player.html' } } },
  test: { environment: 'jsdom', include: ['core/**/*.test.ts', 'ui/**/*.test.ts'] },
})
