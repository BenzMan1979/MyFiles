// How Excel shows a cell: cell references, date serials and the common number formats.
// Pure functions (no DOM) so they can be unit tested. Covers what people actually use; an unusual
// format falls back to the plain number rather than failing.

export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "AB12" → { r: 11, c: 27 } (zero based) */
export function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null;
}

/** "A1:C3" → bounds, or a single cell */
export function parseRange(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const [a, b = a] = ref.split(':');
  const p = parseRef(a);
  const q = parseRef(b);
  return p && q ? { r1: p.r, c1: p.c, r2: q.r, c2: q.c } : null;
}

export interface DateParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** Excel's serial number → calendar parts (handles its 1900 leap-year bug and the 1904 system). */
export function serialToDate(serial: number, date1904 = false): DateParts {
  let days = Math.floor(serial);
  let frac = serial - days;
  let secs = Math.round(frac * 86400);
  if (secs >= 86400) {
    secs = 0;
    days += 1;
  }
  let ms: number;
  if (date1904) ms = Date.UTC(1904, 0, 1) + days * 86400000;
  else {
    if (days > 59) days -= 1; // serial 60 is the non-existent 1900-02-29
    ms = Date.UTC(1899, 11, 31) + days * 86400000;
  }
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: Math.floor(secs / 3600), mi: Math.floor((secs % 3600) / 60), s: secs % 60 };
}

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

const BUILTIN_FORMATS: Record<number, string> = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm',
  37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0',
};

/** Drops quoted text, escapes and [..] parts so what is left only shows the format's letters. */
function bare(code: string): string {
  return code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, (m) => (/^\[(h+|m+|s+)\]$/i.test(m) ? m.slice(1, -1) : '')).replace(/_./g, '').replace(/\*./g, '');
}

export function formatCodeOf(numFmtId: number, custom: Map<number, string>): string {
  return custom.get(numFmtId) ?? BUILTIN_FORMATS[numFmtId] ?? 'General';
}

export function isDateFormat(numFmtId: number, code: string): boolean {
  if (isCustomCode(code)) return /[ymdhs]/i.test(bare(code.split(';')[0]));
  return BUILTIN_DATE_IDS.has(numFmtId);
}
/** Anything that is not just digits, separators and a percent sign. */
const isCustomCode = (code: string) => code !== 'General' && !/^[0#?,.%+\-E ]*$/.test(code);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = (n: number) => String(n).padStart(2, '0');

export function formatDate(serial: number, code: string, date1904 = false): string {
  const t = serialToDate(serial, date1904);
  const section = code.split(';')[0];
  const twelve = /AM\/PM|A\/P/i.test(section);
  type Tok = { k: string; v: string };
  const toks: Tok[] = [];
  for (let i = 0; i < section.length; ) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      toks.push({ k: 'lit', v: section.slice(i + 1, end < 0 ? section.length : end) });
      i = end < 0 ? section.length : end + 1;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      if (ch === '\\') toks.push({ k: 'lit', v: section[i + 1] ?? '' });
      i += 2;
    } else if (ch === '[') {
      const end = section.indexOf(']', i);
      const inner = section.slice(i + 1, end < 0 ? section.length : end);
      if (/^(h+|m+|s+)$/i.test(inner)) toks.push({ k: inner[0].toLowerCase(), v: inner });
      i = end < 0 ? section.length : end + 1;
    } else if (/AM\/PM|A\/P/i.test(section.slice(i, i + 5))) {
      const m = /^(AM\/PM|A\/P)/i.exec(section.slice(i))!;
      toks.push({ k: 'ampm', v: m[1] });
      i += m[1].length;
    } else if (/[ymdhs]/i.test(ch)) {
      let j = i;
      while (j < section.length && section[j].toLowerCase() === ch.toLowerCase()) j++;
      toks.push({ k: ch.toLowerCase(), v: section.slice(i, j) });
      i = j;
    } else {
      toks.push({ k: 'lit', v: ch });
      i++;
    }
  }
  const out: string[] = [];
  toks.forEach((tk, idx) => {
    const n = tk.v.length;
    switch (tk.k) {
      case 'y': out.push(n <= 2 ? p2(t.y % 100) : String(t.y)); break;
      case 'd': {
        const w = DAYS[new Date(Date.UTC(t.y, t.mo - 1, t.d)).getUTCDay()];
        out.push(n === 1 ? String(t.d) : n === 2 ? p2(t.d) : n === 3 ? w.slice(0, 3) : w);
        break;
      }
      case 'h': out.push(twelve ? (n === 1 ? String((t.h % 12) || 12) : p2((t.h % 12) || 12)) : n === 1 ? String(t.h) : p2(t.h)); break;
      case 's': out.push(n === 1 ? String(t.s) : p2(t.s)); break;
      case 'ampm': out.push(t.h < 12 ? 'AM' : 'PM'); break;
      case 'm': {
        // "m" is a minute right after an hour or right before a second, otherwise a month
        const prev = toks.slice(0, idx).reverse().find((x) => x.k !== 'lit');
        const next = toks.slice(idx + 1).find((x) => x.k !== 'lit');
        if (prev?.k === 'h' || next?.k === 's') out.push(n === 1 ? String(t.mi) : p2(t.mi));
        else out.push(n === 1 ? String(t.mo) : n === 2 ? p2(t.mo) : n === 3 ? MONTHS[t.mo - 1].slice(0, 3) : MONTHS[t.mo - 1]);
        break;
      }
      default: out.push(tk.v);
    }
  });
  const text = out.join('');
  // a day-of-week or other token we do not know produced nothing: fall back to a plain date
  return text.trim() === '' ? `${t.y}-${p2(t.mo)}-${p2(t.d)}` : text;
}

