import { marked } from 'marked';
import { extOf, formatSize, kindOf, type FileKind } from '../core/mime';
import type { FileEntry } from '../core/format';
import { h } from '../shared/dom';
import { sanitizeHtml } from './sanitize';

const MAX_TEXT = 5 * 1024 * 1024;

export function decodeText(data: Uint8Array): string {
  const slice = data.subarray(0, MAX_TEXT);
  const utf = new TextDecoder('utf-8').decode(slice);
  const bad = (utf.match(/�/g) ?? []).length;
  if (bad > 4) {
    // Older Traditional Chinese text files are often Big5.
    try {
      const big5 = new TextDecoder('big5').decode(slice);
      if ((big5.match(/�/g) ?? []).length < bad) return big5;
    } catch {
      /* decoder unavailable */
    }
  }
  return utf.replace(/^﻿/, '');
}

/** The stand-in entry of a converted PDF (see PageGroup): its pages are separate encrypted images. */
export const PAGES_MIME = 'application/x-vault-pages';
export const GROUP_PREFIX = 'group:';

/** Page images, decrypted only when they scroll near the screen. */
export async function renderPages(box: HTMLElement, pages: FileEntry[], read: (page: FileEntry) => Promise<Uint8Array>): Promise<() => void> {
  let zoom = 1;
  let disposed = false;
  const urls: string[] = [];
  const list = h('div', { class: 'page-images' });
  const label = h('span', { class: 'pdf-zoom' }, '100%');
  const setZoom = (z: number) => {
    zoom = Math.min(3, Math.max(0.3, z));
    label.textContent = `${Math.round(zoom * 100)}%`;
    list.style.setProperty('--page-zoom', String(zoom));
  };
  const bar = h('div', { class: 'pdf-bar' },
    h('span', null, `共 ${pages.length} 頁`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn small', title: '縮小', onclick: () => setZoom(zoom / 1.25) }, '－'),
    label,
    h('button', { class: 'btn small', title: '放大', onclick: () => setZoom(zoom * 1.25) }, '＋'),
    h('button', { class: 'btn small', onclick: () => setZoom(1) }, '符合寬度'),
  );
  const slots = pages.map((_p, i) => h('div', { class: 'page-image', 'data-page': i }, h('div', { class: 'spinner' })));
  list.append(...slots);
  box.append(bar, list);

  const loaded = new Set<number>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.page);
        if (!e.isIntersecting || loaded.has(i)) continue;
        loaded.add(i);
        void (async () => {
          try {
            const bytes = await read(pages[i]);
            if (disposed) return;
            const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: pages[i].mime }));
            urls.push(url);
            const img = h('img', { src: url, alt: `第 ${i + 1} 頁`, draggable: 'false' });
            img.addEventListener('load', () => slots[i].replaceChildren(img), { once: true });
          } catch {
            slots[i].replaceChildren(h('p', { class: 'error' }, `第 ${i + 1} 頁無法顯示`));
          }
        })();
      }
    },
    { root: box.closest('.preview-scroll'), rootMargin: '800px 0px' },
  );
  slots.forEach((s) => io.observe(s));
  return () => {
    disposed = true;
    io.disconnect();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
}

/** Kinds that are shown from the file's content; for the rest nothing needs decrypting until download. */
export function usesContent(entry: FileEntry): boolean {
  const kind = kindOf(entry.path, entry.mime);
  return kind !== 'other' && kind !== 'slides' && kind !== 'legacy';
}

export interface PreviewContext {
  allowDownload: boolean;
  allowCopy: boolean;
  download: () => void;
}

