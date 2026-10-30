// Deterrents only: they stop casual copying/printing and mark screenshots, but cannot stop a
// determined person with developer tools or a camera.

import type { Protection } from '../core/format';

export interface WatermarkContext {
  recipient: string;
  note?: string;
  openedAt: Date;
  /** address the server saw; only known for online vaults */
  ip?: string | null;
  country?: string | null;
  /** short code that the server also logs, so a screenshot can be traced to one opening */
  tag?: string;
  device?: string;
}

/** Browser and OS only: a web page cannot read the computer's name or hardware. */
export function describeDevice(ua = navigator.userAgent): string {
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  // Edge and Opera also say "Chrome", so look for the more specific names first.
  const found = (['Edg', 'OPR', 'Firefox', 'Chrome', 'Version'] as const).map((k) => [k, ua.match(new RegExp(`${k}\\/(\\d+)`))] as const).find(([, m]) => m);
  const names = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' } as Record<string, string>;
  const name = found ? names[found[0]] ?? found[0] : '';
  const m = found?.[1] ?? null;
  return [name && `${name} ${m![1]}`, os].filter(Boolean).join(' / ') || '未知裝置';
}

export function watermarkText(p: Protection, c: WatermarkContext): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = c.openedAt;
  const date = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const time = `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const values: Record<string, string> = {
    收件人: c.recipient,
    備註: c.note ?? '',
    時間: time,
    日期: date,
    IP: c.ip || '—',
    地區: c.country || '—',
    裝置: c.device ?? describeDevice(),
    編號: c.tag ?? '',
  };
  return p.watermark.text.replace(/\{([^{}]+)\}/g, (all, k: string) => (k in values ? values[k] : all)).replace(/\s{3,}/g, '  ').trim();
}

export const WATERMARK_DEFAULTS = { size: 18, density: 3 };
export const WATERMARK_SIZE_RANGE = { min: 10, max: 48 };
export const DENSITY_LABELS = ['很疏', '疏', '標準', '密', '很密'];
/** Space between marks, in multiples of the font size. */
const DENSITY_GAP = [12, 7, 4, 2, 0.6];
const ANGLE = (28 * Math.PI) / 180;

export function watermarkStyle(w: { size?: number; density?: number }) {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    size: clamp(w.size ?? WATERMARK_DEFAULTS.size, WATERMARK_SIZE_RANGE.min, WATERMARK_SIZE_RANGE.max),
    density: clamp(w.density ?? WATERMARK_DEFAULTS.density, 1, 5),
  };
}

/** Real width when a canvas is available (the browser), a rough estimate otherwise (tests). */
function textWidth(text: string, size: number): number {
  if (typeof document !== 'undefined') {
    const g = document.createElement('canvas').getContext('2d');
    if (g) {
      g.font = `600 ${size}px sans-serif`;
      return g.measureText(text).width;
    }
  }
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    em += c >= 0x2e80 || (c >= 0xff00 && c <= 0xffef) ? 1 : ch === ' ' ? 0.3 : /[A-Z0-9]/.test(ch) ? 0.68 : 0.56;
  }
  return em * size;
}

/**
 * Dark text with a light outline, so it shows on any background. PDF pages, images and documents
 * are white even in dark mode, so a mark whose colour follows the theme would vanish on them.
 *
 * The tile is sized from the text and font size so a long text is never cut off. Marks are laid
 * out like bricks: every other row is shifted by half a mark, drawn at both side edges so it wraps.
 */
export function watermarkBackground(text: string, opacity: number, size = WATERMARK_DEFAULTS.size, density = WATERMARK_DEFAULTS.density): string {
  const st = watermarkStyle({ size, density });
  const w = textWidth(text, st.size) * 1.04 + 8;
  const hgt = st.size * 1.4;
  const bw = w * Math.cos(ANGLE) + hgt * Math.sin(ANGLE);
  const bh = w * Math.sin(ANGLE) + hgt * Math.cos(ANGLE);
  const gap = st.size * DENSITY_GAP[st.density - 1];
  const cw = Math.ceil(bw + gap);
  const ch = Math.ceil(bh + gap * 0.75);
  const esc = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const mark = (x: number, y: number) =>
    `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-28 ${x} ${y})" ` +
    `font-family="sans-serif" font-size="${st.size}" font-weight="600" paint-order="stroke" stroke-linejoin="round" stroke-width="${Math.max(2, st.size / 6)}" ` +
    `fill="rgba(0,0,0,${opacity})" stroke="rgba(255,255,255,${opacity})">${esc}</text>`;
  // one tile = a row with a mark in the middle, then a row shifted by half a cell (wraps around the sides)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch * 2}">${mark(cw / 2, ch / 2)}${mark(0, ch * 1.5)}${mark(cw, ch * 1.5)}</svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

/** Installs copy/print/keyboard guards; returns a function that removes them. */
export function installGuards(p: Protection): () => void {
  const offs: (() => void)[] = [];
  const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
    document.addEventListener(type, fn, true);
    offs.push(() => document.removeEventListener(type, fn, true));
  };
  const style = document.createElement('style');
  let css = '';
  if (!p.allowCopy) {
    css += '.protected, .protected * { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none; }';
    const stop = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      e.preventDefault();
    };
    on('copy', stop);
    on('cut', stop);
    on('contextmenu', stop);
    on('dragstart', stop);
  }
  if (!p.allowPrint) {
    css += '@media print { body > * { display: none !important; } body::after { content: "此文件不允許列印"; display: block; font: 24px sans-serif; padding: 40px; } }';
  }
  on('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if ((k === 'p' && !p.allowPrint) || k === 's' || (!p.allowCopy && (k === 'c' || k === 'x' || k === 'a') && !(e.target as HTMLElement)?.closest?.('input, textarea'))) {
      e.preventDefault();
    }
  });
  style.textContent = css;
  document.head.appendChild(style);
  offs.push(() => style.remove());
  return () => offs.forEach((f) => f());
}

/** Calls `lock` after idle minutes or after the page stays hidden/unfocused too long. */
export function installAutoLock(p: Protection, lock: (reason: string) => void): () => void {
  const offs: (() => void)[] = [];
  let last = Date.now();
  let hiddenSince: number | null = null;
  const bump = () => (last = Date.now());
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(t, bump, { passive: true, capture: true });
    offs.push(() => window.removeEventListener(t, bump, { capture: true }));
  }
  const away = () => (hiddenSince ??= Date.now());
  const back = () => {
    if (hiddenSince && p.blurLockSeconds > 0 && Date.now() - hiddenSince >= p.blurLockSeconds * 1000) {
      lock(`離開視窗超過 ${p.blurLockSeconds} 秒，已自動上鎖`);
    }
    hiddenSince = null;
    bump();
  };
  const vis = () => (document.hidden ? away() : back());
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('blur', away);
  window.addEventListener('focus', back);
  offs.push(() => {
    document.removeEventListener('visibilitychange', vis);
    window.removeEventListener('blur', away);
    window.removeEventListener('focus', back);
  });
  const timer = setInterval(() => {
    if (p.idleLockMinutes > 0 && Date.now() - last >= p.idleLockMinutes * 60_000) lock(`超過 ${p.idleLockMinutes} 分鐘沒有操作，已自動上鎖`);
    else if (hiddenSince && p.blurLockSeconds > 0 && Date.now() - hiddenSince >= p.blurLockSeconds * 1000) lock(`離開視窗超過 ${p.blurLockSeconds} 秒，已自動上鎖`);
  }, 1000);
  offs.push(() => clearInterval(timer));
  return () => offs.forEach((f) => f());
}
