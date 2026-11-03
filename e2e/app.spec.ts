import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
  await page.fill('#f-age', '3');
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

const waitForModel = async (page: Page) => {
  await page.locator('#ozet', { hasText: 'triangles' }).waitFor({ timeout: 60_000 });
  await page.locator('#iyilestir').waitFor({ state: 'hidden', timeout: 60_000 });
};

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
    return route.fulfill({ status: 200, headers: cors, json: { caseId: 'VS-20261031-ABC123', uploadUrl: 'https://vimics.sharepoint.com/up/session' } });
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
    await expect(page.locator('h1').first()).toHaveText('Inspect bone anatomy in 3D.');
    await expect(page.locator('body')).not.toContainText('Veterinary CT to 3D');
    await expect(page.locator('.alt-orta')).toContainText('Not suitable for surgical planning or 3D printing, which require human inspection with local masking on medical software.');
    await expect(page.locator('.alt-sag')).toContainText('© 2026 Vimics');
    await expect(page.locator('body')).not.toContainText(/nothing (is )?uploaded/i);
  });

  test('the bottom strip wraps instead of running into the copyright line', async ({ page }) => {
    await page.goto('/');
    for (const width of [1280, 1100, 1024, 900]) {
      await page.setViewportSize({ width, height: 768 });
      const text = (await page.locator('.alt-orta').boundingBox())!, rights = (await page.locator('.alt-sag').boundingBox())!;
      expect(text.x + text.width).toBeLessThanOrEqual(rights.x);
    }
  });
});

test.describe('viewer', () => {
  test('builds a model, shows the header in the agreed order, and measures true millimetres', async ({ page }) => {
    const problems = collectProblems(page);
    await fakeStorage(page);
    await open(page, sphereFiles(), { breed: 'Beagle', clinician: 'Jane Doe' });
    await waitForModel(page);

    await expect(page.locator('#vaka-satir')).toHaveText('Max · Dog · Beagle · 3 y · 12.4 kg · Jane Doe, DVM · 12 Oct 2026');
    await expect(page.locator('#yapilar li')).toHaveCount(1);
    await expect(page.locator('.yakinda')).toContainText('A neural network bone segmentation engine is in training at Vimics HQ, will be available at no charge, on vimics.vet/segmentation.');
    await expect(page.locator('.urun-ad')).toHaveText('V-Seg Engine v1.0');
    await expect(page.locator('.ray .etiket:visible')).toHaveText(['Coming soon', 'Threshold', 'Filters', 'Measure', 'Section Analysis', 'Case storage', 'Structures']);
    await expect(page.locator('.ray > *').first()).toHaveClass('yakinda');
    await expect(page.locator('.kup button').first()).toHaveText('Z');
    await expect(page.locator('body')).not.toContainText('Verify left and right');
    await expect(page.locator('#ozet')).toContainText('64');
    const volume = parseFloat(await page.locator('#yapilar .hacim').first().textContent() ?? '');
    const expected = (4 / 3) * Math.PI * 12 ** 3 / 1000;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(0.05);

    // Two clicks either side of the centre: by symmetry their true distance is the screen distance.
    await page.click('[data-yuz="z"]', { force: true });
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
    await expect(page.locator('#yapilar li')).toHaveCount(3);
    await expect(page.locator('#yapilar')).not.toContainText('Likely scanner table');
    await expect(page.locator('#filtre-not')).toContainText('thin fragment');
    await expect(page.locator('#depo')).toBeHidden();

    const tris = () => page.locator('#ozet').innerText();
    const before = await tris();
    await page.fill('#esik-sayi-min', '700');
    await page.press('#esik-sayi-min', 'Enter');
    await expect.poll(tris, { timeout: 30_000 }).not.toBe(before);
    await page.locator('#iyilestir[hidden]').waitFor({ state: 'attached', timeout: 30_000 });

    await page.fill('#esik-sayi-min', '3000');
    await page.press('#esik-sayi-min', 'Enter');
    await expect(page.locator('#esik-sayi-max')).toHaveValue('3001');
    await expect(page.locator('#ipucu')).toContainText('No surface at this threshold', { timeout: 30_000 });
    await page.fill('#esik-sayi-min', '300');
    await page.press('#esik-sayi-min', 'Enter');
    await expect(page.locator('#ipucu')).toBeHidden({ timeout: 30_000 });
    await page.locator('#iyilestir[hidden]').waitFor({ state: 'attached', timeout: 30_000 });

    await page.check('#kesitler input[type=checkbox][data-eksen="2"]');
    await expect(page.locator('#kesitler input[type=range][data-eksen="2"]')).toBeEnabled();

    const box = (await page.locator('#tuval').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#aksiyon')).toBeVisible();
    await page.click('#aksiyon-gizle');
    await expect(page.locator('#yapilar input:not(:checked)')).toHaveCount(1);

    await page.evaluate(() => {
      const drawn: string[] = [];
      (window as unknown as { drawn: string[] }).drawn = drawn;
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text: string, x: number, y: number) { drawn.push(text); original.call(this, text, x, y); };
    });
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#goruntu')]);
    const drawn = await page.evaluate(() => (window as unknown as { drawn: string[] }).drawn);
    expect(drawn).toContain('vimics.vet');
    expect(drawn).toContain('@vimicsveterinary');
    expect(drawn.some((t) => t.startsWith('Generated vertebrae'))).toBe(true);
    expect(download.suggestedFilename()).toBe('vimics-v-seg.png');
  });
});

