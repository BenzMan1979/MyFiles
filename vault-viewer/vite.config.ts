import { defineConfig } from 'vite';

// Builds the packer; scripts/inline-app.mjs then turns it into one self-contained index.html so it
// can be saved and used offline.
export default defineConfig({
  base: './',
  assetsInclude: ['**/*.bcmap'], // pdf.js character maps, embedded as data (see src/shared/pdfjs.ts)
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: { inlineDynamicImports: true, entryFileNames: 'app.js', assetFileNames: 'app[extname]' },
    },
  },
});
