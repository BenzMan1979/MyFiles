// Small pieces shared by the server modules: storage interface, JSON responses, request parsing.

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, range',
  'access-control-expose-headers': 'content-range, content-length',
  'access-control-max-age': '86400',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
}

export const fail = (status: number, code: string, message: string, extra: object = {}) => json({ ok: false, code, message, ...extra }, status);

export const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export class BadRequest extends Error {}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new BadRequest('請求格式錯誤');
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export function randomToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small self-contained page (used for the end of the Google sign-in, which happens in a browser tab). */
export function htmlPage(title: string, message: string, ok: boolean): Response {
  const page = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.7 system-ui,"Microsoft JhengHei","PingFang TC",sans-serif;background:#111318;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.card{max-width:520px;background:#1b1e26;border:1px solid #2c303b;border-radius:14px;padding:28px}h1{font-size:22px;margin:0 0 8px;color:${ok ? '#5fd38d' : '#ff7a7a'}}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  return new Response(page, {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
  });
}
