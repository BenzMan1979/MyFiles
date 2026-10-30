// A small .xlsx reader and viewer: sheets as tabs, values formatted the way Excel shows them.
// It reads cached values, not formulas, and ignores charts, images and styling beyond alignment.

import { strFromU8, unzipSync } from 'fflate';
import { h } from '../shared/dom';
import { colName, formatCell, formatGeneral, parseRange, parseRef } from './xlsxFormat';

const MAX_ROWS = 3000;
const MAX_COLS = 100;
const MAX_UNZIPPED = 200 * 1024 * 1024;

interface Cell {
  text: string;
  num: boolean;
}

export interface Sheet {
  name: string;
  rows: (Cell | undefined)[][];
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  colWidths: Map<number, number>;
  truncated: boolean;
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el: Element, tag: string) => Array.from(el.children).filter((c) => c.localName === tag);
const attr = (el: Element, name: string) => el.getAttribute(name) ?? '';

function textOf(si: Element): string {
  // plain <t>, or runs <r><t>; phonetic hints (<rPh>) are not part of the value
  let out = '';
  for (const c of Array.from(si.children)) {
    if (c.localName === 't') out += c.textContent ?? '';
    else if (c.localName === 'r') out += kids(c, 't').map((t) => t.textContent ?? '').join('');
  }
  return out;
}

export function readWorkbook(data: Uint8Array): Sheet[] {
  let total = 0;
  const files = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error('這個 Excel 檔解開後太大，無法預覽');
      return /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name);
    },
  });
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : null);
  const wbText = read('xl/workbook.xml');
  if (!wbText) throw new Error('不是有效的 Excel 檔（.xlsx）');
  const wb = xml(wbText).documentElement;
  const date1904 = Array.from(wb.getElementsByTagName('workbookPr')).some((e) => attr(e, 'date1904') === '1' || attr(e, 'date1904') === 'true');

  const rels = new Map<string, string>();
  const relsText = read('xl/_rels/workbook.xml.rels');
  if (relsText) for (const r of Array.from(xml(relsText).getElementsByTagName('Relationship'))) rels.set(attr(r, 'Id'), attr(r, 'Target'));

  const shared: string[] = [];
  const ssText = read('xl/sharedStrings.xml');
  if (ssText) for (const si of Array.from(xml(ssText).getElementsByTagName('si'))) shared.push(textOf(si));

  const custom = new Map<number, string>();
  const xfs: number[] = [];
  const stText = read('xl/styles.xml');
  if (stText) {
    const st = xml(stText);
    for (const n of Array.from(st.getElementsByTagName('numFmt'))) custom.set(Number(attr(n, 'numFmtId')), attr(n, 'formatCode'));
    const cellXfs = Array.from(st.getElementsByTagName('cellXfs'))[0];
    if (cellXfs) for (const xf of kids(cellXfs, 'xf')) xfs.push(Number(attr(xf, 'numFmtId') || 0));
  }

  const sheets: Sheet[] = [];
  for (const s of Array.from(wb.getElementsByTagName('sheet'))) {
    if (attr(s, 'state') === 'hidden' || attr(s, 'state') === 'veryHidden') continue;
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || attr(s, 'r:id');
    let target = rels.get(rid) ?? '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const text = read(target);
    if (!text) continue;
    sheets.push(readSheet(attr(s, 'name'), xml(text), shared, xfs, custom, date1904));
  }
  if (!sheets.length) throw new Error('這個 Excel 檔沒有可以顯示的工作表');
  return sheets;
}