test.describe('file formats in real workers, under the production security policy', () => {
  for (const syntax of ['implicit', 'bigendian', 'rle', 'jpeglossless'] as Syntax[]) {
    test(`${syntax} series builds the right sphere`, async ({ page }) => {
      const problems = collectProblems(page);
      await fakeStorage(page);
      await open(page, sphereFiles(syntax));
      await waitForModel(page);
      const volume = parseFloat(await page.locator('#yapilar .hacim').first().textContent() ?? '');
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
      const volume = parseFloat(await page.locator('#yapilar .hacim').first().textContent() ?? '');
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
    await expect(page.locator('#ozet')).toContainText('64');
  });

  test('opens the series with the most slices and offers no choice', async ({ page }) => {
    await fakeStorage(page);
    const a = spherePhantom({ radiusMm: 12, count: 64 }).slices.map((s) => ({ ...s, seriesUid: '1.2.3.1' }));
    const b = spherePhantom({ radiusMm: 6, size: 32, count: 32 }).slices.map((s) => ({ ...s, seriesUid: '1.2.3.2', instance: s.instance + 1000 }));
    await open(page, asFiles([...b, ...a]));
    await waitForModel(page);
    await expect(page.locator('#ozet')).toContainText('64 slices');
    await expect(page.locator('#seri')).toHaveCount(0);
    await expect(page.locator('.ray .etiket', { hasText: 'Series' })).toHaveCount(0);
  });

  test('scouts and dose reports never get in the way', async ({ page }) => {
    await fakeStorage(page);
    const main = spherePhantom({ radiusMm: 12 }).slices.map((s) => ({ ...s, seriesUid: '1.2.3.1', kernel: 'B70f', description: 'Spine' }));
    const scout = { ...main[0], seriesUid: '1.2.3.2', imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER', instance: 900 };
    const dose = { ...main[0], seriesUid: '1.2.3.3', samples: 3, instance: 901 };
    await open(page, asFiles([scout, dose, ...main]));
    await waitForModel(page);
    await expect(page.locator('#uyarilar')).toBeHidden();
  });

  test('a real-world mix loads: DICOM with BMP copies, a viewer program and a readme', async ({ page }) => {
    await fakeStorage(page);
    const bmp = Buffer.alloc(5000, 1);
    bmp.write('BM');
    const exe = Buffer.alloc(5000, 2);
    exe.write('MZ');
    const strays = [
      ...Array.from({ length: 5 }, (_, i) => ({ name: `IMG${i}.bmp`, mimeType: 'image/bmp', buffer: bmp })),
      { name: 'pdsv.exe', mimeType: 'application/octet-stream', buffer: exe },
      { name: 'README.txt', mimeType: 'text/plain', buffer: Buffer.from('Insert the disc and run the viewer.') },
      { name: 'autorun.inf', mimeType: 'text/plain', buffer: Buffer.from('[autorun]') },
    ];
    await open(page, [...strays, ...sphereFiles().map((f, i) => ({ ...f, name: `I${i}` }))]);
    await waitForModel(page);
    await expect(page.locator('#ozet')).toContainText('64');
  });

  test('a damaged ZIP beside good files becomes a warning', async ({ page }) => {
    await fakeStorage(page);
    await open(page, [{ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ a: new Uint8Array(40) }).subarray(0, 30)) }, ...sphereFiles()]);
    await waitForModel(page);
    await expect(page.locator('#uyarilar')).toContainText('1 ZIP file inside this upload could not be read');
  });

  test('a corrupt slice is left out with a warning', async ({ page }) => {
    const seen = await fakeStorage(page);
    const files = sphereFiles();
    // Cuts the file in the pixel data: the header is still readable, the slice is not.
    files[20] = { ...files[20], buffer: files[20].buffer.subarray(0, files[20].buffer.length - 3000) };
    await open(page, files);
    await waitForModel(page);
    await expect(page.locator('#uyarilar')).toContainText('1 slice could not be read');
    await expect(page.locator('#ozet')).toContainText('63');
    // It still stores, without the bad slice.
    await expect(page.locator('#depo-ref')).toHaveText('VS-20261031-ABC123', { timeout: 30_000 });
    expect((seen.record as unknown as { files: number }).files).toBe(63);
  });
});

