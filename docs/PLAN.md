# V-Seg Engine: plan

## Purpose

A free web tool: a vet enters patient details, drops a CT series, and gets a 3D bone model they can rotate, clip and measure. It raises Vimics' visibility with vets and leads into the case flow at `vimics.vet/dicom`. With the vet's consent, a de-identified copy of each scan is stored in Vimics SharePoint to train a bone segmentation and labelling network.

## Decisions

| Topic | Decision |
|---|---|
| Consent | Required checkbox on the start page. The viewer does not open without it. Legal review (KVKK, GDPR) is needed before public launch |
| Stored data | De-identified in the browser using an allow-list of DICOM fields, plus the form details and consent record. Original files never leave the computer |
| Processing | The 3D model is built in the browser. Upload runs in the background and never blocks the viewer |
| Hosting | Public GitHub repo with GitHub Pages for testing, then `vimics.vet/viewer/` |
| Upload service | Cloudflare Worker holds the SharePoint credentials and issues one-time upload links. Vets never sign in |
| Output | No STL or mesh export. PNG snapshot with no patient details |
| Engine | Online3DViewer is a design reference, not a dependency. three.js, on-demand rendering, plain DOM and TypeScript |
| Language | English, with all strings in one file |

## Start page

Required: patient name, cat or dog, age, weight (kg), consent.
Optional: breed, clinician name (shown as `Name Surname, DVM`).

Viewer header order: `Patient Name · Cat or Dog · Breed · Age · Weight kg · Name Surname, DVM · Date`. Optional items are left out when empty. The date is the study date from the DICOM file, or today if the file has none.

## Interface wording

- Top strip: "V-Seg Engine v1.0"
- Sidebar, above all controls: "A neural network bone segmentation engine is in training at Vimics HQ, will be available at vimics.vet/segmentation, at no charge."
- Footer: "Not suitable for surgical planning or 3D printing, which require human inspection with validated medical software. © 2026 Vimics"

## Pipeline

1. **Ingest:** folder, loose files or ZIP. DICOM is detected from content, not the file extension.
2. **Parse and group:** split by series, position and matrix. Exclude localisers and non-CT. Auto-select the best series, with a picker.
3. **Decode:** uncompressed (implicit, explicit, big endian, deflated), RLE, JPEG Lossless, JPEG-LS and JPEG 2000. Rescale to Hounsfield units.
4. **Build the volume:** sort slices along the slice normal. Vertices use each slice's own position, so uneven spacing and gantry tilt stay correct in true millimetres. No resampling.
5. **Extract the surface:** marching cubes. Half-resolution preview first, then full. A triangle budget chooses the level, and the footer states the mesh resolution.
6. **Clean up:** connected components on the mesh. Drop specks, attach internal cavities to their parent, and auto-hide table-like shells. Click to hide as the reliable fallback.
7. **Render:** orthographic camera, so the scale bar is true at any depth. Ivory material with occlusion baked into vertices from the volume.
8. **Pick:** GPU position buffer, the same cost at any triangle count and correct under clipping.

## Upload path

1. The viewer opens as soon as the model is ready. Upload starts in the background.
2. A worker rewrites each slice using the allow-list, replaces UIDs with salted hashes, and zips them.
3. The browser sends the case details and ZIP size to the Worker. The Worker validates them, stores `case.json`, and returns a one-time SharePoint upload link.
4. The browser uploads 5 MiB chunks with retry and resume. If SharePoint refuses direct browser requests, it relays chunks through the Worker.
5. The sidebar shows real progress and a case reference, which a vet can quote to request deletion.

Storage layout: `BoneViewer/YYYY/MM/<caseId>/case.json` and `series.zip`.

Abuse controls on the public endpoint: origin allow-list, size cap, per-address rate limit, optional bot check and optional access code during testing. The Microsoft app is limited to one dedicated SharePoint site.

## Clinical accuracy rules

- Bone preset starts at about 250 HU and is tuned on real cases. The slider is always available.
- The cube and clip controls use plain X, Y and Z axes, so the screen makes no left or right claim. Handedness has its own test.
- Series with irregular spacing, missing slices or thick slices show a warning. Missing position data stops the load with a clear message.
- Series flagged as having burned-in annotations are not uploaded.

## Verification

- Geometry phantoms: known shapes with unequal spacing, reversed order, tilt and shuffled files.
- Decoders: public sample files compared against reference pixels.
- De-identification: planted owner and clinic strings must not appear anywhere in the output, and pixels must be unchanged.
- Worker: tests against a simulated Microsoft Graph.
- End to end in a browser: fill the form, load a CT, see a mesh, measure, snapshot, and confirm the uploaded ZIP is clean.
- Real cases: run on supplied veterinary series for thresholds, table removal, timing and orientation.

## Out of v1

2D slice viewing, STL export, accounts, sharing links, enhanced multi-frame CT and JPEG baseline (lossy) CT.