/** Renders a decrypted file into `box`; returns a cleanup function. */
export async function renderPreview(box: HTMLElement, entry: FileEntry, data: Uint8Array, ctx: PreviewContext): Promise<() => void> {
  const kind: FileKind = kindOf(entry.path, entry.mime);
  const urls: string[] = [];
  const blobUrl = () => {
    const u = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: entry.mime }));
    urls.push(u);
    return u;
  };
  const revoke = () => urls.forEach((u) => URL.revokeObjectURL(u));

  switch (kind) {
    case 'pdf': {
      const { renderPdf } = await import('./pdf');
      const dispose = await renderPdf(box, data, { textLayer: ctx.allowCopy });
      return () => {
        dispose();
        revoke();
      };
    }
    case 'image':
      box.append(h('div', { class: 'media' }, h('img', { src: blobUrl(), alt: entry.path, draggable: 'false' })));
      return revoke;
    case 'video':
    case 'audio': {
      const el = h(kind, {
        src: blobUrl(),
        controls: true,
        controlslist: ctx.allowDownload ? null : 'nodownload noplaybackrate',
        disablepictureinpicture: true,
        preload: 'metadata',
      });
      el.addEventListener('error', () => {
        box.append(h('p', { class: 'note warn' }, '瀏覽器無法播放這個格式。建議打包前轉成 MP4（H.264／AAC）或 MP3。'));
      });
      box.append(h('div', { class: `media ${kind}` }, el));
      return () => {
        el.pause();
        el.removeAttribute('src');
        el.load();
        revoke();
      };
    }
    case 'docx': {
      const { renderDocx } = await import('./docx');
      const dispose = await renderDocx(box, data);
      return () => {
        dispose();
        revoke();
      };
    }
    case 'xlsx': {
      const { renderXlsx } = await import('./xlsx');
      const dispose = await renderXlsx(box, data);
      return () => {
        dispose();
        revoke();
      };
    }
    case 'legacy':
      box.append(
        h('div', { class: 'empty' },
          h('div', { class: 'big-icon' }, '📄'),
          h('p', null, '舊版 Office 格式（.doc／.xls）無法預覽。'),
          h('p', { class: 'muted' }, '請發送者另存成 .docx／.xlsx 或 PDF 後重新打包。'),
          ctx.allowDownload ? h('button', { class: 'btn', onclick: ctx.download }, '下載原檔') : null,
        ),
      );
      return revoke;
    case 'markdown': {
      const html = await marked.parse(decodeText(data), { gfm: true, breaks: false });
      box.append(h('article', { class: 'doc' }, sanitizeHtml(html)));
      return revoke;
    }
    case 'html':
      box.append(
        h('p', { class: 'note' }, '網頁檔以安全模式顯示（不執行程式、不載入外部資源）。'),
        h('article', { class: 'doc' }, sanitizeHtml(decodeText(data))),
      );
      return revoke;
    case 'text': {
      const text = decodeText(data);
      box.append(h('pre', { class: `code ${extOf(entry.path) === 'csv' ? 'csv' : ''}` }, text));
      if (data.length > MAX_TEXT) box.append(h('p', { class: 'note' }, `檔案太大，只顯示前 ${formatSize(MAX_TEXT)}。`));
      return revoke;
    }
    case 'slides':
      box.append(
        h('div', { class: 'empty' },
          h('div', { class: 'big-icon' }, '📊'),
          h('p', null, '簡報檔無法在瀏覽器中準確呈現。'),
          h('p', { class: 'muted' }, '請發送者用 PowerPoint「檔案 → 匯出 → PDF」後重新打包。'),
          ctx.allowDownload ? h('button', { class: 'btn', onclick: ctx.download }, '下載原檔') : null,
        ),
      );
      return revoke;
    default:
      box.append(
        h('div', { class: 'empty' },
          h('div', { class: 'big-icon' }, '📦'),
          h('p', null, '這個檔案類型無法預覽。'),
          h('p', { class: 'muted' }, `${entry.path.split('/').pop()} · ${formatSize(entry.size)}`),
          ctx.allowDownload ? h('button', { class: 'btn', onclick: ctx.download }, '下載原檔') : h('p', { class: 'muted' }, '發送者沒有開放下載原檔。'),
        ),
      );
      return revoke;
  }
}

export function iconFor(entry: FileEntry): string {
  if (entry.mime === PAGES_MIME) return '📕';
  switch (kindOf(entry.path, entry.mime)) {
    case 'pdf': return '📕';
    case 'image': return '🖼️';
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'markdown':
    case 'text': return '📝';
    case 'html': return '🌐';
    case 'docx':
    case 'legacy': return '📘';
    case 'xlsx': return '📗';
    case 'slides': return '📙';
    default: return '📄';
  }
}
