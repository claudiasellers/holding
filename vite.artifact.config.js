// Single-file build for the hosted preview: everything inlined into one HTML file.
import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist-artifact', assetsInlineLimit: 1e9, cssCodeSplit: false, modulePreload: false,
    rollupOptions: { input: 'index.html', output: { inlineDynamicImports: true } } },
});