test.describe('demo cases', () => {
  for (const [name, species] of [['Dog 2', 'Dog']]) {
    test(`${name} opens with no form, and nothing is sent`, async ({ page }) => {
      const problems = collectProblems(page);
      const outgoing: string[] = [];
      page.on('request', (r) => { if (!r.url().startsWith('http://localhost') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) outgoing.push(r.url()); });
      await page.goto('/');
      await page.getByRole('button', { name, exact: true }).click();
      await page.locator('#ozet', { hasText: 'triangles' }).waitFor({ timeout: 85_000 });
      await expect(page.locator('#vaka')).toContainText('Patient details removed');
      await expect(page.locator('#uyarilar')).toBeHidden();
      await expect(page.locator('#vaka')).toContainText(species === 'Cat' ? 'Cat' : 'Dog');
      await expect(page.locator('#esik-sayi-min')).toHaveValue('300');
      await expect(page.locator('#esik-sayi-max')).toHaveValue('1900');
      await expect(page.locator('#depo')).toBeHidden();
      expect(outgoing).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
});

test.describe('threshold selector', () => {
  const NOTE = 'We normally expect cortical and cancellous bones between 300 - 1900 Hounsfield units, but shifts can occur due to the calibration, tube voltage and reconstruction filters. Use threshold slider to adjust for shifts and eliminate noise.';

  test('opens at 300 to 1900 with the note and no presets, and the ends cannot cross', async ({ page }) => {
    await open(page, sphereFiles());
    await waitForModel(page);
    await expect(page.locator('#esik-min')).toHaveValue('300');
    await expect(page.locator('#esik-max')).toHaveValue('1900');
    await expect(page.locator('#esik-min')).toHaveAttribute('min', '-1024');
    await expect(page.locator('#esik-max')).toHaveAttribute('max', '4000');
    await expect(page.locator('#esik-not')).toHaveText(NOTE);
    await expect(page.locator('#hazir')).toHaveCount(0);

    // Dragging one thumb past the other stops it there.
    await page.locator('#esik-min').evaluate((el: HTMLInputElement) => { el.value = '3500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect(page.locator('#esik-sayi-min')).toHaveValue('1899');
    await expect(page.locator('#esik-sayi-max')).toHaveValue('1900');
  });

  test('both thumbs can be grabbed with the pointer', async ({ page }) => {
    await open(page, sphereFiles());
    await waitForModel(page);
    const box = (await page.locator('#aralik').boundingBox())!;
    const at = (hu: number) => box.x + ((hu + 1024) / 5024) * box.width;
    const y = box.y + box.height / 2;
    await page.mouse.move(at(1900), y);
    await page.mouse.down();
    await page.mouse.move(at(3000), y, { steps: 4 });
    await page.mouse.up();
    expect(+(await page.locator('#esik-sayi-max').inputValue())).toBeGreaterThan(2500);
    await expect(page.locator('#esik-sayi-min')).toHaveValue('300');
    await page.mouse.move(at(300), y);
    await page.mouse.down();
    await page.mouse.move(at(800), y, { steps: 4 });
    await page.mouse.up();
    expect(+(await page.locator('#esik-sayi-min').inputValue())).toBeGreaterThan(500);
  });

  test('lowering the top of the range changes the model', async ({ page }) => {
    await open(page, sphereFiles());
    await waitForModel(page);
    const before = await page.locator('#ozet').innerText();
    await page.fill('#esik-sayi-max', '600');
    await page.press('#esik-sayi-max', 'Enter');
    await expect.poll(() => page.locator('#ozet').innerText(), { timeout: 30_000 }).not.toBe(before);
  });
});

test.describe('filters and structures', () => {
  /** A big sphere plus tiny ones under 8 mm³, so the small shells filter has something to do. */
  const withShells = () => asFiles(spherePhantom({ radiusMm: 12 }).slices.map((s) => ({
    ...s,
    hu: (i: number, j: number) => {
      const z = s.position[2], tiny = [[2, 2], [4, 2], [6, 2]].some(([a, b]) => Math.hypot(i * 0.5 - a, j * 0.5 - b, z - 16) < 0.8);
      return tiny ? 1000 : s.hu(i, j);
    },
  })));
  const triangles = async (page: Page) => parseInt((await page.locator('#ozet').innerText()).split('·').pop()!.replace(/\D/g, ''), 10);

  test('both filters start on, and the note follows the ticks', async ({ page }) => {
    await page.goto('/');
    await page.click('#ornek');
    await waitForModel(page);
    await expect(page.locator('#filtreler .filtre')).toHaveText(['Small shells (<8 mm³)', 'Thin fragments']);
    await expect(page.locator('#filtre-kabuk')).toBeChecked();
    await expect(page.locator('#filtre-parca')).toBeChecked();
    await expect(page.locator('#filtre-not')).toContainText('removed.');
    await expect(page.locator('.bolme-not', { hasText: 'specks' })).toHaveCount(0);

    // Off: the table comes back at once, and joins the list.
    const before = await triangles(page);
    await page.uncheck('#filtre-parca');
    expect(await triangles(page)).toBeGreaterThan(before);
    await expect(page.locator('#yapilar')).toContainText('Likely scanner table');
    await page.check('#filtre-parca');
    expect(await triangles(page)).toBe(before);
    await expect(page.locator('#yapilar')).not.toContainText('Likely scanner table');
  });

  test('small shells are counted, built when asked for and hidden again without a rebuild', async ({ page }) => {
    await fakeStorage(page);
    await open(page, withShells());
    await waitForModel(page);
    await expect(page.locator('#filtre-not')).toHaveText('3 small shells removed.');
    const before = await triangles(page);

    await page.uncheck('#filtre-kabuk');
    await expect(page.locator('#filtre-not')).toBeHidden();
    await expect.poll(() => triangles(page), { timeout: 30_000 }).toBeGreaterThan(before);
    await waitForModel(page);
    await expect(page.locator('#yapilar li')).toHaveCount(1);

    await page.check('#filtre-kabuk');
    await expect(page.locator('#filtre-not')).toHaveText('3 small shells removed.');
    expect(await triangles(page)).toBe(before);
  });

  test('the choice survives a threshold change and resets for a new case', async ({ page }) => {
    await page.goto('/');
    await page.click('#ornek');
    await waitForModel(page);
    await page.uncheck('#filtre-parca');
    await page.fill('#esik-sayi-min', '400');
    await page.press('#esik-sayi-min', 'Enter');
    await waitForModel(page);
    await expect(page.locator('#filtre-parca')).not.toBeChecked();
    await page.click('#yeni-vaka');
    await page.click('#ornek');
    await waitForModel(page);
    await expect(page.locator('#filtre-parca')).toBeChecked();
    await expect(page.locator('#yapilar-bolme')).not.toHaveAttribute('open');
  });

  test('says so when the filters hide everything', async ({ page }) => {
    await fakeStorage(page);
    // A thin curved shell alone: everything in it counts as a thin fragment.
    const shell = spherePhantom({ radiusMm: 12, size: 64, count: 64 }).slices.map((s) => ({
      ...s,
      hu: (i: number, j: number) => { const d = Math.hypot(i * 0.5 - 16, j * 0.5 - 16, s.position[2] - 16); return d > 10 && d < 10.5 ? 1000 : -1000; },
    }));
    await open(page, asFiles(shell));
    await page.locator('#ozet', { hasText: 'triangles' }).waitFor({ timeout: 60_000 });
    await expect(page.locator('#ipucu')).toContainText('Everything here is filtered');
    await page.uncheck('#filtre-parca');
    await expect(page.locator('#ipucu')).toBeHidden();
  });

  test('structures stay closed until clicked, and show seven rows at a time', async ({ page }) => {
    await fakeStorage(page);
    // Eight spheres in a row: more pieces than the seven rows show.
    const spheres = spherePhantom({ radiusMm: 12, size: 96, count: 16 }).slices.map((s) => ({
      ...s,
      hu: (i: number, j: number) => {
        for (let c = 0; c < 8; c++) if (Math.hypot(i * 0.5 - (3 + c * 5.5), j * 0.5 - 12, s.position[2] - 4) < 2) return 1000;
        return -1000;
      },
    }));
    await open(page, asFiles(spheres));
    await waitForModel(page);
    await expect(page.locator('#yapilar li').first()).toBeHidden();
    await expect(page.locator('#yapilar-not')).toBeHidden();
    await page.locator('#yapilar-bolme summary').scrollIntoViewIfNeeded();
    await page.click('#yapilar-bolme summary');
    await expect(page.locator('#yapilar li')).toHaveCount(8);
    const { view, row, scroll } = await page.locator('#yapilar').evaluate((el) => ({ view: el.clientHeight, row: el.children[0].getBoundingClientRect().height, scroll: el.scrollHeight }));
    expect(Math.round(view / row)).toBe(7);
    expect(scroll).toBeGreaterThan(view);
    await page.click('#yapilar-bolme summary');
    await expect(page.locator('#yapilar li').first()).toBeHidden();
  });

  test('more than fifty pieces lists the largest fifty', async ({ page }) => {
    await fakeStorage(page);
    const grid = spherePhantom({ radiusMm: 12, size: 96, count: 16 }).slices.map((s) => ({
      ...s,
      hu: (i: number, j: number) => {
        const ci = Math.round((i * 0.5 - 4) / 5), cj = Math.round((j * 0.5 - 4) / 5);
        if (ci < 0 || ci > 7 || cj < 0 || cj > 7) return -1000;
        return Math.hypot(i * 0.5 - (4 + ci * 5), j * 0.5 - (4 + cj * 5), s.position[2] - 4) < 2 ? 1000 : -1000;
      },
    }));
    await open(page, asFiles(grid));
    await waitForModel(page);
    await expect(page.locator('#yapilar li')).toHaveCount(50);
    await page.locator('#yapilar-bolme summary').scrollIntoViewIfNeeded();
    await expect(page.locator('#yapilar-not')).toHaveText('Largest 50');
  });

  test('a piece hidden by clicking the model comes back from the list', async ({ page }) => {
    await page.goto('/');
    await page.click('#ornek');
    await waitForModel(page);
    const before = await triangles(page);
    const box = (await page.locator('#tuval').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#aksiyon')).toBeVisible();
    await page.click('#aksiyon-gizle');
    expect(await triangles(page)).toBeLessThan(before);
    await page.locator('#yapilar-bolme summary').scrollIntoViewIfNeeded();
    await page.click('#yapilar-bolme summary');
    await page.locator('#yapilar input:not(:checked)').click();
    await expect.poll(() => triangles(page)).toBe(before);
  });

  test('warnings appear above the threshold, with no label', async ({ page }) => {
    await fakeStorage(page);
    const { slices } = spherePhantom({ radiusMm: 12 });
    await open(page, asFiles(slices.filter((s) => s.instance !== 20)));
    await waitForModel(page);
    await expect(page.locator('#uyarilar')).toBeVisible();
    await expect(page.locator('#uyarilar')).toContainText('1 slice is missing');
  });
});

test.describe('small screens', () => {
  for (const [label, width, height] of [['phone', 390, 844], ['tablet', 820, 1180]] as const) {
    test(`nothing is cut off on a ${label}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      await page.goto('/');
      await page.click('#ornek');
      await waitForModel(page);
      expect((await page.locator('.logo-link svg').boundingBox())!.width).toBeGreaterThan(80);
      for (const selector of ['.logo-link svg', '#gonder', '#yeni-vaka', '#sigdir', '.kup-kap', '.yakinda', '#esik-sayi-max', '#aralik', '#esik-not', '#ozet']) {
        const box = (await page.locator(selector).first().boundingBox())!;
        expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(width + 1);
      }
      const summary = (await page.locator('#ozet').boundingBox())!, cube = (await page.locator('.kup-kap').boundingBox())!;
      const overlap = summary.x + summary.width > cube.x && summary.y + summary.height > cube.y && summary.y < cube.y + cube.height;
      expect(overlap, 'summary runs under the cube').toBe(false);
      await context.close();
    });
  }
});

test.describe('rotating the view', () => {
  /** The cube's rotation, which follows the camera: the 16 numbers of its CSS matrix. */
  const cube = (page: Page) => page.locator('#kup').evaluate((el) => (el as HTMLElement).style.transform.match(/-?[\d.e-]+/g)!.slice(1).map(Number));
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
  /** Waits until the cube has stopped moving, since slow graphics can stretch an animation well past its 420 ms. */
  const settle = async (page: Page) => {
    await page.waitForTimeout(500);
    let last = '';
    await expect.poll(async () => {
      const now = await page.locator('#kup').evaluate((el) => (el as HTMLElement).style.transform);
      const still = now === last;
      last = now;
      return still;
    }, { timeout: 20_000, intervals: [250] }).toBe(true);
  };
  const sample = async (page: Page) => { await page.goto('/'); await page.click('#ornek'); await waitForModel(page); await settle(page); };
  const center = async (page: Page) => { const b = (await page.locator('#tuval').boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };
  const drag = async (page: Page, dx: number, dy: number, button: 'left' | 'right' = 'left') => {
    const { x, y } = await center(page);
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up({ button });
    await page.waitForTimeout(120);
  };

  test('has no stop going over the top, and keeps going sideways', async ({ page }) => {
    await sample(page);
    // A turntable can't turn the view upside down. Element 5 of the matrix is the cosine that goes negative when it does.
    const seen: number[] = [];
    for (let n = 0; n < 8; n++) {
      await drag(page, 0, 120);
      seen.push((await cube(page))[5]);
    }
    expect(Math.min(...seen)).toBeLessThan(-0.5);
    expect(Math.max(...seen)).toBeGreaterThan(0.2);

    const before = await cube(page);
    await drag(page, 150, 0);
    expect(near(await cube(page), before)).toBe(false);
  });

  test('the arrows appear only at a face, and vanish after a drag', async ({ page }) => {
    await sample(page);
    await expect(page.locator('[data-cevir]').first()).toBeHidden();
    await page.locator('#kup [data-yuz="z"]').click({ force: true });
    await settle(page);
    await expect(page.locator('[data-cevir="saat"]')).toBeVisible();
    await expect(page.locator('[data-cevir="ters"]')).toBeVisible();
    await drag(page, 120, 40);
    await expect(page.locator('[data-cevir="saat"]')).toBeHidden();
  });

  test('each arrow turns exactly 90°, and the steps add up', async ({ page }) => {
    await sample(page);
    await page.locator('#kup [data-yuz="z"]').click({ force: true });
    await settle(page);
    const start = await cube(page);

    await page.click('[data-cevir="saat"]');
    await settle(page);
    const turned = await cube(page);
    expect(near(turned, start)).toBe(false);
    // A quarter turn swaps the axes on screen exactly: each entry of the rotation is 0 or ±1.
    expect(turned.slice(0, 12).every((v) => Math.abs(Math.abs(v) - Math.round(Math.abs(v))) < 1e-3)).toBe(true);

    await page.click('[data-cevir="ters"]');
    await settle(page);
    expect(near(await cube(page), start)).toBe(true);

    for (let n = 0; n < 4; n++) { await page.click('[data-cevir="saat"]'); await settle(page); }
    expect(near(await cube(page), start)).toBe(true);

    // Two quick clicks land on a half turn, not somewhere in between.
    await page.click('[data-cevir="saat"]');
    await page.click('[data-cevir="saat"]');
    await settle(page);
    await page.click('[data-cevir="ters"]');
    await page.click('[data-cevir="ters"]');
    await settle(page);
    expect(near(await cube(page), start)).toBe(true);
  });

  test('a face click squares up a rolled view, and fit returns to the opening angle', async ({ page }) => {
    await sample(page);
    const opening = await cube(page);
    await drag(page, 90, 170);
    await page.locator('#kup [data-yuz="z"]').click({ force: true });
    await settle(page);
    const squared = await cube(page);
    expect(squared.slice(0, 12).every((v) => Math.abs(Math.abs(v) - Math.round(Math.abs(v))) < 1e-3)).toBe(true);
    await page.click('#sigdir');
    await settle(page);
    expect(near(await cube(page), opening)).toBe(true);
  });

  test('a snapshot carries the measurements on screen, and leaves out ones clipped away', async ({ page }) => {
    await sample(page);
    /** How many pixels of a downloaded snapshot are exactly the measurement colour. */
    const accentPixels = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#goruntu')]);
      const png = readFileSync(await download.path()).toString('base64');
      return page.evaluate(async (data) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] === 0x1F && d[i + 1] === 0x7A && d[i + 2] === 0x54) n++;
        return n;
      }, png);
    };
    expect(await accentPixels()).toBe(0);

    const { x, y } = await center(page);
    await page.click('[data-arac="distance"]');
    await page.mouse.click(x - 20, y);
    await page.mouse.click(x + 20, y);
    await expect(page.locator('.etiket-olcu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const drawn: string[] = [];
      (window as unknown as { drawn: string[] }).drawn = drawn;
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text: string, x: number, y: number) { drawn.push(text); original.call(this, text, x, y); };
    });
    expect(await accentPixels()).toBeGreaterThan(50);
    const shown = (await page.locator('.etiket-olcu').textContent())!;
    expect(await page.evaluate(() => (window as unknown as { drawn: string[] }).drawn)).toContain(shown);

    await page.locator('#kesitler input[type=checkbox][data-eksen="0"]').check();
    await expect(page.locator('.etiket-olcu')).toHaveCount(0);
    expect(await accentPixels()).toBe(0);
  });

  test('panning follows the pointer exactly, and zoom still works', async ({ page }) => {
    await sample(page);
    const { x, y } = await center(page);
    const dot = page.locator('#katman circle').first();
    const at = async () => [+(await dot.getAttribute('cx'))!, +(await dot.getAttribute('cy'))!];

    // A second point finishes the measurement, so its dots stay on screen.
    await page.click('[data-arac="distance"]');
    await page.mouse.click(x, y);
    await page.mouse.click(x + 30, y + 10);
    await page.keyboard.press('Escape');
    await expect(dot).toHaveCount(1);
    const first = await at();
    await drag(page, 100, -60, 'right');
    await expect.poll(async () => {
      const moved = await at();
      return Math.max(Math.abs(moved[0] - first[0] - 100), Math.abs(moved[1] - first[1] + 60));
    }, { timeout: 10_000 }).toBeLessThan(3);

    const scale = () => page.locator('#olcek-yazi').textContent();
    const barWidth = () => page.locator('#olcek-cizgi').evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    const before = `${await scale()} ${await barWidth()}`;
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => `${await scale()} ${await barWidth()}`).not.toBe(before);
  });

  test('an idle page draws nothing', async ({ page }) => {
    await sample(page);
    await page.locator('#kup [data-yuz="x"]').click({ force: true });
    await settle(page);
    await page.evaluate(() => {
      const gl = (document.getElementById('tuval') as HTMLCanvasElement).getContext('webgl2')!;
      const draw = gl.drawElements.bind(gl);
      const w = window as unknown as { draws: number };
      w.draws = 0;
      gl.drawElements = (...args: Parameters<typeof draw>) => { w.draws++; draw(...args); };
    });
    const draws = () => page.evaluate(() => (window as unknown as { draws: number }).draws);
    await page.waitForTimeout(800);
    expect(await draws()).toBe(0);
    // The same counter does see a drag, so the zero above means something.
    await drag(page, 60, 0);
    expect(await draws()).toBeGreaterThan(0);
    const after = await draws();
    await page.waitForTimeout(800);
    expect(await draws()).toBe(after);
  });

  test('measuring, click-to-hide and sections still work after going over the top and rolling', async ({ page }) => {
    await sample(page);
    const problems = collectProblems(page);
    for (let n = 0; n < 5; n++) await drag(page, 0, 120);
    await page.locator('#kup [data-yuz="y"]').click({ force: true });
    await settle(page);
    await page.click('[data-cevir="saat"]');
    await settle(page);

    const { x, y } = await center(page);
    await page.click('[data-arac="distance"]');
    await page.mouse.click(x - 20, y);
    await page.mouse.click(x + 20, y);
    await expect(page.locator('#olculer li')).toHaveCount(1);
    await page.keyboard.press('Escape');

    await page.locator('#kesitler input[type=checkbox][data-eksen="1"]').check();
    await expect(page.locator('#kesitler input[type=range][data-eksen="1"]')).toBeEnabled();
    await page.locator('#kesitler input[type=checkbox][data-eksen="1"]').uncheck();

    await page.mouse.click(x, y);
    await expect(page.locator('#aksiyon')).toBeVisible();
    await page.click('#aksiyon-gizle');
    await page.locator('#yapilar-bolme summary').scrollIntoViewIfNeeded();
    await page.click('#yapilar-bolme summary');
    await expect(page.locator('#yapilar input:not(:checked)')).toHaveCount(1);
    expect(problems).toEqual([]);
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

  test('a folder of BMP pictures says what it found', async ({ page }) => {
    const bmp = Buffer.alloc(5000, 1);
    bmp.write('BM');
    await open(page, Array.from({ length: 12 }, (_, i) => ({ name: `IMG${i}.bmp`, mimeType: 'image/bmp', buffer: bmp })));
    await expect(page.locator('#hata-metin')).toContainText('12 pictures');
    await expect(page.locator('#hata-metin')).toContainText('no density data');
  });

  test('a RAR archive is named and the vet is told to unpack it', async ({ page }) => {
    await open(page, [{ name: 'scan.rar', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('Rar!'), Buffer.alloc(100, 3)]) }]);
    await expect(page.locator('#hata-metin')).toContainText('RAR archive');
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
    await expect(page.locator('#depo-ref')).toHaveText('VS-20261031-ABC123', { timeout: 30_000 });

    const record = seen.record as unknown as {
      consent: { version: string; text: string; acceptedAt: string };
      patient: { name: string; species: string; breed: string; ageYears: number; weightKg: number };
      clinician: string;
      study: { slices: number; dicomSpecies: string };
      files: number;
      zipBytes: number;
    };
    expect(record.patient).toEqual({ name: 'Max', species: 'Dog', breed: 'Beagle', ageYears: 3, weightKg: 12.4 });
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
      return route.fulfill({ status: 200, headers: cors, json: { caseId: 'VS-RETRY', uploadUrl: 'https://vimics.sharepoint.com/up/session' } });
    });
    await open(page, sphereFiles());
    await waitForModel(page);
    await expect(page.locator('#depo-metin')).toContainText('Storage is unavailable', { timeout: 30_000 });
    await expect(page.locator('#yapilar li')).toHaveCount(1);
    refuse = false;
    await page.click('#depo-tekrar');
    await expect(page.locator('#depo-ref')).toHaveText('VS-RETRY', { timeout: 30_000 });
    expect(seen.chunks.length).toBeGreaterThan(0);
  });
});
