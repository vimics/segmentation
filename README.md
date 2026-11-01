# V-Seg Engine (Vimics)

A browser tool for veterinary CT. A vet enters patient details and drops a DICOM series, and gets a 3D bone model they can rotate, clip and measure. With the vet's consent, a de-identified copy of the scan is stored in Vimics SharePoint to train a bone segmentation network.

Not suitable for surgical planning or 3D printing.

## Run it

```sh
npm install
npm run dev        # local development
npm test           # unit tests
npm run test:e2e   # browser tests against a production build (first: npx playwright install chromium)
npm run build      # production build in dist/
```

Put real test scans in `test-data/`. That folder is ignored by git and must stay out of the repository.

## How it is organised

| Path | What it does |
|---|---|
| `src/engine/dicom` | Parsing, series assembly, decoding to Hounsfield units, de-identification |
| `src/engine/io` | Reading loose files and ZIPs, including ZIP64, without unpacking them into memory |
| `src/engine/surface` | Marching cubes, resolution levels, connected structures, table detection |
| `src/engine/viewer` | three.js viewer: on-demand rendering, clipping with solid caps, GPU picking, measuring |
| `src/engine/workers` | Background workers for slices, meshes and packaging the upload |
| `src/app` | Start form, screens, upload client |
| `worker` | Cloudflare Worker that holds the SharePoint credentials |
| `tools` | Local checks and demo builds that run against `test-data/` |
| `public/demo` | Demo cases: voxels and geometry only, built by `tools/make-demo.run.ts` |
| `docs/PLAN.md` | Product decisions |
| `docs/GO-LIVE.md` | Putting it on vimics.vet and connecting SharePoint |
| `docs/REAL-CASES.md` | What real cases taught us |
| `docs/SETUP-UPLOAD.md` | Connecting SharePoint |

## Things that must stay true

- **De-identification is an allow-list.** `KEEP` in `src/engine/dicom/deidentify.ts` lists what survives, and everything else is dropped. Never add a free-text field to it.
- **No secrets in this repository.** It is public. SharePoint credentials exist only as Cloudflare secrets.
- **Geometry is true millimetres in patient space.** Vertices use each slice's recorded position, and nothing is resampled. The phantom tests in `test/surface.test.ts` check this.
- **The threshold is the vet's.** Every scan is capped to −1024 to 4000 HU and opens at 300 to 1900 HU. Nothing is normalized or chosen per scan.
- **Real scans never enter the repository.** Only files built by `tools/make-demo.run.ts` do. Findings are written by case label, with no names.
- **The page discloses storage.** The start page, consent checkbox and `privacy.html` must match what the code sends.

## Credits

Viewer design is informed by [Online3DViewer](https://github.com/kovacsv/Online3DViewer) (MIT): engine and UI separation, on-demand rendering and fit-to-view. No code from it is included. Test files in `test/fixtures` come from [pydicom](https://github.com/pydicom/pydicom) (MIT). The marching cubes tables come from [three.js](https://github.com/mrdoob/three.js) (MIT).
