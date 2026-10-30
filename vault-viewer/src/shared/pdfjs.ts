// pdf.js with its worker started from a Blob URL, so it also works when the page is opened from
// file:// with no network. Chrome refuses *module* workers from blob URLs on file:// pages, so the
// ES module worker is turned into a classic script.

import * as pdfjs from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

// Older Chinese PDFs often do not embed their fonts and instead name a predefined character map
// (UniCNS-UCS2-H, ETen-B5-H, GBK-EUC-H, ...). pdf.js normally downloads these; there is no network
// here, so the Traditional and Simplified Chinese ones are built in (about 300 KB). Anything else
// (Japanese, Korean) is not included; those fonts fall back to the system's.
const cmapFiles = import.meta.glob(
  '../../node_modules/pdfjs-dist/cmaps/{Adobe-CNS1-*,UniCNS-UCS2-*,UniCNS-UTF16-*,ETen-*,ETenms-*,ETHK-*,B5-*,B5pc-*,HKscs-*,HKdla-*,HKdlb-*,HKgccs-*,HKm314-*,HKm471-*,CNS-EUC-*,CNS1-*,CNS2-*,Adobe-GB1-*,UniGB-UCS2-*,UniGB-UTF16-*,GBK-EUC-*,GBK2K-*,GBKp-EUC-*,GBpc-EUC-*,GB-EUC-*}.bcmap',
  { query: '?inline', import: 'default', eager: true },
) as Record<string, string>;

const cmaps = new Map<string, string>();
for (const [path, dataUrl] of Object.entries(cmapFiles)) cmaps.set(path.slice(path.lastIndexOf('/') + 1), dataUrl);

function decode(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Where pdf.js asks for the data it would otherwise download: character maps, standard fonts, wasm. */
class EmbeddedData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = kind === 'cMapUrl' ? cmaps.get(filename) : undefined;
    if (!url) throw new Error(`not built in: ${filename}`);
    return decode(url);
  }
}

/** The names of the character maps that are built in (for tests). */
export const builtInCMaps = (): string[] => [...cmaps.keys()].sort();

/** Options that every getDocument call here should use. */
export const documentDefaults = { BinaryDataFactory: EmbeddedData, useWorkerFetch: false };

let ready = false;

// All documents share one worker. Closing a document takes a moment, and opening the next one while
// that is still going fails with "the worker is being destroyed", so closing is queued and every
// opening waits for it.
let closing: Promise<unknown> = Promise.resolve();

export function closeDocument(task: { destroy(): Promise<void> }): Promise<unknown> {
  closing = closing.then(() => task.destroy()).catch(() => {});
  return closing;
}

/** Resolves when no document is being closed. Call before getDocument. */
export const whenClosed = (): Promise<unknown> => closing;

export function loadPdfjs(): typeof pdfjs {
  if (!ready) {
    const classic = workerCode.replace(/import\.meta\.url/g, 'self.location.href').replace(/export\s*\{[^}]*\}\s*;?\s*$/, '');
    const url = URL.createObjectURL(new Blob([classic], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url);
    ready = true;
  }
  return pdfjs;
}
