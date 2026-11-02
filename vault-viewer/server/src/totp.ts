// One-time codes from authenticator apps (Google Authenticator, Microsoft Authenticator, 1Password…):
// TOTP as in RFC 6238 — HMAC-SHA1, 6 digits, 30-second steps — plus one-time recovery codes.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const STEP_SECONDS = 30;

/** The code for one 30-second step (`digits` is 6 for apps; the RFC's test vectors use 8). */
export async function totpAt(secret: Uint8Array, step: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = n & 255;
    n = Math.floor(n / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code, allowing one step of clock drift either way. Returns the step it matched (so the
 * caller can refuse the same code twice), or null.
 */
export async function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep = -1): Promise<number | null> {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(nowMs / 1000 / STEP_SECONDS);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    if ((await totpAt(secret, step)) === c) return step;
  }
  return null;
}

export function newTotpSecret(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return base32Encode(b);
}

/** The address authenticator apps read from the QR code. */
export const otpauthUrl = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

/** Ten codes like "K7QD-M2XA" for when the phone is lost; each works once. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const b = new Uint8Array(5);
    crypto.getRandomValues(b);
    const s = base32Encode(b);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}

export const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '');

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
