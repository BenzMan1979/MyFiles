// Turns a PDF into one JPEG per page, so that no text exists in the vault to copy or search.
// Used for slides (PowerPoint exported to PDF) and anything else where that matters more than size.

import { closeDocument, documentDefaults, loadPdfjs, whenClosed } from '../shared/pdfjs';

export interface ImageOptions {
  /** pixels across the page's width */
  width: number;
  /** JPEG quality, 1 to 100 */
  quality: number;
}

const MAX_SIDE = 4000; // keeps one page well inside what a browser canvas can hold

export async function pdfToImages(data: Uint8Array, o: ImageOptions, onPage?: (done: number, total: number) => void): Promise<Uint8Array[]> {
  const pdfjs = loadPdfjs();
  await whenClosed();
  // pdf.js hands the buffer to its worker, which would leave the caller's copy empty
  const task = pdfjs.getDocument({ data: data.slice(), enableXfa: false, ...documentDefaults });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await closeDocument(task);
    throw new Error((e as Error).name === 'PasswordException' ? '這個 PDF 有設定開啟密碼，請先移除密碼再加入' : `這不是有效的 PDF 檔（${(e as Error).message}）`);
  }
  const pages: Uint8Array[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(o.width / base.width, MAX_SIDE / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp, background: 'rgb(255,255,255)' }).promise;
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', Math.min(1, Math.max(0.1, o.quality / 100))));
      if (!blob) throw new Error(`第 ${n} 頁轉換失敗`);
      pages.push(new Uint8Array(await blob.arrayBuffer()));
      canvas.width = canvas.height = 0; // free the bitmap now rather than at the next collection
      page.cleanup();
      onPage?.(n, doc.numPages);
    }
  } finally {
    await closeDocument(task);
  }
  return pages;
}
