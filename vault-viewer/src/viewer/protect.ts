// Deterrents only: they stop casual copying/printing and mark screenshots, but cannot stop a
// determined person with developer tools or a camera.

import type { Protection } from '../core/format';

export function watermarkText(p: Protection, recipient: string, openedAt: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${openedAt.getFullYear()}/${pad(openedAt.getMonth() + 1)}/${pad(openedAt.getDate())}`;
  const time = `${date} ${pad(openedAt.getHours())}:${pad(openedAt.getMinutes())}`;
  return p.watermark.text.replace(/\{收件人\}/g, recipient).replace(/\{時間\}/g, time).replace(/\{日期\}/g, date);
}

export function watermarkBackground(text: string, opacity: number, dark: boolean): string {
  const esc = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fill = dark ? '255,255,255' : '0,0,0';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220">` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" transform="rotate(-28 180 110)" ` +
    `font-family="sans-serif" font-size="18" fill="rgba(${fill},${opacity})">${esc}</text></svg>`;
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
