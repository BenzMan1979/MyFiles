import * as THREE from 'three';
import { HistoryEntry } from '../core/game';
import { Board, Piece, PieceType, Side, Square, fileOf, rankOf } from '../core/types';
import { Stage } from './stage';
import {
  BOARD_DEPTH,
  BOARD_WIDTH,
  createBoardTexture,
  createFrameTexture,
  createPieceFaceTexture,
} from './textures';
import { easeInCubic, easeOutCubic, lerp, tween } from './tween';

const PIECE_RADIUS = 0.43;
const PIECE_HEIGHT = 0.22;
const BOARD_THICKNESS = 0.34;
const LIFT = 0.32;

/** World position of a board point, on the board surface. */
export function squareToWorld(s: Square, target = new THREE.Vector3()) {
  return target.set(fileOf(s) - 4, 0, 4.5 - rankOf(s));
}

function worldToSquare(p: THREE.Vector3): Square | null {
  const x = Math.round(p.x + 4);
  const y = Math.round(4.5 - p.z);
  if (x < 0 || x > 8 || y < 0 || y > 9) return null;
  // Only accept clicks reasonably close to a grid point.
  if (Math.hypot(p.x + 4 - x, 4.5 - p.z - y) > 0.5) return null;
  return y * 9 + x;
}

interface PieceObject {
  piece: Piece;
  group: THREE.Group;
  /** Materials whose opacity is faded when captured. */
  materials: THREE.MeshStandardMaterial[];
}

/** Owns every mesh on the board and turns game events into animation. */
export class BoardView {
  private readonly root = new THREE.Group();
  private readonly pieces = new Map<string, PieceObject>();
  private readonly markers = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly boardSurface: THREE.Mesh;
  private readonly lastMoveFrames: THREE.Mesh[];
  private readonly selectRing: THREE.Mesh;
  private readonly checkRing: THREE.Mesh;
  private readonly faceTextures = new Map<string, THREE.Texture>();
  private readonly pieceGeometry: THREE.LatheGeometry;
  private readonly faceGeometry = new THREE.CircleGeometry(PIECE_RADIUS - 0.035, 48);
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private faceAngle = 0;
  private time = 0;

