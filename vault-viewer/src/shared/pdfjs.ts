// pdf.js with its worker started from a Blob URL, so it also works when the page is opened from
// file:// with no network. Chrome refuses *module* workers from blob URLs on file:// pages, so the
// ES module worker is turned into a classic script.

import * as pdfjs from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

let ready = false;

export function loadPdfjs(): typeof pdfjs {
  if (!ready) {
    const classic = workerCode.replace(/import\.meta\.url/g, 'self.location.href').replace(/export\s*\{[^}]*\}\s*;?\s*$/, '');
    const url = URL.createObjectURL(new Blob([classic], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url);
    ready = true;
  }
  return pdfjs;
}
