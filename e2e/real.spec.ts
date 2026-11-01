import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Runs each real case from test-data/, exactly as received, through the production build. These files must stay on
 * this computer: any request that isn't to the local server fails the test, and uploads are switched off by routing
 * uses a build with no upload service. Reports and screenshots go to REAL_OUT, outside the repository. Skipped without
 * REAL_OUT or test-data/, so CI never runs it.
 */
const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const OUT = process.env.REAL_OUT ?? '';
const CASES = (process.env.CASES?.split(',') ?? (existsSync(ROOT) ? readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory()) : []));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

test.describe.configure({ mode: 'serial' });
test.skip(!OUT, 'Set REAL_OUT to a folder outside the repository to run the real cases.');

for (const label of CASES) {
  test(`real case ${label}`, async ({ page }) => {
    test.setTimeout(900_000);
    mkdirSync(OUT, { recursive: true });

    const outside: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
      outside.push(url.hostname);
      return route.abort();
    });
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message.slice(0, 200)));

    const started = Date.now();
    await page.goto('/');
    await page.fill('#f-name', 'Test');
    await page.click(`[data-species="${label.startsWith('cat') ? 'Cat' : 'Dog'}"]`);
    await page.fill('#f-years', '3');
    await page.fill('#f-months', '0');
    await page.fill('#f-weight', '10');
    await page.check('#f-consent');

    // A single file is what a vet would choose as a file. Anything else goes in as the folder they received.
    const paths = walk(join(ROOT, label)).filter((p) => !p.endsWith('.DS_Store'));
    if (paths.length === 1) await page.locator('#dosya').setInputFiles(paths);
    else await page.locator('#klasor').setInputFiles(join(ROOT, label));
    const opened = Date.now();
    await page.click('#basla');

    const shot: Record<string, unknown> = {};
    await Promise.race([
      page.locator('#perde-hata').waitFor({ state: 'visible', timeout: 800_000 }),
      page.locator('#yapilar li').first().waitFor({ timeout: 800_000 }).then(() => page.locator('#iyilestir').waitFor({ state: 'hidden', timeout: 800_000 })),
    ]);
    shot.seconds = +((Date.now() - opened) / 1000).toFixed(1);
    shot.setupSeconds = +((opened - started) / 1000).toFixed(1);

    if (await page.locator('#perde-hata').isVisible()) {
      shot.error = await page.locator('#hata-baslik').textContent();
      shot.errorText = await page.locator('#hata-metin').textContent();
    } else {
      // The header line is left out of the report on purpose. It holds only placeholders here, but the habit matters.
      await page.waitForTimeout(1500);
      shot.summary = await page.locator('#ozet').textContent();
      shot.seriesInfo = await page.locator('#seri-bilgi').textContent();
      shot.seriesChoices = await page.locator('#seri option').allTextContents();
      shot.warnings = await page.locator('#uyarilar p').allTextContents();
      shot.structures = await page.locator('#yapilar li').allTextContents();
      await page.locator('.sahne').screenshot({ path: join(OUT, `${label}-default.png`) });
      // SWEEP=cat2:1500,1800;cat1:400 also builds and captures those lower limits.
      const sweep = (process.env.SWEEP ?? '').split(';').find((e) => e.startsWith(`${label}:`))?.split(':')[1].split(',') ?? [];
      const results: Record<string, unknown> = {};
      for (const hu of sweep) {
        await page.fill('#esik-sayi-min', hu);
        await page.locator('#esik-sayi-min').blur();
        await page.waitForTimeout(2500);
        await page.locator('#iyilestir').waitFor({ state: 'hidden', timeout: 300_000 });
        await page.waitForTimeout(800);
        await page.locator('.sahne').screenshot({ path: join(OUT, `${label}-${hu}hu.png`) });
        results[hu] = { summary: await page.locator('#ozet').textContent(), structures: (await page.locator('#yapilar li').allTextContents()).slice(0, 5) };
      }
      shot.sweep = results;
    }
    shot.outsideRequests = outside;
    shot.pageErrors = problems;
    writeFileSync(join(OUT, `${label}.json`), JSON.stringify(shot, null, 1));

    expect(outside).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test('no real case data is tracked by git', () => {
  const tracked = execFileSync('git', ['ls-files', 'test-data'], { cwd: resolve(import.meta.dirname, '..') }).toString();
  expect(tracked).toBe('');
});
