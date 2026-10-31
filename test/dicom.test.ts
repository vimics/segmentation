import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeHounsfield, decodeStoredPixels } from '../src/engine/dicom/decode';
import { deidentify } from '../src/engine/dicom/deidentify';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { scanSource } from '../src/engine/dicom/scan';
import { describeSeries, filterFamily, groupSeries, mainReason, mixedUploadWarning, pickBestSeries } from '../src/engine/dicom/series';
import { HEAD_BYTES } from '../src/engine/io/sniff';
import { PLANTED, spherePhantom, writeSlice, type SliceSpec, type Syntax } from './phantom';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, 'fixtures', name)));
const parse = (bytes: Uint8Array) => {
  const ds = parseDataset(bytes);
  if (!ds) throw new Error('not parsed');
  const h = readHeader(ds, 0);
  if (!h) throw new Error('no header');
  return { ds, h };
};
const stored = async (bytes: Uint8Array) => { const { ds, h } = parse(bytes); return decodeStoredPixels(ds, h); };

const small = (extra: Partial<SliceSpec> = {}): SliceSpec => ({
  rows: 16, cols: 24, instance: 1, position: [0, 0, 0],
  hu: (i, j) => -1000 + (i * 37 + j * 101) % 3000,
  ...extra,
});

describe('decoding public reference files', () => {
  it('reads MR_small identically from every encoding', async () => {
    const reference = await stored(fixture('MR_small.dcm'));
    expect(reference.length).toBe(64 * 64);
    for (const name of ['MR_small_RLE.dcm', 'MR_small_implicit.dcm', 'MR_small_expb.dcm', 'MR_small_bigendian.dcm', 'MR_small_jpeg_ls_lossless.dcm', 'MR_small_jp2klossless.dcm']) {
      const px = await stored(fixture(name));
      expect(Array.from(px), name).toEqual(Array.from(reference));
    }
  });

  it('reads a real CT slice as plausible Hounsfield units', async () => {
    const { ds, h } = parse(fixture('CT_small.dcm'));
    expect(h.modality).toBe('CT');
    const hu = await decodeHounsfield(ds, h);
    expect(hu.length).toBe(128 * 128);
    expect(Math.min(...hu)).toBeLessThan(-500);
    expect(Math.max(...hu)).toBeGreaterThan(100);
  });

  it('reads a deflated file', () => {
    const { h, ds } = parse(fixture('image_dfl.dcm'));
    expect(h.rows).toBeGreaterThan(0);
    expect(ds.elements.x7fe00010).toBeTruthy();
  });

  it('skips files that are not DICOM', () => {
    expect(parseDataset(new TextEncoder().encode('just a text file, not an image'))).toBeNull();
    expect(parseDataset(new Uint8Array(500))).toBeNull();
  });
});

describe('decoding phantom slices', () => {
  const syntaxes: Syntax[] = ['explicit', 'implicit', 'bigendian', 'rle', 'jpeglossless'];
  it.each(syntaxes)('%s round-trips exact Hounsfield values', async (syntax) => {
    const spec = small({ syntax });
    const { ds, h } = parse(writeSlice(spec));
    const hu = await decodeHounsfield(ds, h);
    for (let j = 0, n = 0; j < spec.rows; j++) for (let i = 0; i < spec.cols; i++, n++) {
      expect(hu[n]).toBe(spec.hu(i, j));
    }
  });

  it('reads files that have no preamble', async () => {
    const spec = small({ syntax: 'implicit', noPreamble: true });
    const { ds, h } = parse(writeSlice(spec));
    expect(h.modality).toBe('CT');
    expect((await decodeHounsfield(ds, h))[1]).toBe(spec.hu(1, 0));
  });

  it('reads files with no preamble that use explicit VR', async () => {
    const spec = small({ syntax: 'explicit', noPreamble: true });
    const { ds, h } = parse(writeSlice(spec));
    expect(h.rows).toBe(16);
    expect((await decodeHounsfield(ds, h))[1]).toBe(spec.hu(1, 0));
  });

  it('reads files that start with the meta group and have no preamble', async () => {
    const spec = small({ metaNoPreamble: true });
    const { ds, h } = parse(writeSlice(spec));
    expect(h.modality).toBe('CT');
    expect((await decodeHounsfield(ds, h))[1]).toBe(spec.hu(1, 0));
  });
});

