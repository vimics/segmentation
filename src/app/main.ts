import { describeSeries, mainReason, mixedUploadWarning, pickBestSeries } from '../engine/dicom/series';
import { toSources, type Source } from '../engine/io/sources';
import { assembleVolume, scanSeries } from '../engine/load';
import { fetchDemo } from '../engine/demo';
import { SAMPLE_INFO } from '../engine/sample/bone';
import type { SeriesInfo, StructureMesh, SurfaceResult, Vec3 } from '../engine/types';
import { profileDensity, startingThreshold, thresholdPresets, type DensityProfile } from '../engine/surface/density';
import { Viewer, type MeasureKind, type Measurement } from '../engine/viewer/viewer';
import type { MeshRequest } from '../engine/workers/mesh.worker';
import { CaseStore, type StoreRequest, type StoreState } from './caseStore';
import { caseLine, formatStudyDate, speciesConflict, validateDetails, type CaseDetails, type RawDetails } from './details';
import { explainNoDicom, filesFromDrop, ingestWarnings } from './ingest';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (n: number) => n.toLocaleString('en-GB');
const DEFAULT_ISO = 250;
const LOGO = document.querySelector('.logo-link svg')?.outerHTML ?? '';

// ---- Start page -------------------------------------------------------------------------------

let chosenFiles: File[] = [];
let species = '';

function setFieldError(field: string, message?: string) {
  const box = document.querySelector<HTMLElement>(`[data-alan="${field}"]`);
  if (!box) return;
  box.classList.toggle('hatali', !!message);
  const el = box.querySelector<HTMLElement>('.alan-hata');
  if (el) { el.textContent = message ?? ''; el.hidden = !message; }
}

function readForm(): RawDetails {
  const v = (id: string) => $<HTMLInputElement>(id).value;
  return { name: v('f-name'), species, years: v('f-years'), months: v('f-months'), weight: v('f-weight'), breed: v('f-breed'), clinician: v('f-clinician') };
}

document.querySelectorAll<HTMLButtonElement>('[data-species]').forEach((b) => b.addEventListener('click', () => {
  species = b.dataset.species ?? '';
  document.querySelectorAll<HTMLButtonElement>('[data-species]').forEach((o) => {
    const on = o === b;
    o.setAttribute('aria-checked', String(on));
    o.setAttribute('aria-pressed', String(on));
  });
  setFieldError('species');
}));

const savedClinician = localStorage.getItem('bv-clinician');
if (savedClinician) $<HTMLInputElement>('f-clinician').value = savedClinician;

function setChosen(files: File[]) {
  chosenFiles = files;
  const label = $('secilen');
  label.hidden = !files.length;
  const zips = files.filter((f) => /\.zip$/i.test(f.name)).length;
  label.textContent = files.length === 1 ? files[0].name : `${num(files.length)} files selected${zips ? ` (${zips} ZIP)` : ''}`;
  if (files.length) setFieldError('files');
}

$('dosya-sec').addEventListener('click', () => $('dosya').click());
$('klasor-sec').addEventListener('click', () => $('klasor').click());
for (const id of ['dosya', 'klasor']) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => setChosen([...((e.target as HTMLInputElement).files ?? [])]));
}

const birak = $('birak');
window.addEventListener('dragover', (e) => { e.preventDefault(); if (state === 'start') birak.classList.add('uzerinde'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) birak.classList.remove('uzerinde'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  birak.classList.remove('uzerinde');
  if (state === 'start' && e.dataTransfer) setChosen(await filesFromDrop(e.dataTransfer));
});

$<HTMLFormElement>('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { details, errors } = validateDetails(readForm());
  for (const f of ['name', 'species', 'age', 'weight'] as const) setFieldError(f, errors[f]);
  const consent = $<HTMLInputElement>('f-consent').checked;
  setFieldError('consent', consent ? undefined : 'Please agree before continuing.');
  setFieldError('files', chosenFiles.length ? undefined : 'Choose a CT folder, files or a ZIP.');
  if (!details || !consent || !chosenFiles.length) {
    document.querySelector<HTMLElement>('.hatali input, .hatali button')?.focus();
    return;
  }
  if (details.clinician) localStorage.setItem('bv-clinician', details.clinician);
  else localStorage.removeItem('bv-clinician');
  void openCase(details, chosenFiles, new Date().toISOString());
});

