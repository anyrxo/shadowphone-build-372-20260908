import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  // Anchor root to this config's dir so 'src/**' resolves to dashboard-src/src
  // even though the npm script runs from electron/.
  root: __dirname,
  test: {
    globals: true,
    // 'node' (not 'jsdom'): buildExceptions is pure logic and jsdom isn't installed.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
