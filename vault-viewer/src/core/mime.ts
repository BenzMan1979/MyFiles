const EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  md: 'text/markdown', markdown: 'text/markdown',
  html: 'text/html', htm: 'text/html',
  json: 'application/json', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml', ini: 'text/plain',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
  css: 'text/css', py: 'text/x-python', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++',
  cs: 'text/x-csharp', go: 'text/x-go', rs: 'text/x-rust', rb: 'text/x-ruby', php: 'text/x-php', sh: 'text/x-shellscript',
  sql: 'text/x-sql', bat: 'text/plain', ps1: 'text/plain', kt: 'text/plain', swift: 'text/plain', vue: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
};

export const extOf = (path: string) => (path.match(/\.([^./\\]+)$/)?.[1] ?? '').toLowerCase();

export function guessMime(path: string, browserType = ''): string {
  return EXT[extOf(path)] ?? (browserType || 'application/octet-stream');
}

export type FileKind = 'pdf' | 'image' | 'video' | 'audio' | 'markdown' | 'html' | 'text' | 'docx' | 'xlsx' | 'slides' | 'other';

export function kindOf(path: string, mime: string): FileKind {
  const ext = extOf(path);
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/html') return 'html';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'pptx' || ext === 'ppt') return 'slides';
  return 'other';
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
