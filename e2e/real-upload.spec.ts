import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Runs the upload path on the largest real cases against a simulated SharePoint, inside this browser only: every
 * upload request is answered here, and anything else is blocked. Records peak memory and timings, and drops the
 * connection once. Needs REAL_OUT and REAL_UPLOAD, so CI never runs it.
 */
const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const OUT = process.env.REAL_OUT ?? '';
const CASES = process.env.CASES?.split(',') ?? ['dog1', 'dog2'];
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };

test.describe.configure({ mode: 'serial' });
test.skip(!OUT || !process.env.REAL_UPLOAD, 'Set REAL_OUT and REAL_UPLOAD to run the upload path on real cases.');

/** Memory of every browser process together, in MB. */
function browserMemoryMb(): number {
  const lines = execFileSync('ps', ['-A', '-o', 'rss=,command=']).toString().split('\n');
  let kb = 0;
  // Only the test browser: other Chrome windows on this computer must not count.
  for (const line of lines) if (/chrome-headless-shell|headless_shell|chromium-\d+/i.test(line)) kb += parseInt(line, 10) || 0;
  return Math.round(kb / 1024);
}

for (const label of CASES) {
  test(`stores ${label} through a dropped connection`, async ({ page }) => {
    test.setTimeout(1_500_000);
    mkdirSync(OUT, { recursive: true });

    let chunks = 0, bytes = 0, dropped = 0, zipBytes = 0, files = 0;
    await page.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url());
      if (url.hostname === 'localhost' || url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.hostname === 'upload.test') {
        const record = req.postDataJSON().case;
        zipBytes = record.zipBytes;
        files = record.files;
        return route.fulfill({ status: 200, headers: cors, json: { caseId: 'BV-TEST', uploadUrl: 'https://vimics.sharepoint.com/upload' } });
      }
      if (url.hostname === 'vimics.sharepoint.com') {
        chunks++;
        if (chunks === 10 && !dropped) { dropped = 1; chunks--; return route.abort('connectionreset'); }
        bytes += req.postDataBuffer()?.length ?? 0;
        return route.fulfill({ status: 202, headers: cors, json: {} });
      }
      return route.abort();
    });

    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, browserMemoryMb()); }, 500);
    try {
      await page.goto('/');
      await page.fill('#f-name', 'Test');
      await page.click('[data-species="Dog"]');
      await page.fill('#f-years', '3');
      await page.fill('#f-months', '0');
      await page.fill('#f-weight', '10');
      await page.check('#f-consent');
      await page.locator('#klasor').setInputFiles(join(ROOT, label));
      const started = Date.now();
      await page.click('#basla');
      await page.locator('#ozet', { hasText: 'triangles' }).waitFor({ timeout: 900_000 });
      const modelSeconds = (Date.now() - started) / 1000;
      const peakAtModel = peak;
      await expect(page.locator('#depo')).toContainText('BV-TEST', { timeout: 1_200_000 });
      writeFileSync(join(OUT, `${label}-upload.json`), JSON.stringify({
        modelSeconds: +modelSeconds.toFixed(1),
        storedSeconds: +((Date.now() - started) / 1000).toFixed(1),
        peakMemoryMbAtModel: peakAtModel,
        peakMemoryMb: peak,
        files,
        zipMb: Math.round(zipBytes / 1e6),
        chunks,
        droppedConnections: dropped,
        bytesMatch: bytes === zipBytes,
      }, null, 1));
      expect(dropped).toBe(1);
      expect(bytes).toBe(zipBytes);
    } finally {
      clearInterval(timer);
    }
  });
}