function readSheet(name: string, doc: Document, shared: string[], xfs: number[], custom: Map<number, string>, date1904: boolean): Sheet {
  const rows: (Cell | undefined)[][] = [];
  let truncated = false;
  for (const row of Array.from(doc.getElementsByTagName('row'))) {
    const rIdx = Number(attr(row, 'r')) - 1;
    let cIdxFallback = 0;
    for (const c of kids(row, 'c')) {
      const ref = parseRef(attr(c, 'r'));
      const r = ref?.r ?? (Number.isFinite(rIdx) ? rIdx : rows.length);
      const col = ref?.c ?? cIdxFallback;
      cIdxFallback = col + 1;
      if (r >= MAX_ROWS || col >= MAX_COLS) {
        truncated = true;
        continue;
      }
      const type = attr(c, 't');
      const vEl = kids(c, 'v')[0];
      const v = vEl?.textContent ?? '';
      let cell: Cell | undefined;
      if (type === 's') cell = { text: shared[Number(v)] ?? '', num: false };
      else if (type === 'inlineStr') cell = { text: kids(c, 'is').map(textOf).join(''), num: false };
      else if (type === 'str') cell = { text: v, num: false };
      else if (type === 'b') cell = { text: v === '1' ? 'TRUE' : 'FALSE', num: false };
      else if (type === 'e') cell = { text: v, num: false };
      else if (v !== '') {
        const n = Number(v);
        cell = Number.isFinite(n) ? { text: formatCell(n, xfs[Number(attr(c, 's') || 0)] ?? 0, custom, date1904), num: true } : { text: v, num: false };
      }
      if (cell && cell.text !== '') (rows[r] ??= [])[col] = cell;
    }
  }
  const merges = Array.from(doc.getElementsByTagName('mergeCell')).map((m) => parseRange(attr(m, 'ref'))).filter((m): m is NonNullable<typeof m> => !!m);
  const colWidths = new Map<number, number>();
  for (const col of Array.from(doc.getElementsByTagName('col'))) {
    const w = Number(attr(col, 'width'));
    for (let i = Number(attr(col, 'min')) - 1; i < Math.min(Number(attr(col, 'max')), MAX_COLS); i++) if (w > 0) colWidths.set(i, w);
  }
  return { name, rows, merges, colWidths, truncated };
}

function tableOf(sheet: Sheet): HTMLElement {
  const nRows = Math.min(Math.max(sheet.rows.length, 1), MAX_ROWS);
  let nCols = 1;
  for (const r of sheet.rows) if (r) nCols = Math.max(nCols, r.length);
  for (const m of sheet.merges) nCols = Math.max(nCols, Math.min(m.c2 + 1, MAX_COLS));
  nCols = Math.min(nCols, MAX_COLS);

  // merged areas: the top-left cell spans, the others are not drawn
  const spans = new Map<string, { rs: number; cs: number }>();
  const covered = new Set<string>();
  for (const m of sheet.merges) {
    if (m.r1 >= nRows || m.c1 >= nCols) continue;
    spans.set(`${m.r1},${m.c1}`, { rs: Math.min(m.r2, nRows - 1) - m.r1 + 1, cs: Math.min(m.c2, nCols - 1) - m.c1 + 1 });
    for (let r = m.r1; r <= Math.min(m.r2, nRows - 1); r++) for (let c = m.c1; c <= Math.min(m.c2, nCols - 1); c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r},${c}`);
  }

  const head = h('tr', null, h('th', { class: 'corner' }));
  for (let c = 0; c < nCols; c++) {
    const w = sheet.colWidths.get(c);
    head.append(h('th', { style: w ? `min-width:${Math.round(w * 7)}px` : '' }, colName(c)));
  }
  const body: HTMLElement[] = [];
  for (let r = 0; r < nRows; r++) {
    const tr = h('tr', null, h('th', { class: 'rowhead' }, String(r + 1)));
    for (let c = 0; c < nCols; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = sheet.rows[r]?.[c];
      const span = spans.get(`${r},${c}`);
      tr.append(h('td', { class: cell?.num ? 'num' : '', rowspan: span && span.rs > 1 ? span.rs : null, colspan: span && span.cs > 1 ? span.cs : null }, cell?.text ?? ''));
    }
    body.push(tr);
  }
  return h('table', { class: 'sheet' }, h('thead', null, head), h('tbody', null, ...body));
}

export async function renderXlsx(box: HTMLElement, data: Uint8Array): Promise<() => void> {
  const sheets = readWorkbook(data);
  const holder = h('div', { class: 'xlsx-view' });
  const tabs = h('div', { class: 'sheet-tabs', role: 'tablist' });
  const grid = h('div', { class: 'sheet-grid' });
  const note = h('p', { class: 'note' });
  const show = (i: number) => {
    tabs.querySelectorAll('button').forEach((b, j) => {
      b.classList.toggle('on', i === j);
      b.setAttribute('aria-selected', String(i === j));
    });
    grid.replaceChildren(tableOf(sheets[i]));
    note.textContent = sheets[i].truncated ? `工作表很大，只顯示前 ${MAX_ROWS} 列、${MAX_COLS} 欄。` : '';
    note.hidden = !sheets[i].truncated;
    grid.scrollTo(0, 0);
  };
  sheets.forEach((s, i) => tabs.append(h('button', { type: 'button', role: 'tab', class: 'btn small', onclick: () => show(i) }, s.name || `工作表${i + 1}`)));
  holder.append(note, grid, tabs);
  box.append(holder);
  show(0);
  return () => holder.remove();
}

export { formatGeneral };
