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
| A description or image type states the plane | "SAG" means *right* in Turkish on an axial series, and Siemens marks sagittal reformats `AXIAL` | Plane comes from the slice orientation |
| A change of acquisition number means a new volume | One 289-slice volume carries 4 acquisition numbers | Split a series only when positions repeat |
| The smaller series has lower resolution | Reformats often have smaller pixels (0.18 to 0.24 mm against 0.48 mm), though their source isn't recorded | The most slices always opens, and there is no choice of series |
| One range fits every scan's bone | Sharp filters overshoot, and the cone-beam scan has soft tissue near 1,120 | Every scan opens at 226 to 1988 HU, and the vet moves both ends |
| The table is one long shell | At higher thresholds it breaks up, and tubing looks similar | Pieces under 0.5 mm mean thickness join the table under the Thin fragments filter |

## Series chosen

| Case | Chosen | Why |
|---|---|---|
| Cat 1 | Filter 42, description ending BONE, 289 slices | Ties on slices, and the bone series wins |
| Cat 2 | The only series | |
| Dog 1 | I80s, 766 slices | Most slices |
| Dog 2 | B70f axial, 708 slices | Most slices |

## The filter changes the model

The same threshold on the same anatomy, Cat 1:

| Threshold | Filter | Triangles | Specks removed | Shown bone |
|---|---|---|---|---|
| 250 HU | Soft (31) | 907,352 | 39 | 89.3 cm³ |
| 250 HU | Bone (42) | 2,466,072 | 36,924 | 76.3 cm³ |
| 500 HU | Soft (31) | 784,012 | 55 | 54.8 cm³ |
| 500 HU | Bone (42) | 1,139,340 | 1,547 | 55.3 cm³ |

## Threshold selector

Every scan is capped to −1024 to 4000 HU when decoded, and opens at 226 to 1988 HU. Nothing is adjusted per scan: no presets, no normalization and no choice based on the filter. An earlier version did all three, tuned by judging renders, which cannot happen on a vet's computer.

Both ends move. A surface forms at the lower limit against thinner tissue and at the upper limit against denser material.

What the default gives on these cases:

| Case | At 226 to 1988 HU | What the vet does |
|---|---|---|
| Dog 1 | Clean bones, table hidden | Nothing |
| Dog 2 | Clean bones | Nothing, or raise the lower limit to clear specks |
| Cat 1 | Bones plus thin shells over the body, from a sharp filter | Raise the lower limit to about 500 |
| Cat 2 | Whole body and table, with bone hidden inside | Raise the upper limit first, then set the lower limit: 2000 to 4000 shows the skeleton |

Measured densities, every voxel of the series each case opens with:

| | Cat 1 | Cat 2 | Dog 1 | Dog 2 |
|---|---|---|---|---|
| Lowest in file | −2000 (fill) | −1024 | −1024 | −1024 |
| Highest in file | 4000 | 3071 | 3071 | 3071 |
| Air peak | −985 | −845 | −1005 | about −1015 |
| Soft tissue peak | 50 | 1120 | 40 | 40 |

Cat 2's scale is stretched as well as shifted: its air to tissue span is 1965, against about 1045 on the others. Its bone also reaches the 12-bit ceiling of 3071.

## Filters

Two filters sit under the threshold, both on by default. Small shells are pieces under 8 mm³, about a 2 mm cube. Thin fragments are pieces under 0.5 mm mean thickness, plus the table. Their rules are fixed numbers run on each piece, with no judgement at runtime. The 0.5 mm limit was tuned on these four cases and has not been checked against Mimics.

Small shells are built only when the vet turns that filter off, so the default costs nothing extra. They then share one mesh, so one draw call however many there are. They get 2M triangles of room above the 6M budget: without it, Dog 2 coarsened from 0.4 to 0.8 mm as a whole when shells were turned on.

Triangles at 226 to 1988 HU:

| Case | Small shells | Thin fragments | Both filters on | Shells off | Both off |
|---|---|---|---|---|---|
| Cat 1 | 51,962 | 43 | 1.94M | 3.05M | 4.09M |
| Cat 2 | 1,390 | 15 | 2.38M | 2.44M | 2.49M |
| Dog 1 | 1,969 | 11 | 1.35M | 1.44M | 5.27M |
| Dog 2 | 41,221 | 34 | 5.02M | 5.69M | 6.09M |

The rebuild took about 1 to 2.5 s. With both filters off and the lower limit at −400 HU, the largest result was 6.2M triangles and browser memory stayed under 3 GB.

## Timing and memory

Measured on this Mac in a real browser with software graphics, from pressing Build to the first model. Upload time is packaging only, because SharePoint was simulated.

| Case | First model | Stored | Peak browser memory | ZIP sent |
|---|---|---|---|---|
| Cat 1 | 3.6 s | | | |
| Cat 2 | 5.8 s | | | |
| Dog 1 | 3.2 s | 23 s | 2.1 GB | 193 MB |
| Dog 2 | 3.7 s | 30 s | 2.3 GB | 304 MB |

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
