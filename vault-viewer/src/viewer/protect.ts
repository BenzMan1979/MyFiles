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
