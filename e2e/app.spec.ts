import { expect, test, type Page } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';
import { createRequire } from 'node:module';
import { PLANTED, spherePhantom, writeSlice, type SliceSpec, type Syntax } from '../test/phantom';

type FileInput = { name: string; mimeType: string; buffer: Buffer };

const asFiles = (slices: SliceSpec[]): FileInput[] => slices.map((s, i) => ({
  name: `slice${i}.dcm`, mimeType: 'application/dicom', buffer: Buffer.from(writeSlice(s)),
}));

const sphereFiles = (syntax: Syntax = 'explicit') => asFiles(spherePhantom({ radiusMm: 12, syntax }).slices);

async function fillForm(page: Page, opts: { breed?: string; clinician?: string } = {}) {
  await page.fill('#f-name', 'Max');
  await page.click('[data-species="Dog"]');
  await page.fill('#f-years', '3');
  await page.fill('#f-months', '2');
  await page.fill('#f-weight', '12,4');
  if (opts.breed) await page.fill('#f-breed', opts.breed);
  if (opts.clinician) await page.fill('#f-clinician', opts.clinician);
  await page.check('#f-consent');
}

async function open(page: Page, files: FileInput[], opts: { breed?: string; clinician?: string } = {}) {
  await page.goto('/');
  await fillForm(page, opts);
  await page.setInputFiles('#dosya', files);
  await page.click('#basla');
}

const waitForModel = (page: Page) => page.locator('#iyilestir').and(page.locator('[hidden]')).waitFor({ state: 'attached', timeout: 60_000 }).then(() => page.locator('#yapilar li').first().waitFor());

function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  return problems;
}

/** A stand-in for the upload service and SharePoint, recording what reaches them. */
async function fakeStorage(page: Page) {
  const seen = { record: null as null | Record<string, never>, chunks: [] as Buffer[], hosts: new Set<string>() };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };
  await page.route('https://upload.test/**', async (route) => {
    const req = route.request();
    seen.hosts.add(new URL(req.url()).host);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    seen.record = req.postDataJSON().case;
    return route.fulfill({ status: 200, headers: cors, json: { caseId: 'BV-20261031-ABC123', uploadUrl: 'https://vimics.sharepoint.com/up/session' } });
  });
  await page.route('https://vimics.sharepoint.com/**', async (route) => {
    const req = route.request();
    seen.hosts.add(new URL(req.url()).host);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    seen.chunks.push(req.postDataBuffer() as Buffer);
    return route.fulfill({ status: 202, headers: cors, json: {} });
  });
  return seen;
}

test.describe('start page', () => {
  test('required fields stop the build, optional ones do not', async ({ page }) => {
    await page.goto('/');
    await page.click('#basla');
    await expect(page.locator('[data-alan="name"] .alan-hata')).toBeVisible();
    await expect(page.locator('[data-alan="species"] .alan-hata')).toBeVisible();
    await expect(page.locator('[data-alan="age"] .alan-hata')).toBeVisible();
    await expect(page.locator('[data-alan="weight"] .alan-hata')).toBeVisible();
    await expect(page.locator('[data-alan="consent"] .alan-hata')).toBeVisible();
    await expect(page.locator('[data-alan="files"] .alan-hata')).toBeVisible();
    await expect(page.locator('#baslangic')).toBeVisible();
    await expect(page.locator('[data-alan="breed"] .alan-hata')).toHaveCount(0);
  });

  test('will not open without consent', async ({ page }) => {
    await page.goto('/');
    await fillForm(page);
    await page.uncheck('#f-consent');
    await page.setInputFiles('#dosya', sphereFiles().slice(0, 3));
    await page.click('#basla');
    await expect(page.locator('[data-alan="consent"] .alan-hata')).toBeVisible();
    await expect(page.locator('#baslangic')).toBeVisible();
  });

  test('footer carries the agreed wording and no claim of nothing being uploaded', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.alt-sag')).toContainText('Not suitable for surgical planning or 3D printing');
    await expect(page.locator('.alt-sag')).toContainText('© 2026 Vimics');
    await expect(page.locator('body')).not.toContainText(/nothing (is )?uploaded/i);
  });
});

