# What real cases taught us

Four veterinary CT cases, run exactly as received on 2026-10-31. Labels only: the scans stay in `test-data/`, which git ignores. Cases are described by form, with no patient, owner or clinic details.

## The forms cases arrive in

| Case | As received | Series | Main series | Scanner type |
|---|---|---|---|---|
| Cat 1 | 218 MB folder, 1,056 files: viewer CD with 2 programs, 56 BMP icons, autorun and help files, a DICOMDIR, and DICOM files with no extension | 10 usable | 289 slices, JPEG Lossless, marked `DERIVED\SECONDARY` | Hitachi CT |
| Cat 2 | 171 MB single ZIP, 941 files | 1 | 941 slices, JPEG Lossless, no description or filter name | Cone-beam |
| Dog 1 | 2.8 GB folder, 2,697 `.dcm` files | 7 usable, 6 scouts | 766 slices, uncompressed, `ORIGINAL` | Siemens CT |
| Dog 2 | 1.6 GB folder, 1,130 `.dcm` and 1,130 `.bmp` copies | 3 usable, 3 scouts | 708 slices, uncompressed, marked as a reformat, with no original in the upload | Siemens CT |

## What this changed

| Assumption | What the cases showed | Decision |
|---|---|---|
| `DERIVED` images are secondary | The main series is `DERIVED` in 3 of 4 cases | Only reformat markers such as `MPR` count against a series, and a reformat is accepted when nothing else exists |
| A description or image type states the plane | "SAG" means *right* in Turkish on an axial series, and Siemens marks sagittal reformats `AXIAL` | The plane comes from the slice orientation |
| A change of acquisition number means a new volume | One 289-slice volume carries 4 acquisition numbers | Split a series only when positions repeat |
| The smaller series has lower resolution | Reformats often have smaller pixels (0.18 to 0.24 mm against 0.48 mm), interpolated from the same 0.6 mm data | Most files stays the default, and the smaller series stay selectable |
| 250 HU is a good start everywhere | Sharp filters overshoot, and the cone-beam scan has soft tissue near 1,100 instead of 50 | The start depends on the filter and on the scan's own tissue peak |
| The table is one long shell | At higher thresholds it breaks up, and tubing looks similar | Shells under 0.5 mm mean thickness are auto-hidden, and stay in the list |

## Series chosen

| Case | Chosen | Why |
|---|---|---|
| Cat 1 | Filter 42, description ending BONE, 289 slices | Ties on slices, and the bone series wins |
| Cat 2 | The only series | |
| Dog 1 | I80s, 766 slices | Reconstruction beats the 732-slice reformats |
| Dog 2 | B70f axial, 708 slices | Sagittal and coronal reformats cover far less |

## The filter changes the model

The same threshold on the same anatomy, Cat 1:

| Threshold | Filter | Triangles | Specks removed | Shown bone |
|---|---|---|---|---|
| 250 HU | Soft (31) | 907,352 | 39 | 89.3 cm³ |
| 250 HU | Bone (42) | 2,466,072 | 36,924 | 76.3 cm³ |
| 500 HU | Soft (31) | 784,012 | 55 | 54.8 cm³ |
| 500 HU | Bone (42) | 1,139,340 | 1,547 | 55.3 cm³ |

## Starting thresholds

| Scan | Start | Evidence |
|---|---|---|
| Sharp bone filter | 500 HU | 3 cases, cleaner than 250 with thin bone kept |
| Any other filter | 250 HU | 1 case compared by numbers, not by eye. Not tested as a default on a full case |
| Offset scale (cone-beam) | Tissue peak + 900 | **1 case only.** Treat this rule as provisional |

## Timing and memory

Measured on this Mac in a real browser with software graphics, from pressing Build to the first model. Upload time is packaging only, because SharePoint was simulated.

| Case | First model | Stored | Peak browser memory | ZIP sent |
|---|---|---|---|---|
| Cat 1 | 3.3 s | | | |
| Cat 2 | 6.5 s | | | |
| Dog 1 | 3.1 s | 23 s | 1.9 GB | 193 MB |
| Dog 2 | 3.8 s | 31 s | 2.3 GB | 304 MB |

## De-identification on the real files

`tools/verify-private.run.ts` cleaned all 2,704 chosen slices. No private tags, no original UIDs, and no words from a case's own name fields remained. Numeric fields are checked only for words with letters, since digits collide by chance there.

## Not proven

- The real SharePoint connection, and direct browser upload to it
- Clinic laptops: 2 GB of memory may be tight on an 8 GB machine
- A closed tab loses the upload, because retries only cover network failures
- A corrupt slice is dropped from the model but still goes to packaging, which could fail the upload. To fix when SharePoint is connected
- Series choice and measurements have not yet been confirmed by a clinician or against Mimics

## Tools

```sh
npx vitest run --config tools/vitest.config.ts tools/inspect-case.run.ts     # OUT=path writes the report
npx vitest run --config tools/vitest.config.ts tools/verify-private.run.ts --disable-console-intercept
STEP=dog2:2 npx vitest run --config tools/vitest.config.ts tools/make-demo.run.ts --disable-console-intercept
REAL_OUT=/some/folder/outside/the/repo npx playwright test e2e/real.spec.ts --workers=1
```
