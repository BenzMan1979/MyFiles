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

export interface PreviewContext {
  allowDownload: boolean;
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
      const dispose = await renderPdf(box, data);
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
          h('div', { class: 'big-icon' }, kind === 'docx' || kind === 'xlsx' ? '📄' : '📦'),
          h('p', null, kind === 'docx' || kind === 'xlsx' ? 'Word／Excel 預覽將在下一版加入。' : '這個檔案類型無法預覽。'),
          h('p', { class: 'muted' }, `${entry.path.split('/').pop()} · ${formatSize(entry.size)}`),
          ctx.allowDownload ? h('button', { class: 'btn', onclick: ctx.download }, '下載原檔') : h('p', { class: 'muted' }, '發送者沒有開放下載原檔。'),
        ),
      );
      return revoke;
  }
}

export function iconFor(entry: FileEntry): string {
  switch (kindOf(entry.path, entry.mime)) {
    case 'pdf': return '📕';
    case 'image': return '🖼️';
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'markdown':
    case 'text': return '📝';
    case 'html': return '🌐';
    case 'docx': return '📘';
    case 'xlsx': return '📗';
    case 'slides': return '📙';
    default: return '📄';
  }
}