  constructor(private readonly stage: Stage) {
    stage.scene.add(this.root);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_WIDTH + 0.3, BOARD_THICKNESS, BOARD_DEPTH + 0.3),
      new THREE.MeshStandardMaterial({ color: 0x6b3d1d, roughness: 0.6 }),
    );
    body.position.y = -BOARD_THICKNESS / 2 - 0.002;
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    this.boardSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_DEPTH),
      new THREE.MeshStandardMaterial({ map: createBoardTexture(), roughness: 0.55 }),
    );
    this.boardSurface.rotation.x = -Math.PI / 2;
    this.boardSurface.receiveShadow = true;
    this.root.add(this.boardSurface);

    // Bevelled disc: flat bottom, rounded rim, slightly domed edge up to the face.
    const r = PIECE_RADIUS;
    const h = PIECE_HEIGHT;
    this.pieceGeometry = new THREE.LatheGeometry(
      [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(r - 0.03, 0),
        new THREE.Vector2(r, 0.03),
        new THREE.Vector2(r, h - 0.05),
        new THREE.Vector2(r - 0.015, h - 0.015),
        new THREE.Vector2(r - 0.04, h),
        new THREE.Vector2(0, h),
      ],
      48,
    );

    const frameMat = new THREE.MeshBasicMaterial({
      map: createFrameTexture('#ffd36b'),
      transparent: true,
      depthWrite: false,
    });
    this.lastMoveFrames = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), frameMat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.root.add(m);
      return m;
    });

    this.selectRing = this.makeRing(0x6cf0ff, 0.5, 0.58);
    this.checkRing = this.makeRing(0xff3030, 0.48, 0.6);
    this.root.add(this.markers);

    stage.addFrameListener((dt) => this.onFrame(dt));
  }

  private makeRing(color: number, inner: number, outer: number) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    this.root.add(ring);
    return ring;
  }

  private faceTexture(side: Side, type: PieceType) {
    const key = `${side}-${type}`;
    let tex = this.faceTextures.get(key);
    if (!tex) {
      tex = createPieceFaceTexture(side, type);
      this.faceTextures.set(key, tex);
    }
    return tex;
  }

  private createPiece(piece: Piece): PieceObject {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: piece.side === 'red' ? 0xc98d50 : 0xa8743f,
      roughness: 0.45,
      metalness: 0.05,
      transparent: true,
    });
    const body = new THREE.Mesh(this.pieceGeometry, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;

    const faceMat = new THREE.MeshStandardMaterial({
      map: this.faceTexture(piece.side, piece.type),
      roughness: 0.35,
      transparent: true,
      emissive: new THREE.Color(0x000000),
    });
    const face = new THREE.Mesh(this.faceGeometry, faceMat);
    face.rotation.x = -Math.PI / 2;
    face.position.y = PIECE_HEIGHT + 0.002;

    // The face is the only part that rotates to stay readable from the viewer's side.
    const faceHolder = new THREE.Group();
    faceHolder.add(face);
    faceHolder.rotation.y = this.faceAngle;
    faceHolder.name = 'face';

    group.add(body, faceHolder);
    group.userData.pieceId = piece.id;
    this.root.add(group);
    return { piece, group, materials: [bodyMat, faceMat] };
  }

  /** Snaps every piece to match the board (new game, or any non-animated reset). */
  setBoard(board: Board) {
    const seen = new Set<string>();
    board.forEach((piece, s) => {
      if (!piece) return;
      seen.add(piece.id);
      let obj = this.pieces.get(piece.id);
      if (!obj) {
        obj = this.createPiece(piece);
        this.pieces.set(piece.id, obj);
      }
      obj.group.visible = true;
      obj.group.rotation.set(0, 0, 0);
      obj.materials.forEach((m) => (m.opacity = 1));
      squareToWorld(s, obj.group.position);
    });
    for (const [id, obj] of this.pieces) {
      if (!seen.has(id)) obj.group.visible = false;
    }
    this.select(null);
    this.setLastMove(null);
    this.setCheck(null);
  }

  /** Rotates every face so the characters read upright from `side`. */
  setFacing(side: Side) {
    const target = side === 'red' ? 0 : Math.PI;
    const start = this.faceAngle;
    let delta = target - start;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    return tween(0.6, (t) => {
      this.faceAngle = start + delta * t;
      for (const obj of this.pieces.values()) {
        obj.group.getObjectByName('face')!.rotation.y = this.faceAngle;
      }
    });
  }

  /** Highlights a piece and shows where it can go. */
  select(from: Square | null, board?: Board, targets: Square[] = []) {
    if (this.selectedId) this.liftPiece(this.selectedId, false);
    this.selectedId = null;
    for (const m of this.markers.children as THREE.Mesh[]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.markers.clear();
    this.selectRing.visible = false;
    if (from === null || !board) return;

    const piece = board[from]!;
    this.selectedId = piece.id;
    this.liftPiece(piece.id, true);
    squareToWorld(from, this.selectRing.position).setY(0.006);
    this.selectRing.visible = true;

    for (const to of targets) {
      const capture = !!board[to];
      const marker = new THREE.Mesh(
        capture ? new THREE.RingGeometry(0.4, 0.5, 40) : new THREE.CircleGeometry(0.13, 24),
        new THREE.MeshBasicMaterial({
          color: capture ? 0xff4a3d : 0x5ce68a,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      squareToWorld(to, marker.position).setY(capture ? PIECE_HEIGHT + 0.01 : 0.008);
      this.markers.add(marker);
    }
  }

  private liftPiece(id: string, up: boolean) {
    const obj = this.pieces.get(id);
    if (!obj) return;
    const from = obj.group.position.y;
    const to = up ? LIFT : 0;
    tween(0.18, (t) => (obj.group.position.y = lerp(from, to, t)), easeOutCubic);
  }

  setLastMove(entry: HistoryEntry | null | undefined) {
    this.lastMoveFrames.forEach((f) => (f.visible = false));
    if (!entry) return;
    [entry.move.from, entry.move.to].forEach((s, i) => {
      squareToWorld(s, this.lastMoveFrames[i].position).setY(0.004);
      this.lastMoveFrames[i].visible = true;
    });
  }

  /** Shows a pulsing red ring under the king on `square`, or hides it. */
  setCheck(square: Square | null) {
    this.checkRing.visible = square !== null;
    if (square !== null) squareToWorld(square, this.checkRing.position).setY(0.007);
  }

  /** Arcs the moving piece to its target and knocks any captured piece off the board. */
  async animateMove(entry: HistoryEntry) {
    const mover = this.pieces.get(entry.piece.id)!;
    const victim = entry.captured ? this.pieces.get(entry.captured.id) : undefined;
    this.select(null);

    const start = mover.group.position.clone();
    const end = squareToWorld(entry.move.to);
    const distance = start.distanceTo(end);
    const height = 0.6 + distance * 0.12;
    const duration = 0.35 + Math.min(0.35, distance * 0.04);

    // The victim is struck just before the attacker lands, so the two never overlap.
    let impact: Promise<void> | undefined;
    await tween(duration, (t) => {
      mover.group.position.lerpVectors(start, end, t);
      mover.group.position.y = lerp(start.y, 0, t) + Math.sin(Math.PI * t) * height;
      if (victim && !impact && t > 0.8) {
        this.stage.kick(0.18);
        impact = this.knockAway(victim, start, end);
      }
    });
    if (!victim) this.stage.kick(0.03);
    await impact;
  }

  private async knockAway(victim: PieceObject, from: THREE.Vector3, at: THREE.Vector3) {
    const dir = at.clone().sub(from).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const startPos = victim.group.position.clone();
    const spin = new THREE.Vector3(Math.random() * 6 - 3, Math.random() * 4, Math.random() * 6 - 3);
    await tween(
      0.7,
      (t) => {
        victim.group.position.set(
          startPos.x + dir.x * t * 2.2,
          startPos.y + Math.sin(Math.min(1, t * 1.4) * Math.PI) * 1.4 + t * 0.3,
          startPos.z + dir.z * t * 2.2,
        );
        victim.group.rotation.set(spin.x * t, spin.y * t, spin.z * t);
        victim.materials.forEach((m) => (m.opacity = 1 - easeInCubic(t)));
      },
      (t) => t,
    );
    victim.group.visible = false;
  }

  /** Reverses a move: the piece slides back and any captured piece reappears. */
  async animateUndo(entry: HistoryEntry) {
    this.select(null);
    const mover = this.pieces.get(entry.piece.id)!;
    const start = mover.group.position.clone();
    const end = squareToWorld(entry.move.from);
    await tween(0.35, (t) => {
      mover.group.position.lerpVectors(start, end, t);
      mover.group.position.y = Math.sin(Math.PI * t) * 0.5;
    });
    if (entry.captured) {
      const victim = this.pieces.get(entry.captured.id)!;
      victim.group.visible = true;
      victim.group.rotation.set(0, 0, 0);
      squareToWorld(entry.move.to, victim.group.position).setY(0.8);
      await tween(0.3, (t) => {
        victim.group.position.y = lerp(0.8, 0, t);
        victim.materials.forEach((m) => (m.opacity = t));
      });
    }
  }

  /** The board square under a screen point (in normalized device coordinates). */
  pick(ndc: THREE.Vector2): Square | null {
    this.raycaster.setFromCamera(ndc, this.stage.camera);
    const groups = [...this.pieces.values()].filter((o) => o.group.visible).map((o) => o.group);
    const hit = this.raycaster.intersectObjects(groups, true)[0];
    if (hit) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.pieceId === undefined) obj = obj.parent;
      if (obj) {
        // Use the piece's resting square rather than the exact hit point.
        const p = obj.position;
        return worldToSquare(new THREE.Vector3(p.x, 0, p.z));
      }
    }
    const boardHit = this.raycaster.intersectObject(this.boardSurface)[0];
    return boardHit ? worldToSquare(boardHit.point) : null;
  }

  setHover(id: string | null) {
    if (this.hoveredId === id) return;
    this.setEmissive(this.hoveredId, 0x000000);
    this.hoveredId = id;
    this.setEmissive(id, 0x3a2a10);
  }

  private setEmissive(id: string | null, color: number) {
    if (!id) return;
    const obj = this.pieces.get(id);
    if (obj) (obj.materials[1].emissive as THREE.Color).setHex(color);
  }

  private onFrame(dt: number) {
    this.time += dt;
    if (this.checkRing.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 7);
      (this.checkRing.material as THREE.MeshBasicMaterial).opacity = 0.45 + pulse * 0.5;
      this.checkRing.scale.setScalar(1 + pulse * 0.12);
    }
    if (this.selectRing.visible) {
      this.selectRing.rotation.z += dt;
      (this.selectRing.material as THREE.MeshBasicMaterial).opacity = 0.65 + 0.3 * Math.sin(this.time * 5);
    }
  }
}
