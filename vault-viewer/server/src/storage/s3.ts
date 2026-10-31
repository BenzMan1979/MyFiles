// S3-compatible object storage: Cloudflare R2, Backblaze B2, Wasabi, MinIO, Amazon S3.
//   config.endpoint         https://<account id>.r2.cloudflarestorage.com   (R2)
//                           https://s3.<region>.backblazeb2.com             (B2)
//   config.region           "auto" for R2; the bucket's region elsewhere
//   config.bucket
//   config.accessKeyId / config.secretAccessKey
//   config.prefix           key prefix for the vaults, default "vault-viewer"
// Layout: <prefix>/<vaultId>/<00000.bin, …>; refs are the object keys. Requests are signed with AWS
// Signature V4; uploads use UNSIGNED-PAYLOAD so a 32 MB part is not hashed (HTTPS protects it).

import { encodePath, httpError, partName, StorageError, SUBREQUEST_BUDGET, type Adapter, type AdapterDeps, type StorageProfile } from './types';

const enc = new TextEncoder();
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmacRaw(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

export interface SigV4Input {
  method: string;
  url: string;
  /** headers to sign besides host / x-amz-date / x-amz-content-sha256 (lower-case names) */
  headers?: Record<string, string>;
  payloadHash?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  /** e.g. 20130524T000000Z */
  amzDate: string;
}

/** Returns the headers to send (authorization included). Exported for the test against AWS's published example. */
export async function signV4(i: SigV4Input): Promise<Record<string, string>> {
  const u = new URL(i.url);
  const service = i.service ?? 's3';
  const payloadHash = i.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = { ...i.headers, host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': i.amzDate };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [i.method, u.pathname || '/', query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key = await hmacRaw(enc.encode(`AWS4${i.secretAccessKey}`), day);
  for (const part of [i.region, service, 'aws4_request']) key = await hmacRaw(key, part);
  const signature = hex(await hmacRaw(key, toSign));
  const out: Record<string, string> = { ...headers };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return out;
}

const encodeRfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const amzDateOf = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const HINTS: Record<number, string> = {
  401: '存取金鑰不正確',
  403: '存取金鑰不正確，或沒有這個儲存桶的讀寫權限',
  404: '找不到這個儲存桶（bucket），請確認名稱與端點網址',
};

export function s3Adapter(p: StorageProfile, d: AdapterDeps): Adapter {
  const endpoint = p.config.endpoint.replace(/\/+$/, '');
  const bucket = p.config.bucket;
  const prefix = (p.config.prefix ?? 'vault-viewer').replace(/^\/+|\/+$/g, '');
  const keyOf = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);
  const urlOf = (key: string) => `${endpoint}/${encodePath(bucket)}/${encodePath(key)}`;

  const send = async (method: string, key: string, init: { body?: ArrayBuffer | string; headers?: Record<string, string>; unsigned?: boolean } = {}) => {
    const url = urlOf(key);
    const headers = await signV4({
      method,
      url,
      headers: init.headers,
      payloadHash: init.unsigned ? 'UNSIGNED-PAYLOAD' : init.body === undefined ? EMPTY_SHA256 : await sha256Hex(typeof init.body === 'string' ? init.body : ''),
      accessKeyId: p.config.accessKeyId,
      secretAccessKey: p.config.secretAccessKey,
      region: p.config.region || 'auto',
      amzDate: amzDateOf(d.now()),
    });
    try {
      return await d.fetch(url, { method, body: init.body, headers });
    } catch (e) {
      throw new StorageError(`連不到儲存服務（${(e as Error).message}），請確認端點網址`);
    }
  };

  return {
    async test() {
      if (!/^https:\/\//.test(endpoint)) throw new StorageError('端點網址必須是 https:// 開頭', 'bad_config', 400);
      const key = keyOf('.vault-viewer-test');
      const body = `ok ${new Date(d.now()).toISOString()}`;
      let res = await send('PUT', key, { body, headers: { 'content-type': 'text/plain' } });
      if (!res.ok) throw await httpError('寫入測試檔', res, HINTS);
      res = await send('GET', key);
      if (!res.ok || (await res.text()) !== body) throw new StorageError('寫入的測試檔讀回來不一樣');
      await send('DELETE', key);
      return `可以讀寫儲存桶「${bucket}」`;
    },

    async prepare(vaultId) {
      return vaultId; // object storage has no folders to create
    },

    async put(container, vaultId, part, data) {
      const key = keyOf(`${container || vaultId}/${partName(part)}`);
      const res = await send('PUT', key, { body: data, unsigned: true, headers: { 'content-type': 'application/octet-stream' } });
      if (!res.ok) throw await httpError('上傳到儲存桶', res, HINTS);
      return key;
    },

    async get(ref, range) {
      return send('GET', ref, range ? { headers: { range } } : {});
    },

    async remove(_container, refs) {
      const now = refs.slice(0, SUBREQUEST_BUDGET);
      for (const key of now) {
        const res = await send('DELETE', key);
        if (!res.ok && res.status !== 404) throw await httpError('刪除儲存桶裡的檔案', res, HINTS);
      }
      return refs.slice(now.length);
    },
  };
}
