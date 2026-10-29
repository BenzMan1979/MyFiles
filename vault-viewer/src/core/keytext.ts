// Human-friendly text form of a 32-byte key: Crockford base32 + a 2-char checksum,
// grouped for easy copying, e.g. "VK1-ABCDEF-GHJKMN-...".

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'VK1';
export const KEY_BYTES = 32;

function checksum(bytes: Uint8Array): number {
  let c = 7;
  for (const b of bytes) c = (c * 31 + b) % 1021;
  return c; // < 1024, fits in two base32 chars
}

function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function decodeBase32(s: string, byteLen: number): Uint8Array | null {
  const out = new Uint8Array(byteLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (o < byteLen) out[o++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return o === byteLen ? out : null;
}

export function keyToText(key: Uint8Array): string {
  const c = checksum(key);
  const body = encodeBase32(key) + ALPHABET[c >> 5] + ALPHABET[c & 31];
  return [PREFIX, ...(body.match(/.{1,6}/g) ?? [])].join('-');
}

export type KeyParse = { ok: true; key: Uint8Array } | { ok: false; reason: 'format' | 'checksum' };

/** Accepts the text form, a whole .key file, lowercase, spaces and common look-alikes. */
export function textToKey(input: string): KeyParse {
  const m = input.toUpperCase().match(/VK[1IL][\s\-A-Z0-9]{40,}/);
  if (!m) return { ok: false, reason: 'format' };
  const s = m[0]
    .slice(PREFIX.length)
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
  const bodyLen = Math.ceil((KEY_BYTES * 8) / 5);
  if (s.length < bodyLen + 2) return { ok: false, reason: 'format' };
  const key = decodeBase32(s.slice(0, bodyLen), KEY_BYTES);
  if (!key) return { ok: false, reason: 'format' };
  const c = checksum(key);
  if (s.slice(bodyLen, bodyLen + 2) !== ALPHABET[c >> 5] + ALPHABET[c & 31]) return { ok: false, reason: 'checksum' };
  return { ok: true, key };
}

export function keyFileContent(key: Uint8Array, title: string, recipient: string): string {
  return [
    '隨身密閱 金鑰檔 — 請妥善保管，不要和封存檔、密碼放在一起傳送。',
    `封存：${title}`,
    `收件人：${recipient}`,
    '',
    keyToText(key),
    '',
  ].join('\r\n');
}

const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Readable random password such as "k7pq-9xma-3trz" (~59 bits). */
export function generatePassword(): string {
  const groups: string[] = [];
  const r = new Uint32Array(12);
  crypto.getRandomValues(r);
  for (let g = 0; g < 3; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += PW_ALPHABET[r[g * 4 + i] % PW_ALPHABET.length];
    groups.push(s);
  }
  return groups.join('-');
}

export function randomId(bytes = 10): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return encodeBase32(b).toLowerCase();
}
