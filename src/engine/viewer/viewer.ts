import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import type { StructureMesh, SurfaceResult, Vec3 } from '../types';
import { faceOn, poseOf, rolledUp, squaredUp, upFacing } from './orientation';

const WEB_ICON = 'M8 1a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M1 8h14 M8 1c2.2 2 3.2 4.4 3.2 7s-1 5-3.2 7 M8 1c-2.2 2-3.2 4.4-3.2 7s1 5 3.2 7';
const INSTAGRAM_ICON = 'M5 1.2h6a3.8 3.8 0 0 1 3.8 3.8v6a3.8 3.8 0 0 1-3.8 3.8H5A3.8 3.8 0 0 1 1.2 11V5A3.8 3.8 0 0 1 5 1.2z M8 4.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 0 0 0-6.8z';
const IVORY = 0xf6ecd6, CAP = 0xcdbb99, HIGHLIGHT = 0x4cb088;
const FACES: Record<string, Vec3> = { z: [0, 0, 1], '-z': [0, 0, -1], x: [1, 0, 0], '-x': [-1, 0, 0], y: [0, 1, 0], '-y': [0, -1, 0] };

export type MeasureKind = 'distance' | 'angle';
export interface Measurement { id: string; kind: MeasureKind; points: THREE.Vector3[]; value: string; }

export function measureValue(kind: MeasureKind, p: THREE.Vector3[]): string {
  if (kind === 'distance') return `${p[0].distanceTo(p[1]).toFixed(1)} mm`;
  const a = p[0].clone().sub(p[1]), b = p[2].clone().sub(p[1]);
  return `${((a.angleTo(b) * 180) / Math.PI).toFixed(1)}°`;
}

export interface ViewerElements {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: SVGSVGElement;
  labels: HTMLElement;
  cube: HTMLElement;
  scaleText: HTMLElement;
  scaleBar: HTMLElement;
}

export interface ViewerEvents {
  onMeasurementsChanged(list: Measurement[]): void;
  onToolChanged(tool: MeasureKind | null): void;
  onStructureClicked(index: number | null, x: number, y: number): void;
  /** The view reached, or left, a straight look at one cube face. */
  onFaceOnChanged(faceOn: boolean): void;
  onCameraMoved(): void;
}

interface StructureView { mesh: THREE.Mesh; visible: boolean; }

