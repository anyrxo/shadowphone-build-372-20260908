import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // root must be the directory containing index.html
  root: __dirname,
  base: './',
  // Tailwind here is the @tailwindcss/vite PLUGIN, not PostCSS. Pin an empty
  // inline PostCSS config so Vite does NOT search up the tree and pick up the
  // main Next.js app's root postcss.config (which requires @tailwindcss/postcss
  // — a package in the ROOT node_modules, absent from electron/node_modules in
  // CI where only the electron deps are installed). Without this the CI build
  // fails with "Cannot find module '@tailwindcss/postcss'" (built locally only
  // because the dev machine has the full root deps installed).
  css: { postcss: {} },
  plugins: [
    tailwindcss(),
    react(),
  ],
  build: {
    outDir: resolve(__dirname, '../renderer/models-dashboard-app'),
    emptyOutDir: true,
    // Do NOT externalize 'electron' — require('electron').ipcRenderer resolves
    // at runtime under nodeIntegration:true. Vite passes through CJS require()
    // calls for runtime-only modules unchanged.
    rollupOptions: {
      // No external config — electron is accessed via require() at runtime
    },
  },
})