$('f-consent').addEventListener('change', () => setFieldError('consent'));
for (const [input, field] of [['f-name', 'name'], ['f-years', 'age'], ['f-months', 'age'], ['f-weight', 'weight']]) {
  $(input).addEventListener('input', () => setFieldError(field));
}
$('ornek').addEventListener('click', () => void openSample());
document.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach((b) => b.addEventListener('click', () => void openDemo(b.dataset.demo as string, b.textContent ?? '')));

// ---- Screens ----------------------------------------------------------------------------------

type Screen = 'start' | 'loading' | 'viewer' | 'error';
let state: Screen = 'start';

function show(screen: Screen) {
  state = screen;
  const inWorkspace = screen !== 'start';
  $('baslangic').hidden = inWorkspace;
  $('calisma').hidden = !inWorkspace;
  $('perde-yukle').hidden = screen !== 'loading';
  $('perde-hata').hidden = screen !== 'error';
  $('yeni-vaka').hidden = !inWorkspace;
  document.querySelector('.ray')?.toggleAttribute('hidden', screen === 'error' || screen === 'loading');
  $('calisma').style.gridTemplateColumns = screen === 'viewer' ? '' : 'minmax(0, 1fr)';
  const inViewer = screen === 'viewer';
  $('vaka').hidden = !inViewer;
  const send = $('gonder');
  const realCase = inViewer && !current?.sample;
  send.className = `btn ${realCase ? 'btn-birincil' : 'btn-ikincil'}`;
  send.textContent = realCase ? 'Send this case to Vimics' : 'Send a case';
}

function showError(label: string, title: string, text: string) {
  $('hata-etiket').textContent = label;
  $('hata-baslik').textContent = title;
  $('hata-metin').textContent = text;
  show('error');
}

function setStep(active: number, counter?: string, overall?: number) {
  document.querySelectorAll('#adimlar li').forEach((li, i) => {
    li.className = i < active ? 'bitti' : i === active ? 'etkin' : '';
    if (i === active && counter !== undefined) (li.querySelector('.sayac') as HTMLElement).textContent = counter;
    if (i > active) (li.querySelector('.sayac') as HTMLElement).textContent = '';
  });
  if (overall !== undefined) $('yukle-cubuk').style.width = `${overall}%`;
}

// ---- Viewer -----------------------------------------------------------------------------------

let viewer: Viewer | null = null;
let meshWorker: Worker | null = null;
let current: { details: CaseDetails | null; acceptedAt: string; sources: Source[]; series: SeriesInfo[]; selected: SeriesInfo | null; sample: boolean; uploadWarnings: string[] } | null = null;
let iso = DEFAULT_ISO;
let seq = 0;
let latestSurface: Omit<SurfaceResult, 'structures'> & { structures: StructureMesh[] } | null = null;
let visibility: boolean[] = [];
let clipRangesSet = false;
/** Choices the vet made, remembered by position so they survive a threshold change. */
let overrides: Array<{ center: Vec3; visible: boolean }> = [];

function ensureViewer(): Viewer {
  if (viewer) return viewer;
  viewer = new Viewer({
    host: $('sahne'),
    canvas: $<HTMLCanvasElement>('tuval'),
    overlay: $('katman') as unknown as SVGSVGElement,
    labels: $('etiketler'),
    cube: $('kup'),
    scaleText: $('olcek-yazi'),
    scaleBar: $('olcek-cizgi'),
  }, {
    onMeasurementsChanged: renderMeasurements,
    onToolChanged: renderTool,
    onStructureClicked: showStructureAction,
    onCameraMoved: () => { $('aksiyon').hidden = true; },
  });
  return viewer;
}

function centerOf(s: { bboxMin: Vec3; bboxMax: Vec3 }): Vec3 {
  return [(s.bboxMin[0] + s.bboxMax[0]) / 2, (s.bboxMin[1] + s.bboxMax[1]) / 2, (s.bboxMin[2] + s.bboxMax[2]) / 2];
}

function resolveVisibility(s: StructureMesh): boolean {
  const o = overrides.find((c) => c.center.every((v, d) => v >= s.bboxMin[d] && v <= s.bboxMax[d]));
  return o ? o.visible : !s.autoHidden;
}