const PICK_VERTEX = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    #include <begin_vertex>
    #include <project_vertex>
    #include <clipping_planes_vertex>
  }`;
const PICK_FRAGMENT = /* glsl */ `
  #include <clipping_planes_pars_fragment>
  varying vec3 vWorld;
  uniform float pickId;
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(vWorld, pickId);
  }`;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000);
  private controls: TrackballControls;
  /** Runs only during a drag, so an idle page draws nothing. */
  private gestureFrame = 0;
  /** Where the camera is flying to, so a quick second click starts from there. */
  private flight: { dir: THREE.Vector3; up: THREE.Vector3 } | null = null;
  private wasFaceOn = false;
  private root = new THREE.Group();
  private structures: StructureView[] = [];
  private frame = 0;
  private anim = 0;
  private viewHeight = 100;
  private target = new THREE.Vector3();
  private upDir = new THREE.Vector3(0, 1, 0);
  private homeDir = new THREE.Vector3(0.6, 0.5, 0.8).normalize();

  private planes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((n) => new THREE.Plane(n.negate(), 0));
  private clipOn = [false, false, false];
  private stencilGroups: THREE.Group[] = [];
  private capQuads: THREE.Mesh[] = [];
  private capMaterials: THREE.MeshStandardMaterial[] = [];

  private pickTarget: THREE.WebGLRenderTarget | null = null;
  private pickMaterial: THREE.ShaderMaterial;
  private pickCapMaterials: THREE.ShaderMaterial[];

  measurements: Measurement[] = [];
  private counters = { D: 0, A: 0 };
  tool: MeasureKind | null = null;
  private draft: THREE.Vector3[] = [];
  private cursor: [number, number] | null = null;
  private downAt: [number, number] | null = null;

  constructor(private el: ViewerElements, private events: ViewerEvents) {
    this.renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x000000, 0);

    this.scene.add(this.camera, this.root);
    this.scene.add(new THREE.HemisphereLight(0xfffdf8, 0xe6d9c2, 1.75));
    const key = new THREE.DirectionalLight(0xfff8ec, 2.2);
    key.position.set(-0.5, 0.75, 1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(0.9, -0.2, 0.4);
    for (const light of [key, fill]) { this.camera.add(light, light.target); light.target.position.set(0, 0, -1); }

    this.controls = this.makeControls();

    const pickBase = {
      vertexShader: PICK_VERTEX,
      fragmentShader: PICK_FRAGMENT,
      clipping: true,
      blending: THREE.NoBlending,
    };
    this.pickMaterial = new THREE.ShaderMaterial({ ...pickBase, uniforms: { pickId: { value: 0 } } });
    this.pickCapMaterials = [];

    this.planes.forEach((plane, i) => {
      const group = new THREE.Group();
      group.visible = false;
      this.stencilGroups.push(group);
      this.scene.add(group);
      const capMaterial = new THREE.MeshStandardMaterial({
        color: CAP, roughness: 0.85, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
      });
      this.capMaterials.push(capMaterial);
      this.pickCapMaterials.push(new THREE.ShaderMaterial({
        ...pickBase, uniforms: { pickId: { value: 0.5 } },
        stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
      }));
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMaterial);
      quad.renderOrder = i + 1.1;
      quad.visible = false;
      quad.onAfterRender = (r) => r.clearStencil();
      this.capQuads.push(quad);
      this.scene.add(quad);
    });

    new ResizeObserver(() => this.resize()).observe(el.host);
    this.bindPointer();
    this.resize();
  }

  private makeControls() {
    const c = new TrackballControls(this.camera, this.el.canvas);
    c.staticMoving = true;
    c.rotateSpeed = 4;
    c.zoomSpeed = 2;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.minZoom = 0.3;
    c.maxZoom = 40;
    // By default holding A, S or D changes what a drag does, even while typing in a form field.
    c.keys = ['None', 'None', 'None'];
    if (this.controls) c.target.copy(this.controls.target);
    c.addEventListener('change', () => this.requestRender());
    c.addEventListener('start', () => {
      this.events.onCameraMoved();
      cancelAnimationFrame(this.anim);
      this.flight = null;
      const tick = () => { c.update(); this.gestureFrame = requestAnimationFrame(tick); };
      cancelAnimationFrame(this.gestureFrame);
      this.gestureFrame = requestAnimationFrame(tick);
    });
    c.addEventListener('end', () => {
      cancelAnimationFrame(this.gestureFrame);
      c.update();
    });
    return c;
  }

  /** The control scales a pan by camera distance and window width, so this makes the model follow the pointer exactly. */
  private syncPanSpeed() {
    this.controls.panSpeed = (this.el.canvas.clientWidth || 1) / this.distance;
  }

  requestRender() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private resize() {
    const w = this.el.host.clientWidth, h = this.el.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.controls.handleResize();
    this.syncPanSpeed();
    this.applyFrustum();
    this.requestRender();
  }

  private applyFrustum() {
    const w = this.el.host.clientWidth, h = this.el.host.clientHeight;
    if (!w || !h) return;
    const halfH = this.viewHeight / 2, a = w / h;
    this.camera.left = -halfH * a;
    this.camera.right = halfH * a;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  /** Replaces the model. Keeps the camera unless this is a new scan. */
  setSurface(result: SurfaceResult, hiddenFlags: boolean[]) {
    for (const s of this.structures) {
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      this.root.remove(s.mesh);
    }
    for (const g of this.stencilGroups) g.clear();
    this.structures = result.structures.map((data, i) => this.addStructure(data, i, !hiddenFlags[i]));
    this.applyClipping();
  }

  private addStructure(data: StructureMesh, index: number, visible: boolean): StructureView {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const c = new THREE.Vector3((data.bboxMin[0] + data.bboxMax[0]) / 2, (data.bboxMin[1] + data.bboxMax[1]) / 2, (data.bboxMin[2] + data.bboxMax[2]) / 2);
    geometry.boundingSphere = new THREE.Sphere(c, c.distanceTo(new THREE.Vector3(...data.bboxMax)));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...data.bboxMin), new THREE.Vector3(...data.bboxMax));

    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: IVORY, roughness: 0.68, vertexColors: true }));
    mesh.renderOrder = 6;
    mesh.userData.index = index;
    mesh.visible = visible;
    this.root.add(mesh);

    this.planes.forEach((plane, i) => {
      for (const [side, op] of [[THREE.BackSide, THREE.IncrementWrapStencilOp], [THREE.FrontSide, THREE.DecrementWrapStencilOp]] as const) {
        const stencil = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
          depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
          side, clippingPlanes: [plane], stencilFail: op, stencilZFail: op, stencilZPass: op,
        }));
        stencil.renderOrder = i + 1;
        stencil.userData.owner = mesh;
        stencil.visible = visible;
        this.stencilGroups[i].add(stencil);
      }
    });
    return { mesh, visible };
  }

  setStructureVisible(i: number, on: boolean) {
    const s = this.structures[i];
    if (!s) return;
    s.visible = on;
    s.mesh.visible = on;
    for (const g of this.stencilGroups) for (const c of g.children) if (c.userData.owner === s.mesh) c.visible = on;
    this.requestRender();
  }

  highlightStructure(i: number, on: boolean) {
    const m = this.structures[i]?.mesh.material as THREE.MeshStandardMaterial | undefined;
    if (!m) return;
    m.emissive.setHex(on ? HIGHLIGHT : 0);
    m.emissiveIntensity = on ? 0.18 : 0;
    this.requestRender();
  }

  /** Bounds of what's visible, used for fit and clip ranges. */
  bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const s of this.structures) if (s.visible && s.mesh.geometry.boundingBox) box.union(s.mesh.geometry.boundingBox);
    return box;
  }

  /** Puts the table at the bottom, whatever patient position the scanner recorded. */
  setScanFrame(rowDir: Vec3, colDir: Vec3) {
    const row = new THREE.Vector3(...rowDir), up = new THREE.Vector3(...colDir).negate();
    const slice = new THREE.Vector3().crossVectors(row, up);
    this.upDir.copy(up);
    this.homeDir.copy(row).multiplyScalar(0.62).addScaledVector(up, 0.52).addScaledVector(slice, 0.82).normalize();
    this.camera.up.copy(up);
    this.controls.dispose();
    this.controls = this.makeControls();
  }

  fit(animate = true) {
    const box = this.bounds();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.target.copy(center);
    const radius = box.getSize(new THREE.Vector3()).length() / 2;

    const dir = this.homeDir;
    const right = new THREE.Vector3().crossVectors(this.upDir, dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    let w = 0, h = 0;
    for (let c = 0; c < 8; c++) {
      const p = new THREE.Vector3(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).sub(center);
      w = Math.max(w, Math.abs(p.dot(right)));
      h = Math.max(h, Math.abs(p.dot(up)));
    }
    const aspect = (this.el.host.clientWidth || 1) / (this.el.host.clientHeight || 1);
    this.viewHeight = Math.max(h * 2, (w * 2) / aspect) * 1.12 || 100;
    this.applyFrustum();
    this.distance = radius * 4 + 50;
    this.camera.near = 0.1;
    this.camera.far = this.distance * 2 + radius * 2;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.syncPanSpeed();
    if (animate) this.flyTo(dir, 1, upFacing(dir, this.upDir));
    else {
      this.camera.zoom = 1;
      this.camera.up.copy(upFacing(dir, this.upDir));
      this.camera.position.copy(center).addScaledVector(dir, this.distance);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.requestRender();
    }
  }
  private distance = 300;

  viewFrom(face: string) {
    const f = FACES[face];
    if (!f) return;
    const dir = new THREE.Vector3(...f);
    this.flyTo(dir, this.camera.zoom, squaredUp(dir, this.flight?.up ?? this.camera.up));
  }

  /** Turns a face-on view by a quarter turn. Starts from where a flight is heading, so fast clicks stay on exact steps. */
  rollView(sign: 1 | -1) {
    const axis = faceOn(this.flight?.dir ?? this.camera.position.clone().sub(this.controls.target));
    if (!axis) return;
    this.flyTo(axis, this.camera.zoom, rolledUp(axis, squaredUp(axis, this.flight?.up ?? this.camera.up), sign));
  }

  private flyTo(dir: THREE.Vector3, zoom = this.camera.zoom, up?: THREE.Vector3) {
    cancelAnimationFrame(this.anim);
    const to = dir.clone().normalize();
    const toUp = up ? up.clone() : upFacing(to, this.camera.up);
    const start = poseOf(this.camera.position.clone().sub(this.controls.target), this.camera.up);
    const end = poseOf(to, toUp);
    this.flight = { dir: to, up: toUp };
    const t0 = performance.now(), z0 = this.camera.zoom;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420;
    const step = (now: number) => {
      const u = duration ? Math.min(1, (now - t0) / duration) : 1, s = u * u * (3 - 2 * u);
      const pose = start.clone().slerp(end, s);
      const d = new THREE.Vector3(0, 0, 1).applyQuaternion(pose);
      this.camera.position.copy(this.controls.target).addScaledVector(d, this.distance);
      this.camera.up.set(0, 1, 0).applyQuaternion(pose);
      this.camera.zoom = z0 + (zoom - z0) * s;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.requestRender();
      if (u < 1) this.anim = requestAnimationFrame(step);
      else this.flight = null;
    };
    this.anim = requestAnimationFrame(step);
  }

  setClip(axis: number, on: boolean, position: number) {
    this.clipOn[axis] = on;
    this.planes[axis].constant = position;
    this.applyClipping();
  }

  private applyClipping() {
    const active = this.planes.filter((_, i) => this.clipOn[i]);
    for (const s of this.structures) (s.mesh.material as THREE.Material).clippingPlanes = active;
    const box = this.bounds();
    const size = box.isEmpty() ? 400 : box.getSize(new THREE.Vector3()).length() * 2;
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    this.planes.forEach((plane, i) => {
      const on = this.clipOn[i];
      this.stencilGroups[i].visible = on;
      const quad = this.capQuads[i];
      quad.visible = on;
      const others = active.filter((p) => p !== plane);
      this.capMaterials[i].clippingPlanes = others;
      this.pickCapMaterials[i].clippingPlanes = others;
      if (on) {
        const p = plane.projectPoint(center, new THREE.Vector3());
        quad.position.copy(p);
        quad.scale.setScalar(size);
        quad.lookAt(p.clone().sub(plane.normal));
      }
    });
    this.requestRender();
  }

  // Measuring

  setTool(next: MeasureKind | null) {
    this.tool = next;
    this.draft = [];
    this.cursor = null;
    this.el.host.classList.toggle('olcum', !!next);
    this.events.onToolChanged(next);
    this.requestRender();
  }

  clearMeasurements() {
    this.measurements = [];
    this.counters = { D: 0, A: 0 };
    this.events.onMeasurementsChanged(this.measurements);
    this.requestRender();
  }

  removeMeasurement(id: string) {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.events.onMeasurementsChanged(this.measurements);
    this.requestRender();
  }

  private addMeasurement(kind: MeasureKind, points: THREE.Vector3[]) {
    const prefix = kind === 'distance' ? 'D' : 'A';
    this.measurements = [...this.measurements, { id: `${prefix}${++this.counters[prefix]}`, kind, points, value: measureValue(kind, points) }];
    this.events.onMeasurementsChanged(this.measurements);
  }

  private bindPointer() {
    const { canvas, host } = this.el;
    canvas.addEventListener('pointerdown', (e) => { this.downAt = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointermove', (e) => {
      if (this.tool && this.draft.length) {
        const b = host.getBoundingClientRect();
        this.cursor = [e.clientX - b.left, e.clientY - b.top];
        this.requestRender();
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return;
      this.downAt = null;
      const hit = this.pick(e.clientX, e.clientY);
      const b = host.getBoundingClientRect();
      if (this.tool) {
        if (!hit) return;
        this.draft.push(hit.point);
        if (this.draft.length === (this.tool === 'distance' ? 2 : 3)) {
          const done = this.draft;
          this.addMeasurement(this.tool, done);
          this.draft = [];
          this.cursor = null;
        }
        this.requestRender();
        return;
      }
      this.events.onStructureClicked(hit && hit.structure >= 0 ? hit.structure : null, e.clientX - b.left, e.clientY - b.top);
    });
  }

  /** Reads back the surface position under one pixel. Cost doesn't grow with triangle count. */
  pick(clientX: number, clientY: number): { point: THREE.Vector3; structure: number } | null {
    const b = this.el.canvas.getBoundingClientRect();
    if (!this.renderer.extensions.has('EXT_color_buffer_float')) return this.pickByRay(clientX, clientY, b);
    this.pickTarget ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, stencilBuffer: true, depthBuffer: true });
    const ratio = this.renderer.getPixelRatio();
    const fullW = Math.round(b.width * ratio), fullH = Math.round(b.height * ratio);
    this.camera.setViewOffset(fullW, fullH, Math.round((clientX - b.left) * ratio), Math.round((clientY - b.top) * ratio), 1, 1);

    const active = this.planes.filter((_, i) => this.clipOn[i]);
    this.pickMaterial.clippingPlanes = active;
    const restoreMeshes = this.structures.map((s, i) => {
      const original = s.mesh.material, before = s.mesh.onBeforeRender;
      s.mesh.material = this.pickMaterial;
      s.mesh.onBeforeRender = () => {
        this.pickMaterial.uniforms.pickId.value = i + 1;
        this.pickMaterial.uniformsNeedUpdate = true;
      };
      return () => { s.mesh.material = original; s.mesh.onBeforeRender = before; };
    });
    this.capQuads.forEach((q, i) => { q.material = this.pickCapMaterials[i]; });

    const color = new THREE.Color();
    this.renderer.getClearColor(color);
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    const out = new Float32Array(4);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, out);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(color, alpha);

    restoreMeshes.forEach((r) => r());
    this.capQuads.forEach((q, i) => { q.material = this.capMaterials[i]; });
    this.camera.clearViewOffset();
    this.requestRender();

    if (out[3] <= 0) return null;
    return { point: new THREE.Vector3(out[0], out[1], out[2]), structure: out[3] >= 1 ? Math.round(out[3]) - 1 : -1 };
  }

  private pickByRay(clientX: number, clientY: number, b: DOMRect) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - b.left) / b.width) * 2 - 1, -((clientY - b.top) / b.height) * 2 + 1), this.camera);
    const hits = ray.intersectObjects(this.structures.filter((s) => s.visible).map((s) => s.mesh), false);
    const hit = hits.find((h) => this.planes.every((p, i) => !this.clipOn[i] || p.distanceToPoint(h.point) >= 0));
    return hit ? { point: hit.point.clone(), structure: hit.object.userData.index as number } : null;
  }

  // Rendering and overlay

  private render() {
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    this.drawOverlay();
  }

  private project(p: THREE.Vector3): [number, number] {
    const v = p.clone().project(this.camera);
    return [((v.x + 1) / 2) * this.el.host.clientWidth, ((1 - v.y) / 2) * this.el.host.clientHeight];
  }

  private pxPerMm(): number {
    return this.el.host.clientHeight / ((this.camera.top - this.camera.bottom) / this.camera.zoom);
  }

  private drawOverlay() {
    const { overlay, labels } = this.el;
    overlay.replaceChildren();
    labels.replaceChildren();
    const line = (a: number[], b: number[], cls?: string) => this.svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...(cls ? { class: cls } : {}) });
    const dot = (p: number[]) => this.svg('circle', { cx: p[0], cy: p[1], r: 3.5 });

    for (const m of this.measurements) {
      // A measurement on bone that is clipped away leaves the view but stays in the panel.
      if (m.points.some((p) => this.planes.some((pl, i) => this.clipOn[i] && pl.distanceToPoint(p) < -0.5))) continue;
      const pts = m.points.map((p) => this.project(p));
      for (let i = 0; i + 1 < pts.length; i++) line(pts[i], pts[i + 1]);
      pts.forEach(dot);
      const at = m.kind === 'distance' ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - 16] : [pts[1][0], pts[1][1] + 20];
      const label = document.createElement('div');
      label.className = 'etiket-olcu';
      label.style.left = `${at[0]}px`;
      label.style.top = `${at[1]}px`;
      label.textContent = `${m.id}  ${m.value}`;
      labels.appendChild(label);
    }
    const draft = this.draft.map((p) => this.project(p));
    for (let i = 0; i + 1 < draft.length; i++) line(draft[i], draft[i + 1]);
    if (draft.length && this.cursor) line(draft[draft.length - 1], this.cursor, 'taslak');
    draft.forEach(dot);

    const scale = this.niceScale(this.pxPerMm(), 56);
    this.el.scaleText.textContent = `${scale} mm`;
    this.el.scaleBar.style.width = `${scale * this.pxPerMm()}px`;

    const e = new THREE.Matrix4().extractRotation(this.camera.matrixWorldInverse).elements.slice();
    for (const n of [1, 4, 6, 9]) e[n] = -e[n];
    this.el.cube.style.transform = `matrix3d(${e.join(',')})`;

    const isFaceOn = !!faceOn(this.camera.position.clone().sub(this.controls.target));
    if (isFaceOn !== this.wasFaceOn) {
      this.wasFaceOn = isFaceOn;
      this.events.onFaceOnChanged(isFaceOn);
    }
  }

  private niceScale(pxPerMm: number, minPx: number): number {
    return [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * pxPerMm >= minPx) ?? 500;
  }

  private svg(tag: string, attrs: Record<string, string | number>) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    this.el.overlay.appendChild(n);
  }

  /** The model, a scale bar and the Vimics mark. Never any patient or owner details. */
  async snapshot(background: string, ink: string, logoMarkup: string, caption: string, dark = false): Promise<Blob> {
    this.render();
    const canvas = this.el.canvas, w = canvas.width, h = canvas.height, ratio = this.renderer.getPixelRatio();
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);

    /** Frosted ice behind the labels, so they stay readable over the model. Blurs by rescaling, since Safari lacks canvas filters. */
    const frost = (px: number, py: number, pw: number, ph: number) => {
      const shape = new Path2D();
      shape.roundRect(px, py, pw, ph, 8 * ratio);
      const shrink = 14 * ratio, blur = document.createElement('canvas');
      blur.width = Math.max(1, Math.ceil(pw / shrink));
      blur.height = Math.max(1, Math.ceil(ph / shrink));
      blur.getContext('2d')?.drawImage(out, px, py, pw, ph, 0, 0, blur.width, blur.height);
      ctx.save();
      ctx.clip(shape);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(blur, px, py, pw, ph);
      const ice = ctx.createLinearGradient(px, py, px + pw, py + ph);
      ice.addColorStop(0, dark ? 'rgba(44, 78, 112, 0.84)' : 'rgba(255, 255, 255, 0.88)');
      ice.addColorStop(1, dark ? 'rgba(20, 42, 68, 0.74)' : 'rgba(222, 238, 247, 0.76)');
      ctx.fillStyle = ice;
      ctx.fillRect(px, py, pw, ph);
      ctx.restore();
      ctx.lineWidth = ratio;
      ctx.strokeStyle = dark ? 'rgba(190, 225, 245, 0.38)' : 'rgba(150, 190, 214, 0.6)';
      ctx.stroke(shape);
    };

    const pxPerMm = this.pxPerMm() * ratio;
    const scale = this.niceScale(pxPerMm, 56 * ratio);
    const x = 24 * ratio, y = h - 22 * ratio;
    ctx.font = `${12 * ratio}px "IBM Plex Mono", monospace`;

    const labelEnd = Math.max(x + scale * pxPerMm, x + ctx.measureText(`${scale} mm`).width);
    frost(x - 12 * ratio, y - 29 * ratio, labelEnd - x + 24 * ratio, 39 * ratio);

    // The case details get their own panel on the right, shortened if the image is too narrow for them.
    const captionEnd = w - 24 * ratio, room = captionEnd - (labelEnd + 36 * ratio);
    let text = caption;
    while (text && ctx.measureText(text).width > room) text = text.slice(0, -2).trimEnd() + '…';
    if (text.length < 2) text = '';
    if (text) frost(captionEnd - ctx.measureText(text).width - 12 * ratio, y - 16 * ratio, ctx.measureText(text).width + 24 * ratio, 26 * ratio);

    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = ratio;
    ctx.fillText(`${scale} mm`, x, y - 14 * ratio);
    ctx.beginPath();
    ctx.moveTo(x, y - 6 * ratio);
    ctx.lineTo(x, y);
    ctx.lineTo(x + scale * pxPerMm, y);
    ctx.lineTo(x + scale * pxPerMm, y - 6 * ratio);
    ctx.stroke();
    if (text) {
      ctx.textAlign = 'right';
      ctx.fillText(text, captionEnd, y + ratio);
      ctx.textAlign = 'left';
    }

    const img = new Image();
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logoMarkup)}`; });
    if (img.width) {
      const lh = 34 * ratio, lw = lh * (2000 / 362), lx = w - lw - 24 * ratio, ly = 22 * ratio;
      frost(lx - 12 * ratio, ly - 10 * ratio, lw + 24 * ratio, lh + 55 * ratio);
      ctx.drawImage(img, lx, ly, lw, lh);
      ctx.fillStyle = ink;

      /** One centred row under the logo: an icon drawn on a 16-unit grid, then its label. */
      const row = (icon: (c: CanvasRenderingContext2D) => void, label: string, baseline: number) => {
        const size = 12 * ratio, gap = 5 * ratio;
        const start = lx + (lw - size - gap - ctx.measureText(label).width) / 2;
        ctx.save();
        ctx.translate(start, baseline - 10 * ratio);
        ctx.scale(size / 16, size / 16);
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
        ctx.lineWidth = 1.3;
        icon(ctx);
        ctx.restore();
        ctx.fillText(label, start + size + gap, baseline);
      };
      row((c) => c.stroke(new Path2D(WEB_ICON)), 'vimics.vet', ly + lh + 17 * ratio);
      row((c) => {
        c.stroke(new Path2D(INSTAGRAM_ICON));
        c.beginPath();
        c.arc(11.7, 4.3, 0.9, 0, Math.PI * 2);
        c.fill();
      }, '@vimicsveterinary', ly + lh + 35 * ratio);
    }
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Snapshot failed'))), 'image/png'));
  }
}
