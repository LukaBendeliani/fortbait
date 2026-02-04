import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, 'src/shared')
        }
    },
    server: {
        port: 3000,
    },
    build: {
        target: 'esnext',
    },
});