function renderStructures() {
  const ul = $('yapilar');
  ul.replaceChildren();
  if (!latestSurface) return;
  let n = 0;
  latestSurface.structures.forEach((s, i) => {
    const name = s.hiddenAs === 'table' ? 'Likely scanner table' : s.hiddenAs === 'fragment' ? 'Thin fragment' : `Structure ${++n}`;
    const li = document.createElement('li');
    li.className = visibility[i] ? '' : 'kapali';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = visibility[i];
    box.setAttribute('aria-label', `Show ${name}`);
    box.addEventListener('change', () => setStructure(i, box.checked));
    const label = document.createElement('span');
    label.textContent = name;
    const size = document.createElement('span');
    size.className = 'hacim';
    size.textContent = s.autoHidden && !visibility[i] ? 'auto-hidden' : `${(s.volumeMm3 / 1000).toFixed(1)} cm³`;
    li.append(box, label, size);
    li.addEventListener('mouseenter', () => viewer?.highlightStructure(i, true));
    li.addEventListener('mouseleave', () => viewer?.highlightStructure(i, false));
    ul.append(li);
  });
  const specks = latestSurface.specksRemoved;
  $('temizlik').textContent = specks ? `${num(specks)} specks removed` : '';
}

function setStructure(i: number, on: boolean) {
  if (!latestSurface) return;
  visibility[i] = on;
  overrides = overrides.filter((c) => !c.center.every((v, d) => v >= latestSurface!.structures[i].bboxMin[d] && v <= latestSurface!.structures[i].bboxMax[d]));
  overrides.push({ center: centerOf(latestSurface.structures[i]), visible: on });
  viewer?.setStructureVisible(i, on);
  renderStructures();
}

let selectedStructure: number | null = null;
function showStructureAction(index: number | null, x: number, y: number) {
  const box = $('aksiyon');
  selectedStructure = index;
  if (index === null || !latestSurface) { box.hidden = true; return; }
  const rows = $('yapilar').children[index];
  $('aksiyon-yazi').textContent = rows?.querySelector('span')?.textContent ?? 'Structure';
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  box.hidden = false;
}
$('aksiyon-gizle').addEventListener('click', () => {
  if (selectedStructure !== null) setStructure(selectedStructure, false);
  $('aksiyon').hidden = true;
  selectedStructure = null;
});

/** What the summary states for the generated sample or a demo case. */
let exampleInfo: { slices: number; cols: number; rows: number; spacing: number | string } = SAMPLE_INFO;

function renderSummary() {
  if (!latestSurface) return;
  const pieces: string[] = [];
  const item = (strong: string, rest = '') => pieces.push(`<b>${strong}</b>${rest}`);
  if (current?.sample) {
    item(num(exampleInfo.slices), ' slices');
    item(`${exampleInfo.cols} × ${exampleInfo.rows}`);
    pieces.push(`Slice <b>${exampleInfo.spacing} mm</b>`);
  } else if (current?.selected) {
    const s = current.selected;
    item(num(builtSlices), ' slices');
    item(`${s.cols} × ${s.rows}`);
    pieces.push(`Slice <b>${s.sliceSpacing.toFixed(1)} mm</b>`);
  }
  pieces.push(`Mesh <b>${latestSurface.resolutionMm.toFixed(1)} mm</b>`);
  pieces.push(`<b>${num(latestSurface.triangles)}</b> triangles`);
  $('ozet').innerHTML = pieces.join(' · ');
}

function applySurface(result: SurfaceResult) {
  const v = ensureViewer();
  latestSurface = result;
  visibility = result.structures.map(resolveVisibility);
  v.setSurface(result, visibility.map((on) => !on));
  renderStructures();
  renderSummary();
  const empty = result.structures.length === 0;
  const hint = $('ipucu');
  if (empty) { hint.textContent = 'No surface at this threshold. Lower it to see bone.'; hint.hidden = false; }
  else if (!viewer?.tool) hint.hidden = true;
}

function setupClipRanges() {
  if (clipRangesSet || !viewer) return;
  const box = viewer.bounds();
  if (box.isEmpty()) return;
  clipRangesSet = true;
  const axes = [[box.min.x, box.max.x], [box.min.y, box.max.y], [box.min.z, box.max.z]];
  document.querySelectorAll<HTMLInputElement>('#kesitler input[type=range]').forEach((r) => {
    const [lo, hi] = axes[+(r.dataset.eksen ?? 0)];
    r.min = String(Math.floor(lo));
    r.max = String(Math.ceil(hi));
    r.value = String((lo + hi) / 2);
    r.disabled = true;
    syncSlider(r);
  });
  document.querySelectorAll<HTMLInputElement>('#kesitler input[type=checkbox]').forEach((c) => {
    c.checked = false;
    viewer?.setClip(+(c.dataset.eksen ?? 0), false, 0);
  });
}

