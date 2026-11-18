import { defineConfig } from 'vite';
// base './' keeps every path relative so dist/ runs from any static host,
// a phone, a file share, or an Android WebView.
export default defineConfig({
  base: './',
  server: { host: true },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0, rollupOptions: { input: { main: 'index.html', lab: 'face-lab.html' } } },
});
