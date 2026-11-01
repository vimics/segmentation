# V-Seg Engine

A free browser tool from Vimics. A vet enters patient details and drops a CT as received. The browser builds a 3D bone model they can rotate, section and measure. With consent, a de-identified copy goes to Vimics SharePoint to train a bone segmentation network. Not for surgical planning or 3D printing.

Stack: TypeScript, Vite, three.js, plain DOM, Web Workers. Cloudflare Worker for uploads. No backend otherwise.

## Commands

```sh
npm test                 # unit tests, also run by CI on every push
npm run test:e2e         # browser tests, local only
npm run build            # type check and production build
```

Real-case checks need `REAL_OUT` set to a folder outside the repo. See the end of `docs/REAL-CASES.md`.

## Where things are

| Path | What |
|---|---|
| `src/engine/dicom` | Parsing, series grouping and choice, decoding, de-identification |
| `src/engine/io` | Folders, ZIPs and file type detection |
| `src/engine/surface` | Marching cubes, layers, filters |
| `src/engine/viewer` | three.js viewer, rotation, sections, measuring |
| `src/app` | Form, sidebar, upload client |
| `worker` | Cloudflare Worker holding the SharePoint credentials |
| `tools` | Local scripts that run on `test-data/` |
| `docs/GO-LIVE.md` | Steps to put this on vimics.vet and connect SharePoint |
| `docs/REAL-CASES.md` | What real cases taught us |

## Rules

**Nobody is there to reason at runtime.** Every decision must be a fixed rule on data in the file, and must degrade safely on names and vendors never seen before. Don't tune behaviour by judging renders.

These are decided. Don't change them without being asked:

- **Series:** always the most slices. A tie prefers a reconstruction, then a bone filter, then no contrast, then the first read. The vet gets no choice of series.
- **Threshold:** every scan is capped to −1024 to 4000 HU and opens at 300 to 1900 HU. Both ends move. No presets, no normalization, nothing chosen per scan.
- **Filters:** Small shells (under 8 mm³) and Thin fragments (under 0.5 mm mean thickness, table included), both on by default. Small shells are built only when that filter is turned off.
- **Axes:** X, Y and Z only. The screen makes no left or right claim.

## Privacy and data

- `test-data/` holds real scans with owner and clinic names. It is git-ignored and must stay out of the repo.
- Keep names out of tool output and chat too. Use the `tools/` scripts, which print structure only. Don't open readmes or raw slices from real cases, and don't repeat names from screenshots.
- The repo is public. No secrets, ever. SharePoint credentials exist only as Cloudflare secrets.
- De-identification is an allow-list: `KEEP` in `src/engine/dicom/deidentify.ts`. Never add a free-text field.
- `public/demo` holds only voxels and geometry, built by `tools/make-demo.run.ts`. Rebuilding adds to Git history permanently, so do it only when the content must change.
- The consent wording, `privacy.html` and what the code sends must always match.
- Run `tools/check-commit.run.ts` before pushing anything built from real cases.

## Working here

- `main` deploys to GitHub Pages on every push, after unit tests pass.
- After pushing, wait for that exact commit's deploy, then check the live page.
- Keep paths relative. The site runs from a subfolder.
- Not yet proven: the real SharePoint connection, clinic laptops, legal review. Don't describe these as done.
