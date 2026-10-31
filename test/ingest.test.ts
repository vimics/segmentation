import { describe, expect, it } from 'vitest';
import { explainNoDicom, ingestWarnings } from '../src/app/ingest';
import { noProblems } from '../src/engine/io/sources';

describe('explaining an upload with no CT in it', () => {
  it('says what was found when only pictures arrive', () => {
    const text = explainNoDicom({ bmp: 240, program: 1, text: 2 }, noProblems());
    expect(text).toMatch(/240 pictures and 1 program/);
    expect(text).toMatch(/no density data/);
  });

  it('tells the vet to unpack archives a browser cannot open', () => {
    expect(explainNoDicom({ rar: 1 }, noProblems())).toMatch(/RAR archive.*Unpack/);
    expect(explainNoDicom({ '7z': 1 }, noProblems())).toMatch(/7z archive/);
    expect(explainNoDicom({ iso: 1 }, noProblems())).toMatch(/disc image/);
  });

  it('names ZIP problems before anything else', () => {
    expect(explainNoDicom({}, { ...noProblems(), passwordEntries: 3 })).toMatch(/password/);
    expect(explainNoDicom({}, { ...noProblems(), unsupportedEntries: 3 })).toMatch(/Unzip it/);
    expect(explainNoDicom({}, { ...noProblems(), damagedZips: 1 })).toMatch(/damaged/);
  });

  it('separates a DICOM index with no images from no DICOM at all', () => {
    expect(explainNoDicom({ dicom: 1 }, noProblems())).toMatch(/none of them contain images/);
    expect(explainNoDicom({ other: 1 }, noProblems())).toMatch(/^Export the CT/);
  });

  it('warns only about real losses when a model can still be built', () => {
    expect(ingestWarnings(noProblems())).toEqual([]);
    expect(ingestWarnings({ ...noProblems(), damagedZips: 1 })[0]).toMatch(/1 ZIP file inside this upload/);
    expect(ingestWarnings({ ...noProblems(), passwordEntries: 2 })[0]).toMatch(/2 files in a ZIP/);
  });
});