describe('scanning a file for its header', () => {
  const source = (bytes: Uint8Array) => ({ file: new File([bytes as Uint8Array<ArrayBuffer>], 'x'), name: 'x' });

  it('names a stray file without parsing it', async () => {
    const { kind, ds } = await scanSource(source(new Uint8Array([0x42, 0x4d, 1, 2, 3, 4, 5, 6])));
    expect(kind).toBe('bmp');
    expect(ds).toBeNull();
  });

  it('still finds the geometry when a private block runs past the first bytes', async () => {
    const { kind, ds } = await scanSource(source(writeSlice(small({ privateBytes: HEAD_BYTES * 2 }))));
    expect(kind).toBe('dicom');
    const h = readHeader(ds!, 0)!;
    expect(h.rows).toBe(16);
    expect(h.position).toEqual([0, 0, 0]);
  });

  it('reads the same header from a large slice using only its first bytes', async () => {
    const big = writeSlice(small({ rows: 512, cols: 512, hu: () => 0 }));
    const { ds } = await scanSource(source(big));
    expect(ds!.byteArray.length).toBeLessThanOrEqual(HEAD_BYTES);
    expect(readHeader(ds!, 0)!.rows).toBe(512);
  });
});

describe('series assembly', () => {
  const headers = (slices: SliceSpec[]) => slices.map((s, i) => { const h = readHeader(parseDataset(writeSlice(s), { headerOnly: true })!, i); return h!; });

  it('sorts by position, not by instance number or file order', () => {
    const { slices } = spherePhantom({ size: 8, count: 10 });
    const shuffled = [...slices].sort((a, b) => (a.instance * 7) % 10 - (b.instance * 7) % 10);
    const reversedNumbers = shuffled.map((s) => ({ ...s, instance: 100 - s.instance }));
    const [series] = groupSeries(headers(reversedNumbers));
    expect(series.usable).toBe(true);
    const z = series.slices.map((h) => h.position![2]);
    expect(z).toEqual([...z].sort((a, b) => a - b));
    expect(series.sliceSpacing).toBeCloseTo(0.5);
  });

  it('warns about missing slices', () => {
    const { slices } = spherePhantom({ size: 8, count: 20 });
    const [series] = groupSeries(headers(slices.filter((s) => s.instance !== 10 && s.instance !== 11)));
    expect(series.usable).toBe(true);
    expect(series.warnings.join(' ')).toMatch(/2 slices are missing/);
  });

  it('drops duplicates and warns', () => {
    const { slices } = spherePhantom({ size: 8, count: 10 });
    const [series] = groupSeries(headers([...slices, slices[3]]));
    expect(series.slices.length).toBe(10);
    expect(series.warnings.join(' ')).toMatch(/duplicate/);
  });

  it('rejects MR, scouts, and series without geometry with a plain reason', () => {
    const mr = groupSeries(headers([small({ modality: 'MR' })]))[0];
    expect(mr.usable).toBe(false);
    expect(mr.reason).toMatch(/MR, not CT/);
    const scout = groupSeries(headers([small({ imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER' })]))[0];
    expect(scout.reason).toMatch(/scout/);
    const few = groupSeries(headers([small(), small({ position: [0, 0, 1], instance: 2 })]))[0];
    expect(few.reason).toMatch(/too few/);
  });

  it('keeps series and matrices apart and picks the best', () => {
    const a = spherePhantom({ size: 8, count: 10 }).slices.map((s) => ({ ...s, seriesUid: '1.1' }));
    const b = spherePhantom({ size: 8, count: 40 }).slices.map((s) => ({ ...s, seriesUid: '1.2' }));
    const series = groupSeries(headers([...a, ...b]));
    expect(series.length).toBe(2);
    expect(pickBestSeries(series)!.slices.length).toBe(40);
  });

  const stack = (count: number, extra: Partial<SliceSpec>, dz = 1) => Array.from({ length: count }, (_, k) => small({ position: [0, 0, k * dz], instance: k + 1, ...extra }));

  it('keeps the real series when a scout or colour file shares its UID', () => {
    const slices = stack(10, {});
    const [series] = groupSeries(headers([...slices, small({ imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER', position: [0, 0, 4.5], instance: 90 })]));
    expect(series.usable).toBe(true);
    expect(series.slices.length).toBe(10);
    expect(series.warnings.join(' ')).toMatch(/1 file in this series could not be used/);
  });

  it('keeps the name of the series when the first file is the one skipped', () => {
    const scout = small({ imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER', kernel: 'B40s', instance: 90 });
    const [series] = groupSeries(headers([scout, ...stack(10, { kernel: 'B70f' })]));
    expect(series.kernel).toBe('B70f');
    expect(series.filter).toBe('bone');
  });

  it('keeps apart reconstructions that differ only in pixel size', () => {
    const series = groupSeries(headers([...stack(5, { pixelSpacing: [0.5, 0.5] }), ...stack(5, { pixelSpacing: [0.25, 0.25] })]));
    expect(series.length).toBe(2);
  });

  it('splits separate regions under one UID, so no surface bridges them', () => {
    const series = groupSeries(headers([...stack(10, {}), ...stack(10, {}).map((s) => ({ ...s, position: [0, 0, 300 + s.position[2]], instance: s.instance + 50 }))]));
    expect(series.length).toBe(2);
    expect(series.map((s) => s.slices.length)).toEqual([10, 10]);
  });

  it('splits repeated passes over the same anatomy', () => {
    const series = groupSeries(headers([...stack(8, { temporal: '1' }), ...stack(8, { temporal: '2' })]));
    expect(series.map((s) => s.slices.length)).toEqual([8, 8]);
    expect(series.every((s) => s.warnings.every((w) => !/duplicate/.test(w)))).toBe(true);
  });

  it('keeps one volume when acquisition numbers change but positions do not repeat', () => {
    // Seen on Hitachi: one 289-slice volume carried four acquisition numbers.
    const slices = stack(12, {}).map((s, k) => ({ ...s, acquisition: String(1 + (k >> 2)) }));
    const series = groupSeries(headers(slices));
    expect(series.length).toBe(1);
    expect(series[0].slices.length).toBe(12);
  });

  describe('choosing the default', () => {
    const named = (uid: string, count: number, extra: Partial<SliceSpec>, dz = 1) => stack(count, { seriesUid: uid, ...extra }, dz);
    const choose = (...groups: SliceSpec[][]) => pickBestSeries(groupSeries(headers(groups.flat())))!;

    it('matches the TotalSegmentator study: the full scan beats a sharper partial one', () => {
      const best = choose(named('br', 362, { kernel: 'Br44', description: '' }), named('bl', 136, { kernel: 'Bl64', description: '' }));
      expect(best.kernel).toBe('Br44');
      expect(best.slices.length).toBe(362);
    });

    it('takes the bone filter when both cover the scan', () => {
      expect(choose(named('s', 200, { kernel: 'B31s', description: '' }), named('b', 190, { kernel: 'B70f', description: '' })).kernel).toBe('B70f');
    });

    it('does not let a partial bone series hide the full scan', () => {
      expect(choose(named('s', 300, { kernel: 'B31s', description: '' }), named('b', 100, { kernel: 'B70f', description: '' })).kernel).toBe('B31s');
    });

    it('prefers the reconstruction over a reformat with as much coverage', () => {
      const best = choose(named('o', 766, { kernel: 'I80s', description: '', imageType: 'ORIGINAL\\PRIMARY\\AXIAL\\CT_SOM5 SPI' }), named('m', 800, { kernel: 'I80s', description: '', imageType: 'DERIVED\\PRIMARY\\AXIAL\\CT_SOM5 MPR' }));
      expect(best.slices.length).toBe(766);
      expect(best.reformat).toBe(false);
    });

    it('accepts a reformat when the upload has nothing else, as one real case did', () => {
      const best = choose(named('m', 708, { kernel: 'B70f', description: '', imageType: 'DERIVED\\PRIMARY\\AXIAL\\CT_SOM5 MPR' }));
      expect(best.slices.length).toBe(708);
    });

    it('does not count DERIVED alone as a reformat, because main series are often marked that way', () => {
      const best = choose(named('m', 289, { kernel: '42', description: 'BILAT BONE', imageType: 'DERIVED\\SECONDARY\\\\POST_RECON' }), named('r', 51, { kernel: '42', description: 'BONE', imageType: 'DERIVED\\SECONDARY\\\\MPR' }));
      expect(best.slices.length).toBe(289);
      expect(best.reformat).toBe(false);
    });

    it('prefers pre-contrast when everything else is equal', () => {
      expect(choose(named('post', 50, { kernel: 'B70f', contrast: 'IOHEXOL' }), named('pre', 50, { kernel: 'B70f' })).slices[0].contrast).toBe(false);
    });
  });

  it('takes the plane from the orientation, not from words in the description', () => {
    const sagittal = stack(5, { orientation: [0, 1, 0, 0, 0, -1], description: 'Ax' });
    expect(groupSeries(headers(sagittal))[0].plane).toBe('sagittal');
    // "SAG" here is Turkish for right, on an axial series.
    expect(groupSeries(headers(stack(5, { description: 'SAG ON EKSTREMITE' })))[0].plane).toBe('axial');
    const oblique = stack(5, { orientation: [0.77, 0.63, 0.1, 0.14, 0, -0.99] });
    expect(groupSeries(headers(oblique))[0].plane).toBe('oblique');
  });

  it.each([
    ['Br44', '', 'soft'], ['Bl64', '', 'lung'], ['B70f', '', 'bone'], ['I80s', '', 'bone'], ['I31s', '', 'soft'], ['Hr64', '', 'bone'], ['Ur77', '', 'bone'],
    ['BONE', '', 'bone'], ['BONEPLUS', '', 'bone'], ['STANDARD', '', 'soft'], ['LUNG', '', 'lung'], ['FC30', '', 'bone'],
    ['42', 'BILAT ON EKSTREMITE BONE', 'bone'], ['31', 'BILAT ON EKSTREMITE', 'unknown'], ['', '', 'unknown'],
  ])('filter %s with description "%s" is %s', (kernel, description, family) => {
    expect(filterFamily(kernel, description)).toBe(family);
  });

  it('names rows plainly and never guesses a filter', () => {
    const all = groupSeries(headers([
      ...stack(100, { seriesUid: 'b', kernel: 'Hr64', description: '' }),
      ...stack(30, { seriesUid: 'l', kernel: 'Bl64', description: '' }),
      ...stack(100, { seriesUid: 'u', kernel: '', description: '' }),
      ...stack(20, { seriesUid: 'n', kernel: '31', description: '', imageType: 'DERIVED\\SECONDARY\\\\MPR', orientation: [0, 1, 0, 0, 0, -1] }).map((s, k) => ({ ...s, position: [k, 0, 0] })),
    ]));
    const row = (uid: string) => describeSeries(all.find((s) => s.slices[0].seriesUid === uid)!, all);
    expect(row('b')).toBe('Bone filter (Hr64) · Full scan · 1.0 mm · 100 slices');
    expect(row('l')).toBe('Lung filter (Bl64) · Partial scan · 1.0 mm · 30 slices');
    expect(row('u')).toBe('CT series · Full scan · 1.0 mm · 100 slices');
    expect(row('n')).toBe('Filter 31 · Sagittal reformat · 1.0 mm · 20 slices');
  });

  it('blames the main series, not a stray dose report, when nothing can be used', () => {
    const lossy = stack(40, { seriesUid: 'c', samples: 3 });
    const dose = [small({ seriesUid: 'd', modality: 'SR' })];
    const series = groupSeries(headers([...dose, ...lossy]));
    expect(pickBestSeries(series)).toBeNull();
    expect(mainReason(series)).toMatch(/colour/);
  });

  it('points out a mixed upload', () => {
    const one = stack(5, {});
    expect(mixedUploadWarning(groupSeries(headers(one)))).toBeNull();
    const twoStudies = groupSeries(headers([...one, ...stack(5, { seriesUid: '9', studyUid: '1.2.9' })]));
    expect(mixedUploadWarning(twoStudies)).toMatch(/2 separate studies/);
    const twoPatients = groupSeries(headers([...one, ...stack(5, { seriesUid: '9', studyUid: '1.2.9', patientName: 'OTHER^PATIENT' })]));
    expect(mixedUploadWarning(twoPatients)).toMatch(/2 different patients/);
  });
});

describe('de-identification', () => {
  const asText = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

  it.each<Syntax>(['explicit', 'implicit', 'bigendian', 'rle', 'jpeglossless'])('%s: removes every planted identifier and keeps pixels', async (syntax) => {
    const original = writeSlice(small({ syntax }));
    const before = parse(original);
    const out = await deidentify(before.ds, 'salt');
    const text = asText(out);
    for (const value of [...Object.values(PLANTED), 'PLANTEDID', 'PLANTEDACC', '20261012', 'PRIVATECREATOR']) {
      expect(text, value).not.toContain(value);
    }
    const after = parse(out);
    expect(after.h.rows).toBe(before.h.rows);
    expect(after.h.species).toBe('Canine');
    expect(after.h.position).toEqual(before.h.position);
    expect(after.h.transferSyntax).toBe(before.h.transferSyntax);
    expect(after.ds.string('x00120062')?.trim()).toBe('YES');
    expect(Array.from(await decodeStoredPixels(after.ds, after.h))).toEqual(Array.from(await decodeStoredPixels(before.ds, before.h)));
  });

  it('keeps slices of one series in one series, under a new UID', async () => {
    const a = parse(await deidentify(parse(writeSlice(small({ instance: 1 }))).ds, 's1'));
    const b = parse(await deidentify(parse(writeSlice(small({ instance: 2 }))).ds, 's1'));
    expect(a.h.seriesUid).toBe(b.h.seriesUid);
    expect(a.h.seriesUid).not.toContain(PLANTED.uid);
    expect(a.ds.string('x00080018')).not.toBe(b.ds.string('x00080018'));
    const other = parse(await deidentify(parse(writeSlice(small({ instance: 1 }))).ds, 's2'));
    expect(other.h.seriesUid).not.toBe(a.h.seriesUid);
  });

  it('handles the real CT reference file', async () => {
    const before = parse(fixture('CT_small.dcm'));
    const out = await deidentify(before.ds, 'salt');
    expect(asText(out)).not.toContain('CompressedSamples');
    const after = parse(out);
    expect(Array.from(await decodeStoredPixels(after.ds, after.h))).toEqual(Array.from(await decodeStoredPixels(before.ds, before.h)));
  });
});
