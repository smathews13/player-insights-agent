import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: path.resolve(__dirname, './dist'),
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === 'development',
    rollupOptions: {
      output: {
        // AppKit is shared by the eager shell and every lazy page. Keeping it
        // outside app code lets a shell-only change reuse the large vendor
        // chunk instead of invalidating it, while route chunks stay independent.
        manualChunks(id) {
          if (id.includes('/node_modules/@databricks/appkit-ui/')) return 'appkit-ui';
        },
      },
    },
  },
  optimizeDeps: {
    // `recharts` was listed here and is not a dependency of this app -- nothing
    // in `client/src` imports it and it is absent from package.json. Vite warns
    // and moves on, so it cost nothing but the noise; AppKit's own charts come
    // in through the `appkit-ui` chunk above, already prebundled.
    include: ['react', 'react-dom', 'react/jsx-dev-runtime', 'react/jsx-runtime'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
