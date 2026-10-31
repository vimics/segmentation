import { resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

/** Limits where this page can send data. Applied to builds only, because dev tools need more. */
function contentSecurityPolicy(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  let origin = '';
  try { origin = env.VITE_UPLOAD_URL ? new URL(env.VITE_UPLOAD_URL).origin : ''; } catch { /* left empty */ }
  const turnstile = env.VITE_TURNSTILE_SITE_KEY ? 'https://challenges.cloudflare.com' : '';
  const connect = origin ? `'self' ${origin} https://*.sharepoint.com https://*.1drv.com` : "'self'";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${turnstile}`.trim(),
    "worker-src 'self' blob:",
    `connect-src ${connect}`,
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `frame-src ${turnstile || "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const tag = ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
        return html.replace('<!--__CSP__-->', tag);
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [contentSecurityPolicy(mode)],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), privacy: resolve(import.meta.dirname, 'privacy.html') } },
  },
  worker: { format: 'es' },
  // Several tests build full meshes, and CI runners are far slower than a development machine.
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000 },
}));