function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** General format: what Excel shows for an unformatted number (up to 15 significant digits). */
export function formatGeneral(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const s = String(parseFloat(v.toPrecision(15)));
  return s.includes('e') ? v.toExponential(5).replace(/\.?0+e/, 'e') : s;
}

export function formatNumber(v: number, code: string): string {
  if (code === 'General' || code === '' || code === '@') return formatGeneral(v);
  const sections = code.split(';');
  const negative = v < 0 && sections.length > 1;
  const section = (negative ? sections[1] : v === 0 && sections.length > 2 ? sections[2] : sections[0]).replace(/\[[^\]]*\]/g, '').replace(/_./g, '').replace(/\*./g, '');
  const first = section.search(/[0#?]/);
  if (first < 0) return section.replace(/"/g, '') || formatGeneral(v); // a text-only format
  const last = Math.max(section.lastIndexOf('0'), section.lastIndexOf('#'), section.lastIndexOf('?'));
  const clean = (s: string) => s.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1');
  const prefix = clean(section.slice(0, first));
  const suffix = clean(section.slice(last + 1));
  const body = section.slice(first, last + 1);
  const percent = /%/.test(section);
  let n = Math.abs(v) * (percent ? 100 : 1);
  if (!negative && v < 0) n = Math.abs(n);
  const mantissa = /E[+-]/i.test(body) ? body.split(/E/i)[0] : body; // "0.00E+00": only the part before E has decimals
  const dot = mantissa.indexOf('.');
  const decimals = dot < 0 ? 0 : mantissa.slice(dot + 1).replace(/[^0#?]/g, '').length;
  let text: string;
  if (/E[+-]/i.test(section)) {
    text = n.toExponential(decimals).replace('e', 'E').replace(/E([+-])(\d)$/, 'E$10$2');
  } else {
    text = n.toFixed(decimals);
    if (body.includes(',')) {
      const [i, f] = text.split('.');
      text = groupThousands(i) + (f ? `.${f}` : '');
    }
    if (dot >= 0 && /#$/.test(body)) text = text.replace(/\.?0+$/, ''); // optional decimals
  }
  const sign = v < 0 && !negative ? '-' : '';
  return `${sign}${prefix}${text}${suffix}${percent && !suffix.includes('%') ? '%' : ''}`;
}

export function formatCell(v: number, numFmtId: number, custom: Map<number, string>, date1904 = false): string {
  const code = formatCodeOf(numFmtId, custom);
  if (isDateFormat(numFmtId, code)) return formatDate(v, code, date1904);
  return formatNumber(v, code);
}
