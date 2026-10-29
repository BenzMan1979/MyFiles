import * as THREE from 'three';
import { PIECE_NAMES } from '../core/notation';
import { PieceType, Side } from '../core/types';

export const PIECE_FONT = '"Noto Serif TC", "BiauKai", "DFKai-SB", "KaiTi", serif';

/** Board geometry in world units: one unit per grid cell. */
export const BOARD_MARGIN = 0.95;
export const BOARD_WIDTH = 8 + BOARD_MARGIN * 2;
export const BOARD_DEPTH = 9 + BOARD_MARGIN * 2;

const PX = 128; // texture pixels per world unit

function canvasTexture(canvas: HTMLCanvasElement) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Pseudo-random but deterministic, so the wood grain looks the same on every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

function paintWood(ctx: CanvasRenderingContext2D, w: number, h: number, light: string, dark: string, seed: number) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, light);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const rand = rng(seed);
  for (let i = 0; i < 140; i++) {
    const y0 = rand() * h;
    const amp = 4 + rand() * 18;
    const freq = 0.002 + rand() * 0.006;
    const phase = rand() * Math.PI * 2;
    ctx.strokeStyle = `rgba(90, 50, 20, ${0.04 + rand() * 0.08})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const y = y0 + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 3.1) * amp * 0.25;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

export function createBoardTexture(): THREE.Texture {
  const W = Math.round(BOARD_WIDTH * PX);
  const H = Math.round(BOARD_DEPTH * PX);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  paintWood(ctx, W, H, '#e2bd83', '#c99858', 7);

  // Grid point (x, y) in canvas pixels; canvas top is black's back rank.
  const px = (x: number) => (BOARD_MARGIN + x) * PX;
  const py = (y: number) => (BOARD_MARGIN + (9 - y)) * PX;
  const ink = '#4a2b12';
  ctx.strokeStyle = ink;
  ctx.lineCap = 'square';

  // Double outer frame.
  ctx.lineWidth = 9;
  const pad = 0.28 * PX;
  ctx.strokeRect(px(0) - pad, py(9) - pad, 8 * PX + pad * 2, 9 * PX + pad * 2);
  ctx.lineWidth = 4;
  ctx.strokeRect(px(0), py(9), 8 * PX, 9 * PX);

  ctx.lineWidth = 3.5;
  ctx.beginPath();
  for (let y = 0; y <= 9; y++) {
    ctx.moveTo(px(0), py(y));
    ctx.lineTo(px(8), py(y));
  }
  for (let x = 1; x < 8; x++) {
    // Inner files stop at the river.
    ctx.moveTo(px(x), py(0));
    ctx.lineTo(px(x), py(4));
    ctx.moveTo(px(x), py(5));
    ctx.lineTo(px(x), py(9));
  }
  // Palaces.
  for (const [a, b] of [
    [0, 2],
    [7, 9],
  ]) {
    ctx.moveTo(px(3), py(a));
    ctx.lineTo(px(5), py(b));
    ctx.moveTo(px(5), py(a));
    ctx.lineTo(px(3), py(b));
  }
  ctx.stroke();

  // Position marks for cannons and pawns.
  const marks: [number, number][] = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
  ];
  const gap = 0.07 * PX;
  const arm = 0.17 * PX;
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [x, y] of marks) {
    for (const sx of [-1, 1]) {
      if ((x === 0 && sx === -1) || (x === 8 && sx === 1)) continue;
      for (const sy of [-1, 1]) {
        const cx = px(x) + sx * gap;
        const cy = py(y) + sy * gap;
        ctx.moveTo(cx + sx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * arm);
      }
    }
  }
  ctx.stroke();

  // River.
  ctx.fillStyle = ink;
  ctx.font = `900 ${0.62 * PX}px ${PIECE_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const riverY = (py(4) + py(5)) / 2;
  ctx.save();
  ctx.translate(px(2), riverY);
  ctx.rotate(Math.PI); // 楚河 faces the black side, as on a traditional board
  ctx.fillText('楚　河', 0, 0);
  ctx.restore();
  ctx.fillText('漢　界', px(6), riverY);

  return canvasTexture(canvas);
}

export const SIDE_COLORS: Record<Side, string> = {
  red: '#b0161e',
  black: '#1d1b1a',
};

export function createPieceFaceTexture(side: Side, type: PieceType): THREE.Texture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const c = S / 2;

  const g = ctx.createRadialGradient(c * 0.8, c * 0.7, 10, c, c, c);
  g.addColorStop(0, '#fbf1da');
  g.addColorStop(1, '#e5cfa2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const color = SIDE_COLORS[side];
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.8, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = `900 ${S * 0.56}px ${PIECE_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(PIECE_NAMES[side][type], c, c + S * 0.02);

  return canvasTexture(canvas);
}

/** Corner brackets used to mark the last move's squares. */
export function createFrameTexture(color: string): THREE.Texture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  const m = 12;
  const arm = 34;
  ctx.beginPath();
  for (const [x, y, sx, sy] of [
    [m, m, 1, 1],
    [S - m, m, -1, 1],
    [m, S - m, 1, -1],
    [S - m, S - m, -1, -1],
  ]) {
    ctx.moveTo(x + sx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * arm);
  }
  ctx.stroke();
  return canvasTexture(canvas);
}

export function createBackgroundTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#0d0a0f');
  g.addColorStop(0.55, '#24160f');
  g.addColorStop(1, '#3b2414');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  return canvasTexture(canvas);
}
