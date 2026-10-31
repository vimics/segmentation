import { defineConfig } from '@playwright/test';

/** Real cases run against a build with no upload service, so nothing can be sent even by mistake. The upload test uses a simulated one. */
const buildMode = process.env.REAL_OUT && !process.env.REAL_UPLOAD ? 'production' : 'e2e';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4178',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: `npx vite build --mode ${buildMode} --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4178 --strictPort`,
    url: 'http://localhost:4178',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
