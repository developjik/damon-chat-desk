import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolveBasePath } from './src/lib/hosting';

/**
 * The config runs in Node before Vite loads. This project has no
 * @types/node on purpose, so declare the one slice read here.
 */
declare const process: { env: Record<string, string | undefined> };

/** `/dm/health` → `/health` on the daemon. */
const stripDm = (path: string): string => path.replace(/^\/dm/, '');

export default defineConfig({
  // Static hosting path. GitHub Pages project page:
  //   VITE_BASE_PATH=/damon-chat-desk/ npm run build
  // Local dev/preview default to `/`.
  base: resolveBasePath(process.env.VITE_BASE_PATH),
  // This sandbox has no /etc/hosts entry for `localhost`; bind by IP so
  // the dev server and vitest never try to resolve the name.
  //
  // /dm is the same-origin path to a locally running daemon. The daemon
  // sends no CORS headers, so a browser cannot call 127.0.0.1:9470
  // directly from another origin — the dev/preview proxy makes the desk
  // and the daemon one origin during development.
  server: {
    host: '127.0.0.1',
    proxy: { '/dm': { target: 'http://127.0.0.1:9470', changeOrigin: true, rewrite: stripDm, ws: true } },
  },
  preview: {
    host: '127.0.0.1',
    proxy: { '/dm': { target: 'http://127.0.0.1:9470', changeOrigin: true, rewrite: stripDm, ws: true } },
  },
  plugins: [react()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    hookTimeout: 30_000,
    include: ["src/**/*.test.{ts,tsx}"],
    reporters: ['default'],
  },
});
