import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeHounsfield, decodeStoredPixels } from '../src/engine/dicom/decode';
import { deidentify } from '../src/engine/dicom/deidentify';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { groupSeries, pickBestSeries } from '../src/engine/dicom/series';
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
