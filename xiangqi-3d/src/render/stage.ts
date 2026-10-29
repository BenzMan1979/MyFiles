import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Side } from '../core/types';
import { BOARD_DEPTH, BOARD_WIDTH, createBackgroundTexture } from './textures';
import { easeInOutCubic, lerp, tween } from './tween';

export type ViewMode = '3d' | 'top';

const POLAR_3D = 0.78;
const POLAR_TOP = 0.0001;

/** Renderer, camera, lights and the frame loop. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private viewSide: Side = 'red';
  private viewMode: ViewMode = '3d';
  private shake = 0;
  private readonly onFrame: ((dt: number) => void)[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 60;
    this.controls.maxPolarAngle = 1.3;
    this.controls.target.set(0, 0, 0);

    this.scene.background = createBackgroundTexture();
    this.scene.fog = new THREE.Fog(0x24160f, 28, 60);
    this.addLights();
    this.addTable();

    this.resize();
    this.placeCamera(this.cameraRadius(), POLAR_3D, 0);
    window.addEventListener('resize', () => this.resize());

    let last = performance.now();
    this.renderer.setAnimationLoop((now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.controls.update();
      for (const fn of this.onFrame) fn(dt);
      this.render();
    });
  }

  addFrameListener(fn: (dt: number) => void) {
    this.onFrame.push(fn);
  }

  /** Brief camera shake, strength in world units. */
  kick(strength = 0.12) {
    this.shake = Math.max(this.shake, strength);
  }

  get side() {
    return this.viewSide;
  }

  get mode() {
    return this.viewMode;
  }

  async setView(side: Side, mode: ViewMode = this.viewMode, duration = 0.9) {
    this.viewSide = side;
    this.viewMode = mode;
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const toTheta = side === 'red' ? 0 : Math.PI;
    // Take the short way round.
    let dTheta = toTheta - from.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const toPhi = mode === '3d' ? POLAR_3D : POLAR_TOP;
    const toRadius = this.cameraRadius();
    this.controls.enabled = false;
    await tween(
      duration,
      (t) => {
        this.placeCamera(lerp(from.radius, toRadius, t), lerp(from.phi, toPhi, t), from.theta + dTheta * t);
      },
      easeInOutCubic,
    );
    this.controls.enabled = true;
  }

  private placeCamera(radius: number, phi: number, theta: number) {
    const pos = new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, phi, theta));
    this.camera.position.copy(pos.add(this.controls.target));
    this.camera.lookAt(this.controls.target);
  }

  /** Distance that fits the whole board, plus room for the HUD, at the current aspect ratio. */
  private cameraRadius() {
    const halfV = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    const halfWidth = BOARD_WIDTH / 2 + 0.4;
    const halfDepth = BOARD_DEPTH / 2 + (this.viewMode === 'top' ? 1.2 : 0.9);
    return Math.max(halfDepth / Math.tan(halfV), halfWidth / Math.tan(halfH));
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Keep the viewing angle, but refit the distance to the new shape.
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    if (s.radius > 0) this.placeCamera(this.cameraRadius(), s.phi, s.theta);
  }

  private render() {
    if (this.shake > 0.001) {
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * this.shake,
        (Math.random() - 0.5) * this.shake,
        (Math.random() - 0.5) * this.shake,
      );
      this.camera.position.add(offset);
      this.renderer.render(this.scene, this.camera);
      this.camera.position.sub(offset);
      this.shake *= 0.86;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a1810, 0.9));

    const key = new THREE.DirectionalLight(0xffe2b8, 2.4);
    key.position.set(6, 14, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = -9;
    s.right = 9;
    s.top = 9;
    s.bottom = -9;
    s.near = 1;
    s.far = 40;
    key.shadow.bias = -0.0005;
    key.shadow.radius = 4;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.5);
    rim.position.set(-8, 6, -10);
    this.scene.add(rim);
  }

  private addTable() {
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(30, 64),
      new THREE.MeshStandardMaterial({ color: 0x3a2213, roughness: 0.85 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.36;
    table.receiveShadow = true;
    this.scene.add(table);
  }
}
