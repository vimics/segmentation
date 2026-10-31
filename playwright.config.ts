import { defineConfig } from '@playwright/test';

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
    command: 'npx vite build --mode e2e --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4178 --strictPort',
    url: 'http://localhost:4178',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
