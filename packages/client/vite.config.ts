import { defineConfig } from 'vite';

import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@game/shared': path.resolve(__dirname, '../shared/src/index.ts')
    }
  },
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext',
  },
});