test.describe('viewer', () => {
  test('builds a model, shows the header in the agreed order, and measures true millimetres', async ({ page }) => {
    const problems = collectProblems(page);
    await fakeStorage(page);
    await open(page, sphereFiles(), { breed: 'Beagle', clinician: 'Jane Doe' });
    await waitForModel(page);

    await expect(page.locator('#vaka-satir')).toHaveText('Max · Dog · Beagle · 3 y 2 mo · 12.4 kg · Jane Doe, DVM · 12 Oct 2026');
    await expect(page.locator('#yapilar li')).toHaveCount(1);
    await expect(page.locator('.yakinda')).toContainText('A neural network bone segmentation engine is in training at Vimics HQ');
    await expect(page.locator('#alt-ozet')).toContainText('64');
    const volume = parseFloat(await page.locator('#yapilar .hacim').first().innerText());
    const expected = (4 / 3) * Math.PI * 12 ** 3 / 1000;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(0.05);

    // Two clicks either side of the centre: by symmetry their true distance is the screen distance.
    await page.click('[data-yuz="H"]', { force: true });
    await page.waitForTimeout(700);
    const box = (await page.locator('#tuval').boundingBox())!;
    const scaleMm = parseFloat(await page.locator('#olcek-yazi').innerText());
    const scalePx = (await page.locator('#olcek-cizgi').boundingBox())!.width;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.click('[data-arac="distance"]');
    const offset = 60;
    await page.mouse.click(cx - offset, cy);
    await page.mouse.click(cx + offset, cy);
    await expect(page.locator('#olculer li')).toHaveCount(1);
    const measured = parseFloat(await page.locator('#olculer b').innerText());
    const truth = (2 * offset) / (scalePx / scaleMm);
    expect(Math.abs(measured - truth)).toBeLessThan(0.4);

    expect(problems).toEqual([]);
  });

  test('threshold, clipping, hide and show all respond', async ({ page }) => {
    await page.goto('/');
    await page.click('#ornek');
    await waitForModel(page);
    await expect(page.locator('#yapilar li')).toHaveCount(4);
    await expect(page.locator('#yapilar li').last()).toContainText('Likely scanner table');
    await expect(page.locator('#yapilar li').last().locator('input')).not.toBeChecked();
    await expect(page.locator('#depo')).toBeHidden();

    const tris = () => page.locator('#alt-ozet').innerText();
    const before = await tris();
    await page.click('#hazir [data-hu="700"]');
    await expect.poll(tris, { timeout: 30_000 }).not.toBe(before);
    await page.locator('#iyilestir[hidden]').waitFor({ state: 'attached', timeout: 30_000 });

    await page.fill('#esik-sayi', '3000');
    await page.press('#esik-sayi', 'Enter');
    await expect(page.locator('#ipucu')).toContainText('No surface at this threshold', { timeout: 30_000 });
    await page.fill('#esik-sayi', '250');
    await page.press('#esik-sayi', 'Enter');
    await expect(page.locator('#ipucu')).toBeHidden({ timeout: 30_000 });
    await page.locator('#iyilestir[hidden]').waitFor({ state: 'attached', timeout: 30_000 });

    await page.check('#kesitler input[type=checkbox][data-eksen="2"]');
    await expect(page.locator('#kesitler input[type=range][data-eksen="2"]')).toBeEnabled();

    const box = (await page.locator('#tuval').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#aksiyon')).toBeVisible();
    await page.click('#aksiyon-gizle');
    await expect(page.locator('#yapilar input:not(:checked)')).toHaveCount(2);

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#goruntu')]);
    expect(download.suggestedFilename()).toBe('vimics-bone-viewer.png');
  });
});

test.describe('file formats in real workers, under the production security policy', () => {
  for (const syntax of ['implicit', 'bigendian', 'rle', 'jpeglossless'] as Syntax[]) {
    test(`${syntax} series builds the right sphere`, async ({ page }) => {
      const problems = collectProblems(page);
      await fakeStorage(page);
      await open(page, sphereFiles(syntax));
      await waitForModel(page);
      const volume = parseFloat(await page.locator('#yapilar .hacim').first().innerText());
      expect(Math.abs(volume - 7.24) / 7.24).toBeLessThan(0.06);
      expect(problems).toEqual([]);
    });
  }

  // These two load WASM decoders, which is what a strict policy would break.
  async function wasmEncoded(kind: 'j2k' | 'jpegls') {
    const require = createRequire(import.meta.url);
    const factory = kind === 'j2k' ? require('@cornerstonejs/codec-openjpeg/wasmjs') : require('@cornerstonejs/codec-charls/wasmjs');
    const codec = await factory();
    const encoder = kind === 'j2k' ? new codec.J2KEncoder() : new codec.JpegLSEncoder();
    const { slices } = spherePhantom({ radiusMm: 12 });
    return asFiles(slices.map((s) => {
      const px = new Uint16Array(s.rows * s.cols);
      for (let j = 0, n = 0; j < s.rows; j++) for (let i = 0; i < s.cols; i++, n++) px[n] = Math.max(0, Math.round(s.hu(i, j) + 1024));
      encoder.getDecodedBuffer({ width: s.cols, height: s.rows, bitsPerSample: 16, componentCount: 1, isSigned: false }).set(new Uint8Array(px.buffer));
      if (kind === 'j2k') { encoder.setDecompositions?.(2); encoder.encode(); }
      else encoder.encode();
      return { ...s, encoded: { uid: kind === 'j2k' ? '1.2.840.10008.1.2.4.90' : '1.2.840.10008.1.2.4.80', frame: encoder.getEncodedBuffer().slice() } };
    }));
  }

  for (const kind of ['j2k', 'jpegls'] as const) {
    test(`${kind} series builds the right sphere`, async ({ page }) => {
      const problems = collectProblems(page);
      await fakeStorage(page);
      await open(page, await wasmEncoded(kind));
      await waitForModel(page);
      const volume = parseFloat(await page.locator('#yapilar .hacim').first().innerText());
      expect(Math.abs(volume - 7.24) / 7.24).toBeLessThan(0.06);
      expect(problems).toEqual([]);
    });
  }

  test('a ZIP works, with stray files ignored', async ({ page }) => {
    await fakeStorage(page);
    const entries: Record<string, Uint8Array> = { 'notes.txt': new TextEncoder().encode('not an image'), '__MACOSX/._x': new Uint8Array(4) };
    for (const f of sphereFiles()) entries[`case/${f.name}`] = new Uint8Array(f.buffer);
    await open(page, [{ name: 'case.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(entries, { level: 1 })) }]);
    await waitForModel(page);
    await expect(page.locator('#alt-ozet')).toContainText('64');
  });

  test('picks among series and lets the vet switch', async ({ page }) => {
    await fakeStorage(page);
    const a = spherePhantom({ radiusMm: 12, count: 64 }).slices.map((s) => ({ ...s, seriesUid: '1.2.3.1' }));
    const b = spherePhantom({ radiusMm: 6, size: 32, count: 32 }).slices.map((s) => ({ ...s, seriesUid: '1.2.3.2', instance: s.instance + 1000 }));
    await open(page, asFiles([...a, ...b]));
    await waitForModel(page);
    await expect(page.locator('#seri option')).toHaveCount(2);
    await expect(page.locator('#alt-ozet')).toContainText('64 slices');
    await page.selectOption('#seri', { index: 1 });
    await expect(page.locator('#alt-ozet')).toContainText('32 slices', { timeout: 60_000 });
  });
});

test.describe('clear messages', () => {
  test('an MRI gets a plain explanation', async ({ page }) => {
    const slices = spherePhantom({ size: 16, count: 4 }).slices.map((s) => ({ ...s, modality: 'MR' }));
    await open(page, asFiles(slices));
    await expect(page.locator('#hata-baslik')).toHaveText('This scan is an MR, not a CT');
    await page.click('#yeniden');
    await expect(page.locator('#baslangic')).toBeVisible();
  });

  test('files that are not DICOM are reported', async ({ page }) => {
    await open(page, [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2000, 7) }]);
    await expect(page.locator('#hata-baslik')).toHaveText('No DICOM images in these files');
  });

  test('warns about missing slices', async ({ page }) => {
    await fakeStorage(page);
    const { slices } = spherePhantom({ radiusMm: 12 });
    await open(page, asFiles(slices.filter((s) => s.instance !== 20)));
    await waitForModel(page);
    await expect(page.locator('#uyarilar')).toContainText('1 slice is missing');
  });
});

test.describe('case storage', () => {
  test('stores a clean, de-identified copy in the background and shows a reference', async ({ page }) => {
    const seen = await fakeStorage(page);
    const problems = collectProblems(page);
    await open(page, sphereFiles(), { breed: 'Beagle', clinician: 'Jane Doe' });
    await waitForModel(page);
    await expect(page.locator('#depo-ref')).toHaveText('BV-20261031-ABC123', { timeout: 30_000 });

    const record = seen.record as unknown as {
      consent: { version: string; text: string; acceptedAt: string };
      patient: { name: string; species: string; breed: string; ageMonths: number; weightKg: number };
      clinician: string;
      study: { slices: number; dicomSpecies: string };
      files: number;
      zipBytes: number;
    };
    expect(record.patient).toEqual({ name: 'Max', species: 'Dog', breed: 'Beagle', ageMonths: 38, weightKg: 12.4 });
    expect(record.clinician).toBe('Jane Doe');
    expect(record.consent.version).toBeTruthy();
    expect(record.consent.text).toContain('de-identified copy');
    expect(record.study.slices).toBe(64);
    expect(record.files).toBe(64);
    expect(JSON.stringify(record)).not.toContain(PLANTED.owner);
    expect(JSON.stringify(record)).not.toContain(PLANTED.clinic);

    const zip = Buffer.concat(seen.chunks);
    expect(zip.length).toBe(record.zipBytes);
    const members = unzipSync(new Uint8Array(zip));
    expect(Object.keys(members).length).toBe(64);
    for (const bytes of Object.values(members)) {
      const text = Buffer.from(bytes).toString('latin1');
      for (const value of Object.values(PLANTED)) expect(text).not.toContain(value);
      expect(text).toContain('DICM');
    }
    expect([...seen.hosts].sort()).toEqual(['upload.test', 'vimics.sharepoint.com']);
    expect(problems).toEqual([]);
  });

  test('a burned-in series is never sent', async ({ page }) => {
    const seen = await fakeStorage(page);
    await open(page, asFiles(spherePhantom({ radiusMm: 12 }).slices.map((s) => ({ ...s, burnedIn: true }))));
    await waitForModel(page);
    await expect(page.locator('#depo-metin')).toContainText('burned into the images');
    expect(seen.hosts.size).toBe(0);
  });

  test('a failed upload leaves the viewer working and offers a retry', async ({ page }) => {
    let refuse = true;
    const seen = await fakeStorage(page);
    await page.route('https://upload.test/**', async (route) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (refuse) return route.fulfill({ status: 503, headers: cors, json: { error: 'Storage is unavailable.' } });
      return route.fulfill({ status: 200, headers: cors, json: { caseId: 'BV-RETRY', uploadUrl: 'https://vimics.sharepoint.com/up/session' } });
    });
    await open(page, sphereFiles());
    await waitForModel(page);
    await expect(page.locator('#depo-metin')).toContainText('Storage is unavailable', { timeout: 30_000 });
    await expect(page.locator('#yapilar li')).toHaveCount(1);
    refuse = false;
    await page.click('#depo-tekrar');
    await expect(page.locator('#depo-ref')).toHaveText('BV-RETRY', { timeout: 30_000 });
    expect(seen.chunks.length).toBeGreaterThan(0);
  });
});
