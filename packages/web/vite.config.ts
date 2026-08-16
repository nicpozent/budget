import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Deterministic asset names so the SSR shell can reference them and so
    // builds are reproducible (SEC-040).
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        // React is separated from application code so a deploy that changes a
        // view does not invalidate the framework a returning user already has.
        // Deliberately just the framework: finer-grained vendor splitting trades
        // cache hits for request count, and there is one other dependency.
        manualChunks: (id) =>
          /node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'vendor' : undefined,
      },
    },
    // Source maps ship to the error tracker, not to the browser: they are a
    // free map of the application for anyone probing it.
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
    },
  },
});
