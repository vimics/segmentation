import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HEAD_BYTES, sniffKind } from '../src/engine/io/sniff';
import { isZip, listZip, noProblems, readHead, readSource, toSources } from '../src/engine/io/sources';

const zipFile = (entries: Record<string, Uint8Array>, level: 0 | 6 = 6) => new File([zipSync(entries, { level }) as Uint8Array<ArrayBuffer>], 'scan.zip');

describe('reading files', () => {
  it('lists and reads compressed and stored ZIP entries', async () => {
    for (const level of [0, 6] as const) {
      const file = zipFile({ 'study/a.dcm': strToU8('alpha alpha alpha'), 'study/b.dcm': strToU8('beta') }, level);
      expect(await isZip(file)).toBe(true);
      const list = await listZip(file);
      expect(list.map((s) => s.name)).toEqual(['study/a.dcm', 'study/b.dcm']);
      expect(new TextDecoder().decode(await readSource(list[0]))).toBe('alpha alpha alpha');
      expect(new TextDecoder().decode(await readSource(list[1]))).toBe('beta');
    }
  });

  it('skips macOS extras and hidden files', async () => {
    const file = zipFile({ 'a.dcm': strToU8('a'), '__MACOSX/._a.dcm': strToU8('x'), '.DS_Store': strToU8('y'), 'dir/.hidden': strToU8('z') });
    expect((await listZip(file)).map((s) => s.name)).toEqual(['a.dcm']);
  });

  it('mixes loose files and ZIPs', async () => {
    const { sources } = await toSources([new File([strToU8('loose')], 'x.dcm'), zipFile({ 'y.dcm': strToU8('zipped') }), new File([strToU8('n')], '.DS_Store')]);
    expect(sources.map((s) => s.name)).toEqual(['x.dcm', 'y.dcm']);
  });

  it('reports a damaged ZIP in plain words', async () => {
    const whole = zipSync({ 'a.dcm': strToU8('a') });
    const truncated = new File([whole.slice(0, whole.length - 30) as Uint8Array<ArrayBuffer>], 'bad.zip');
    await expect(listZip(truncated)).rejects.toThrow(/damaged or incomplete/);
  });
});

/** Rewrites one field of every central directory record, to build ZIPs fflate won't write itself. */
function patchCentral(zip: Uint8Array, at: number, value: number): Uint8Array {
  const out = zip.slice(), v = new DataView(out.buffer);
  for (let p = 0; p + 4 <= out.length; p++) if (v.getUint32(p, true) === 0x02014b50) v.setUint16(p + at, value, true);
  return out;
}
const asFile = (b: Uint8Array, name: string) => new File([b as Uint8Array<ArrayBuffer>], name);

describe('what vets actually send', () => {
  it('a damaged ZIP does not stop the other files', async () => {
    const damaged = asFile(zipSync({ 'a.dcm': strToU8('a') }).slice(0, 40), 'broken.zip');
    const { sources, problems } = await toSources([damaged, new File([strToU8('scan')], 'x.dcm')]);
    expect(sources.map((s) => s.name)).toEqual(['x.dcm']);
    expect(problems.damagedZips).toBe(1);
  });

  it('a damaged Office file is ignored without a warning, because it was never a scan', async () => {
    const { problems } = await toSources([asFile(zipSync({ a: strToU8('a') }).slice(0, 40), 'report.docx')]);
    expect(problems.damagedZips).toBe(0);
  });

  it('counts password-protected and Deflate64 entries instead of failing or hiding them', async () => {
    const zip = zipSync({ 'a.dcm': strToU8('a') });
    const locked = noProblems();
    expect(await listZip(asFile(patchCentral(zip, 8, 1), 'locked.zip'), locked)).toEqual([]);
    expect(locked.passwordEntries).toBe(1);
    const deflate64 = noProblems();
    expect(await listZip(asFile(patchCentral(zip, 10, 9), 'big.zip'), deflate64)).toEqual([]);
    expect(deflate64.unsupportedEntries).toBe(1);
  });

  it('opens a ZIP inside a ZIP, compressed or stored', async () => {
    for (const level of [0, 6] as const) {
      const inner = zipSync({ 'deep/a.dcm': strToU8('inner scan') }, { level });
      const { sources } = await toSources([asFile(zipSync({ 'case/inner.zip': inner, 'top.dcm': strToU8('top') }, { level }), 'outer.zip')]);
      expect(sources.map((s) => s.name).sort()).toEqual(['deep/a.dcm', 'top.dcm']);
      const deep = sources.find((s) => s.name === 'deep/a.dcm')!;
      expect(new TextDecoder().decode(await readSource(deep))).toBe('inner scan');
    }
  });

  it('stops following nested ZIPs after three levels', async () => {
    let zip = zipSync({ 'a.dcm': strToU8('a') });
    for (let i = 0; i < 4; i++) zip = zipSync({ 'n.zip': zip });
    const { sources, problems } = await toSources([asFile(zip, 'deep.zip')]);
    expect(sources).toEqual([]);
    expect(problems.skippedNested).toBe(1);
  });

  it('finds the ZIP inside a self-extracting program, and keeps plain programs out of the way', async () => {
    const zip = zipSync({ 'a.dcm': strToU8('inside') });
    const program = new Uint8Array(5000 + zip.length);
    program.set([0x4d, 0x5a]);
    program.set(zip, 5000);
    const sfx = await toSources([asFile(program, 'export.exe')]);
    const member = sfx.sources.find((s) => s.name === 'a.dcm')!;
    expect(new TextDecoder().decode(await readSource(member))).toBe('inside');

    const plain = new Uint8Array(5000);
    plain.set([0x4d, 0x5a]);
    const viewer = await toSources([asFile(plain, 'pdsv.exe')]);
    expect(viewer.sources.map((s) => s.name)).toEqual(['pdsv.exe']);
    expect(viewer.problems).toEqual(noProblems());
  });

  it('reads only the start of a file, loose or zipped', async () => {
    const big = new Uint8Array(HEAD_BYTES * 3).map((_, i) => (i * 7) % 251);
    const wanted = big.slice(0, HEAD_BYTES);
    const loose = await readHead({ file: asFile(big, 'x'), name: 'x' }, HEAD_BYTES);
    expect(loose).toEqual(wanted);
    for (const level of [0, 6] as const) {
      const [member] = await listZip(asFile(zipSync({ x: big }, { level }), 'x.zip'));
      expect(await readHead(member, HEAD_BYTES)).toEqual(wanted);
      expect(await readSource(member)).toEqual(big);
    }
    const [small] = await listZip(asFile(zipSync({ s: strToU8('short') }), 's.zip'));
    expect(new TextDecoder().decode(await readHead(small, HEAD_BYTES))).toBe('short');
  });

  it.each([
    ['bmp', [0x42, 0x4d, 1, 2, 3, 4, 5, 6]],
    ['jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 0]],
    ['program', [0x4d, 0x5a, 0x90, 0]],
    ['zip', [0x50, 0x4b, 3, 4]],
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 7]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ])('recognises %s from its content', (kind, bytes) => {
    expect(sniffKind(Uint8Array.from(bytes))).toBe(kind);
  });

  it('recognises a disc image and plain text', () => {
    const iso = new Uint8Array(40000);
    iso.set(strToU8('CD001'), 32769);
    expect(sniffKind(iso)).toBe('iso');
    expect(sniffKind(strToU8('READ ME: open the viewer\r\n'))).toBe('text');
  });
});
