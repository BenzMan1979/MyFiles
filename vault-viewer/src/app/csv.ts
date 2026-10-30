// Recipient list import: parsing, a downloadable template, and what Excel actually produces.

export interface ImportedRecipient {
  name: string;
  /** empty = generate one */
  password: string;
  note: string;
}

export interface ImportResult {
  recipients: ImportedRecipient[];
  warnings: string[];
  skipped: number;
}

export interface ImportLimits {
  maxRecipients: number;
  minPassword: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = { maxRecipients: 500, minPassword: 6 };

/** Excel on Traditional Chinese Windows saves plain "CSV" as Big5, so UTF-8 is tried first and Big5 is the fallback. */
export function decodeCsv(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('big5').decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
  }
  return text.replace(/^﻿/, '');
}

/** RFC 4180 style: quoted fields, doubled quotes, CRLF or LF; comma, semicolon or tab separated. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const NAME_KEYS = ['名稱', '姓名', '名字', '收件人', 'name', 'recipient'];
const PASSWORD_KEYS = ['密碼', 'password', 'pw', 'pass'];
const NOTE_KEYS = ['備註', '電腦名稱', '電腦', '裝置', '部門', 'note', 'notes', 'device'];

export function parseRecipients(text: string, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): ImportResult {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  const recipients: ImportedRecipient[] = [];
  if (!rows.length) return { recipients, warnings: ['檔案裡沒有任何資料'], skipped: 0 };

  const head = rows[0].map((h) => h.trim().toLowerCase());
  const find = (keys: string[]) => head.findIndex((h) => keys.includes(h));
  const hasHeader = find(NAME_KEYS) >= 0;
  const col = hasHeader
    ? { name: find(NAME_KEYS), password: find(PASSWORD_KEYS), note: find(NOTE_KEYS) }
    : { name: 0, password: 1, note: 2 };
  const first = hasHeader ? 1 : 0;
  const seen = new Set<string>();
  let skipped = 0;

  for (let i = first; i < rows.length; i++) {
    const line = i + 1;
    const cell = (c: number) => (c >= 0 ? (rows[i][c] ?? '').trim() : '');
    const name = cell(col.name);
    if (!name) {
      warnings.push(`第 ${line} 列沒有名稱，已略過`);
      skipped++;
      continue;
    }
    if (name.length > 100) {
      warnings.push(`第 ${line} 列的名稱超過 100 個字，已略過`);
      skipped++;
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`第 ${line} 列的「${name}」重複，已略過`);
      skipped++;
      continue;
    }
    if (recipients.length >= limits.maxRecipients) {
      warnings.push(`一次最多 ${limits.maxRecipients} 位收件人，第 ${line} 列之後都已略過`);
      skipped += rows.length - i;
      break;
    }
    seen.add(name);
    let password = cell(col.password);
    if (password && password.length < limits.minPassword) {
      warnings.push(`第 ${line} 列「${name}」的密碼少於 ${limits.minPassword} 個字元，已改為自動產生`);
      password = '';
    }
    recipients.push({ name, password, note: cell(col.note).slice(0, 100) });
  }
  return { recipients, warnings, skipped };
}

/** UTF-8 with a BOM so Excel opens the Chinese text correctly. */
export function templateCsv(): string {
  return (
    '﻿' +
    [
      '名稱,密碼,備註',
      '王小明,,財務部 NB-0123',
      '陳小華,my-pass-2026,業務部',
      '林小美,,',
    ].join('\r\n') +
    '\r\n'
  );
}
