import { defineConfig } from 'vite';

// Builds the viewer as one JS + one CSS file; scripts/inline-viewer.mjs then inlines both into a
// single HTML template that the packer fills with the encrypted payload.
export default defineConfig({
  root: 'src/viewer',
  base: './',
  build: {
    outDir: '../../dist-viewer',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: { inlineDynamicImports: true, entryFileNames: 'viewer.js', assetFileNames: 'viewer[extname]' },
    },
  },
});