function syncSlider(el: HTMLInputElement) {
  el.style.setProperty('--dolu', `${((+el.value - +el.min) / (+el.max - +el.min)) * 100}%`);
}

function requestSurface(quality: 'preview' | 'full') {
  const msg: MeshRequest = { type: 'extract', seq: ++seq, iso, quality };
  meshWorker?.postMessage(msg);
}

function setPresets(start: number, profile: DensityProfile) {
  const values = thresholdPresets(start, profile);
  document.querySelectorAll<HTMLButtonElement>('#hazir button').forEach((b, i) => {
    b.dataset.hu = String(values[i]);
    b.querySelector('small')!.textContent = String(values[i]);
  });
}

function setIsoControls(value: number) {
  iso = Math.max(-200, Math.min(3000, Math.round(value)));
  const range = $<HTMLInputElement>('esik'), box = $<HTMLInputElement>('esik-sayi');
  range.value = String(iso);
  box.value = String(iso);
  syncSlider(range);
  document.querySelectorAll<HTMLButtonElement>('#hazir button').forEach((b) => b.setAttribute('aria-pressed', String(+(b.dataset.hu ?? 0) === iso)));
}

/** Show the fast preview straight away, then refine once it has arrived. */
let fullAfterPreview = false;
const onIsoSettled = () => { fullAfterPreview = true; $('iyilestir').hidden = false; requestSurface('preview'); };
$('esik').addEventListener('input', (e) => {
  fullAfterPreview = false;
  $('iyilestir').hidden = true;
  setIsoControls(+(e.target as HTMLInputElement).value);
  requestSurface('preview');
});
$('esik').addEventListener('change', onIsoSettled);
$('esik-sayi').addEventListener('change', (e) => { setIsoControls(+(e.target as HTMLInputElement).value); onIsoSettled(); });
document.querySelectorAll<HTMLButtonElement>('#hazir button').forEach((b) => b.addEventListener('click', () => { setIsoControls(+(b.dataset.hu ?? DEFAULT_ISO)); onIsoSettled(); }));

document.querySelectorAll<HTMLInputElement>('#kesitler input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {
  const axis = +(c.dataset.eksen ?? 0);
  const r = document.querySelector<HTMLInputElement>(`#kesitler input[type=range][data-eksen="${axis}"]`) as HTMLInputElement;
  r.disabled = !c.checked;
  viewer?.setClip(axis, c.checked, +r.value);
}));
document.querySelectorAll<HTMLInputElement>('#kesitler input[type=range]').forEach((r) => r.addEventListener('input', () => {
  syncSlider(r);
  viewer?.setClip(+(r.dataset.eksen ?? 0), true, +r.value);
}));

function renderTool(tool: MeasureKind | null) {
  document.querySelectorAll<HTMLButtonElement>('.arac').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.arac === tool)));
  $('aksiyon').hidden = true;
  const hint = $('ipucu');
  if (tool) {
    hint.textContent = tool === 'distance' ? 'Click two points on the bone. Esc to finish.' : 'Click three points; the middle one is the vertex. Esc to finish.';
    hint.hidden = false;
  } else hint.hidden = !(latestSurface && latestSurface.structures.length === 0);
}

