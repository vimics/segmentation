import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { isZip, listZip, readSource, toSources } from '../src/engine/io/sources';

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
    const list = await toSources([new File([strToU8('loose')], 'x.dcm'), zipFile({ 'y.dcm': strToU8('zipped') }), new File([strToU8('n')], '.DS_Store')]);
    expect(list.map((s) => s.name)).toEqual(['x.dcm', 'y.dcm']);
  });

  it('reports a damaged ZIP in plain words', async () => {
    const whole = zipSync({ 'a.dcm': strToU8('a') });
    const truncated = new File([whole.slice(0, whole.length - 30) as Uint8Array<ArrayBuffer>], 'bad.zip');
    await expect(listZip(truncated)).rejects.toThrow(/damaged or incomplete/);
  });
});
