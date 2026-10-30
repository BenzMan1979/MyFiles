// PDF pages drawn with pdf.js, loaded as the person scrolls.

import { h } from '../shared/dom';
import { loadPdfjs } from '../shared/pdfjs';

export interface PdfOptions {
  /** add a transparent text layer so the text can be selected and searched (only when copying is allowed) */
  textLayer?: boolean;
}

export async function renderPdf(container: HTMLElement, data: Uint8Array, opts: PdfOptions = {}): Promise<() => void> {
  const pdfjs = loadPdfjs();
  const task = pdfjs.getDocument({ data, enableXfa: false });
  const doc = await task.promise;
  let zoom = 1;
  let disposed = false;
  const pages = h('div', { class: 'pdf-pages' });
  const zoomLabel = h('span', { class: 'pdf-zoom' }, '100%');
  const bar = h(
    'div',
    { class: 'pdf-bar' },
    h('span', null, `共 ${doc.numPages} 頁`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn small', title: '縮小', onclick: () => setZoom(zoom / 1.25) }, '－'),
    zoomLabel,
    h('button', { class: 'btn small', title: '放大', onclick: () => setZoom(zoom * 1.25) }, '＋'),
    h('button', { class: 'btn small', onclick: () => setZoom(1) }, '符合寬度'),
  );
  container.append(bar, pages);

  const slots: { el: HTMLDivElement; rendered: number; w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const el = h('div', { class: 'pdf-page', 'data-page': i });
    slots.push({ el, rendered: 0, w: vp.width, h: vp.height });
    pages.append(el);
    if (disposed) break;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) void draw(Number((e.target as HTMLElement).dataset.page));
    },
    { root: container.closest('.preview-scroll'), rootMargin: '600px 0px' },
  );

  function layout() {
    const avail = Math.max(200, pages.clientWidth - 24);
    for (const s of slots) {
      const width = Math.round(Math.min(avail, s.w * 2) * zoom);
      s.el.style.width = `${width}px`;
      s.el.style.height = `${Math.round((width * s.h) / s.w)}px`;
    }
  }

  async function draw(n: number) {
    const s = slots[n - 1];
    const width = parseFloat(s.el.style.width);
    if (disposed || s.rendered === width) return;
    s.rendered = width;
    const page = await doc.getPage(n);
    const scale = (width / s.w) * (window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const canvas = h('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height) });
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    if (disposed || s.rendered !== width) return;
    s.el.replaceChildren(canvas);
    if (opts.textLayer) {
      const cssScale = width / s.w; // CSS pixels per PDF unit
      const layer = h('div', { class: 'textLayer' });
      layer.style.setProperty('--total-scale-factor', String(cssScale));
      s.el.append(layer);
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: page.getViewport({ scale: cssScale }) }).render();
    }
  }

  function setZoom(z: number) {
    zoom = Math.min(4, Math.max(0.25, z));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    layout();
    for (const s of slots) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom > -600 && r.top < window.innerHeight + 600) void draw(Number(s.el.dataset.page));
    }
  }

  layout();
  slots.forEach((s) => io.observe(s.el));
  const ro = new ResizeObserver(() => setZoom(zoom));
  ro.observe(pages);

  return () => {
    disposed = true;
    io.disconnect();
    ro.disconnect();
    void task.destroy();
  };
}