function renderMeasurements(list: Measurement[]) {
  const ul = $('olculer');
  ul.replaceChildren();
  for (const m of list) {
    const li = document.createElement('li');
    const id = document.createElement('span');
    id.textContent = m.id;
    const value = document.createElement('b');
    value.textContent = m.value;
    const del = document.createElement('button');
    del.className = 'sil';
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete ${m.id}`);
    del.addEventListener('click', () => viewer?.removeMeasurement(m.id));
    li.append(id, value, del);
    ul.append(li);
  }
}

document.querySelectorAll<HTMLButtonElement>('.arac').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.arac as MeasureKind;
  viewer?.setTool(viewer.tool === kind ? null : kind);
}));
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  viewer?.setTool(null);
  $('aksiyon').hidden = true;
});
document.querySelectorAll<HTMLButtonElement>('#kup button').forEach((b) => b.addEventListener('click', () => viewer?.viewFrom(b.dataset.yuz ?? 'z')));
$('sigdir').addEventListener('click', () => viewer?.fit());

$('goruntu').addEventListener('click', async () => {
  if (!viewer) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const logo = LOGO.replaceAll('var(--logo-monogram)', dark ? '#FFFFFF' : '#26497F').replaceAll('var(--logo-kelime)', '#4CB088');
  const blob = await viewer.snapshot(dark ? '#244870' : '#F7F8FA', dark ? '#C9D2DD' : '#5A6675', logo);
  const a = document.createElement('a');
  a.download = 'vimics-v-seg.png';
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

$('tema').addEventListener('click', () => {
  const root = document.documentElement;
  if (root.dataset.theme === 'dark') delete root.dataset.theme;
  else root.dataset.theme = 'dark';
  viewer?.requestRender();
});

// ---- Case storage -----------------------------------------------------------------------------

let lastStoreRequest: StoreRequest | null = null;

function renderStore(s: StoreState) {
  const text = $('depo-metin'), bar = $('depo-cubuk'), fill = bar.querySelector('i') as HTMLElement, ref = $('depo-ref'), retry = $('depo-tekrar');
  bar.hidden = true;
  ref.hidden = true;
  retry.hidden = true;
  switch (s.kind) {
    case 'off':
      text.textContent = s.message;
      break;
    case 'preparing':
      text.textContent = `De-identifying the scan: ${num(s.done)} of ${num(s.total)} slices`;
      bar.hidden = false;
      fill.style.width = `${(s.done / Math.max(1, s.total)) * 100}%`;
      break;
    case 'uploading': {
      const mb = (b: number) => (b / 1024 / 1024).toFixed(0);
      text.textContent = `Storing: ${mb(s.sent)} of ${mb(s.total)} MB. You can keep working.`;
      bar.hidden = false;
      fill.style.width = `${(s.sent / Math.max(1, s.total)) * 100}%`;
      break;
    }
    case 'stored':
      text.textContent = 'Stored with Vimics. Quote this reference to ask for its deletion:';
      ref.textContent = s.caseId;
      ref.hidden = false;
      break;
    case 'failed':
      text.textContent = `Not stored. ${s.message}`;
      retry.hidden = !s.canRetry;
      break;
  }
}

const store = new CaseStore(renderStore);
$('depo-tekrar').addEventListener('click', () => { if (lastStoreRequest) store.retry(lastStoreRequest); });
window.addEventListener('beforeunload', (e) => { if (store.busy) e.preventDefault(); });

function storeCurrent() {
  if (!current || current.sample || !current.details || !current.selected) return;
  lastStoreRequest = {
    details: current.details,
    acceptedAt: current.acceptedAt,
    consentText: $('onay-metin').textContent?.replace(/\s*What is stored\s*$/, '').trim() ?? '',
    series: current.selected,
    sources: current.sources,
    thresholdHu: iso,
  };
  store.store(lastStoreRequest);
}

// ---- Loading a case ---------------------------------------------------------------------------

function resetForNewModel(keepThreshold = false) {
  meshWorker?.terminate();
  meshWorker = null;
  latestSurface = null;
  visibility = [];
  overrides = [];
  fullAfterPreview = false;
  clipRangesSet = false;
  $('iyilestir').hidden = true;
  $('ipucu').hidden = true;
  $('aksiyon').hidden = true;
  $('uyarilar').replaceChildren();
  viewer?.setTool(null);
  viewer?.clearMeasurements();
  if (!keepThreshold) setIsoControls(DEFAULT_ISO);
}

function startMesh(request: MeshRequest, transfer: Transferable[], frame: { rowDir: Vec3; colDir: Vec3 }) {
  const worker = new Worker(new URL('../engine/workers/mesh.worker.ts', import.meta.url), { type: 'module' });
  meshWorker = worker;
  let first = true;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'loaded') {
      setStep(2, 'Preview', 90);
      fullAfterPreview = true;
      requestSurface('preview');
      return;
    }
    if (m.type === 'error') {
      showError('Something went wrong', 'The model could not be built', m.message);
      return;
    }
    if (m.seq !== seq) return; // the slider has moved on
    const result = m.result as SurfaceResult;
    applySurface(result);
    if (first) {
      first = false;
      show('viewer');
      ensureViewer().setScanFrame(frame.rowDir, frame.colDir);
      ensureViewer().fit(false);
      setupClipRanges();
      storeCurrent();
    }
    if (result.quality === 'full') {
      $('iyilestir').hidden = true;
    } else if (fullAfterPreview) {
      fullAfterPreview = false;
      $('iyilestir').hidden = false;
      requestSurface('full');
    }
  };
  worker.onerror = (e) => showError('Something went wrong', 'The model could not be built', e.message || 'A background worker failed.');
  worker.postMessage(request, transfer);
}

const CONE_BEAM_NOTE = 'Density values in this scan are not on the usual CT scale, which is common on cone-beam scanners. The starting threshold was chosen from the scan itself, so adjust it if bone looks incomplete.';

/** Can be fewer than the series lists, when unreadable slices were left out. */
let builtSlices = 0;

async function buildSeries(selected: SeriesInfo, keepThreshold = false) {
  if (!current) return;
  current.selected = selected;
  resetForNewModel(keepThreshold);
  const usableCount = current.series.filter((s) => s.usable).length;
  $('seri-bilgi').textContent = usableCount < 2 ? [describeSeries(selected, current.series), selected.description].filter(Boolean).join(' · ') : selected.description;
  show('loading');
  setStep(1, `0 / ${num(selected.slices.length)}`, 30);
  try {
    const { volume, step, failedSlices } = await assembleVolume(selected, current.sources, (done, total) => {
      setStep(1, `${num(done)} / ${num(total)}`, 30 + (done / total) * 55);
    });
    builtSlices = volume.nz;
    const profile = profileDensity(volume);
    const start = startingThreshold(profile, selected.filter);
    setPresets(start, profile);
    if (!keepThreshold) setIsoControls(start);
    const warnings = [...current.uploadWarnings, ...selected.warnings];
    if (failedSlices) warnings.push(`${failedSlices} ${failedSlices === 1 ? 'slice' : 'slices'} could not be read and ${failedSlices === 1 ? 'was' : 'were'} left out.`);
    if (profile.offsetScale) warnings.push(CONE_BEAM_NOTE);
    if (step > 1) warnings.push('This scan is very large, so it was reduced to half resolution to fit in memory.');
    const dicomSpecies = selected.slices[0].species;
    if (current.details && speciesConflict(current.details.species, dicomSpecies)) warnings.push(`The file lists the species as "${dicomSpecies}", which differs from what you entered.`);
    const box = $('uyarilar');
    for (const w of warnings) {
      const p = document.createElement('p');
      p.className = 'uyari';
      p.textContent = w;
      box.append(p);
    }
    if (current.details) {
      $('vaka-rozet').hidden = true;
      const line = caseLine(current.details, formatStudyDate(selected.slices[0].studyDate));
      $('vaka-satir').textContent = line;
      $('vaka-satir').title = line;
    }
    setStep(2, undefined, 85);
    startMesh({ type: 'load', volume }, [volume.data.buffer as ArrayBuffer], { rowDir: selected.rowDir, colDir: selected.colDir });
  } catch (err) {
    showError('Something went wrong', 'This series could not be read', err instanceof Error ? err.message : String(err));
  }
}

async function openCase(details: CaseDetails, files: File[], acceptedAt: string) {
  show('loading');
  setStep(0, '', 2);
  try {
    const { sources, problems } = await toSources(files);
    const { series, dicomFiles, kinds } = await scanSeries(sources, (done, total) => {
      setStep(0, `${num(done)} / ${num(total)}`, (done / total) * 30);
    });
    if (!dicomFiles) {
      showError('No DICOM found', 'No DICOM images in these files', explainNoDicom(kinds, problems));
      return;
    }
    const best = pickBestSeries(series);
    if (!best) {
      const reason = mainReason(series);
      const m = /This series is (\w+), not CT/.exec(reason);
      if (m) showError('Series not supported', `This scan is ${/^[AEIOUMNR]/.test(m[1]) ? 'an' : 'a'} ${m[1]}, not a CT`, 'Bone surfaces are built from CT density values. Export a CT series and try again.');
      else showError('Series not supported', 'This series cannot be used', reason);
      return;
    }
    const uploadWarnings = ingestWarnings(problems);
    const mixed = mixedUploadWarning(series);
    if (mixed) uploadWarnings.unshift(mixed);
    current = { details, acceptedAt, sources, series, selected: best, sample: false, uploadWarnings };
    const select = $<HTMLSelectElement>('seri');
    select.replaceChildren();
    // Scouts and dose reports never appear. The default comes first, then the rest by size.
    const choices = series.filter((s) => s.usable).sort((a, b) => Number(b === best) - Number(a === best) || b.slices.length - a.slices.length);
    for (const s of choices) select.add(new Option(describeSeries(s, series), String(series.indexOf(s)), false, s === best));
    select.hidden = choices.length < 2;
    $('depo').hidden = false;
    renderStore({ kind: 'off', message: 'Waiting for the model.' });
    await buildSeries(best);
  } catch (err) {
    showError('Something went wrong', 'These files could not be read', err instanceof Error ? err.message : String(err));
  }
}

$<HTMLSelectElement>('seri').addEventListener('change', (e) => {
  const s = current?.series[+(e.target as HTMLSelectElement).value];
  if (s) void buildSeries(s, true);
});

function showExampleChrome(badge: string, line: string, seriesLine: string) {
  $<HTMLSelectElement>('seri').hidden = true;
  $('seri-bilgi').textContent = seriesLine;
  $('depo').hidden = true;
  $('vaka-rozet').textContent = badge;
  $('vaka-rozet').hidden = false;
  $('vaka-satir').textContent = line;
  $('vaka-satir').title = '';
}

/** Opens a stored demo case: real anatomy with no patient details, no form and nothing sent anywhere. */
async function openDemo(file: string, label: string) {
  const mine = { details: null, acceptedAt: '', sources: [], series: [], selected: null, sample: true, uploadWarnings: [] };
  current = mine;
  resetForNewModel();
  show('loading');
  setStep(0, 'Downloading', 2);
  try {
    const { header, volume } = await fetchDemo(`demo/${file}.vseg`, (share) => setStep(0, `${Math.round(share * 100)}%`, share * 70));
    if (current !== mine) return;
    exampleInfo = { slices: header.nz, cols: header.nx, rows: header.ny, spacing: header.spacingMm.toFixed(1) };
    const profile = profileDensity(volume);
    const start = startingThreshold(profile, header.filter);
    setPresets(start, profile);
    setIsoControls(start);
    showExampleChrome('Demo', `${label} · Real CT · Patient details removed`, `Demo case · ${header.species}`);
    if (profile.offsetScale) {
      const p = document.createElement('p');
      p.className = 'uyari';
      p.textContent = CONE_BEAM_NOTE;
      $('uyarilar').append(p);
    }
    setStep(2, undefined, 85);
    startMesh({ type: 'load', volume }, [volume.data.buffer as ArrayBuffer], { rowDir: volume.rowDir, colDir: volume.colDir });
  } catch (err) {
    showError('Something went wrong', 'This demo case could not be opened', err instanceof Error ? err.message : String(err));
  }
}

async function openSample() {
  current = { details: null, acceptedAt: '', sources: [], series: [], selected: null, sample: true, uploadWarnings: [] };
  resetForNewModel();
  show('loading');
  setStep(2, 'Generating', 70);
  exampleInfo = SAMPLE_INFO;
  setPresets(DEFAULT_ISO, { tissuePeak: 0, offsetScale: false });
  showExampleChrome('Sample', 'Generated vertebrae · Not a real patient', 'Generated sample · 0.6 mm');
  startMesh({ type: 'sample' }, [], { rowDir: [1, 0, 0], colDir: [0, -1, 0] });
}

function backToStart() {
  meshWorker?.terminate();
  meshWorker = null;
  current = null;
  setChosen([]);
  $<HTMLFormElement>('form').reset();
  const clinician = localStorage.getItem('bv-clinician');
  if (clinician) $<HTMLInputElement>('f-clinician').value = clinician;
  species = '';
  document.querySelectorAll('[data-species]').forEach((o) => { o.setAttribute('aria-checked', 'false'); o.setAttribute('aria-pressed', 'false'); });
  show('start');
}
$('yeni-vaka').addEventListener('click', backToStart);
$('yeniden').addEventListener('click', backToStart);

show('start');
setIsoControls(DEFAULT_ISO);

if (!document.createElement('canvas').getContext('webgl2')) {
  showError('Graphics not available', 'This browser cannot show 3D graphics', 'Use a current version of Chrome, Edge, Safari or Firefox with hardware acceleration turned on.');
}
