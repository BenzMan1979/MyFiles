import { argon2id } from 'hash-wasm';
import { buf, concat, utf8 } from './bytes';

export interface KdfParams {
  alg: 'argon2id';
  /** memory in KiB */
  m: number;
  t: number;
  p: number;
}

export const DEFAULT_KDF: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

export interface DerivedKeys {
  /** Proves knowledge of password + key file to the server; the server stores it as a verifier. */
  authKey: Uint8Array;
  /** Encrypts the manifest and every file. Needs the server share in online mode. */
  contentKey: CryptoKey;
}

/** Slow step (Argon2id). */
export async function derivePasswordKey(password: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  return argon2id({
    password: password.normalize('NFC'),
    salt,
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
}

async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(utf8(info)) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** authKey = HKDF(pwKey ‖ keyfile, "auth"); never reveals pwKey or keyfile. */
export function deriveAuthKey(pwKey: Uint8Array, keyfile: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return hkdfBits(concat(pwKey, keyfile), salt, 'vault-viewer/v1/auth');
}

/** contentKey = HKDF(pwKey ‖ keyfile ‖ serverShare, "content"); offline vaults have no share. */
export async function deriveContentKey(
  pwKey: Uint8Array,
  keyfile: Uint8Array,
  serverShare: Uint8Array | null,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const raw = await hkdfBits(concat(pwKey, keyfile, serverShare ?? new Uint8Array(0)), salt, 'vault-viewer/v1/content');
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesEncrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(data));
  return new Uint8Array(ct);
}

/** Throws on a wrong key or tampered data. */
export async function aesDecrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(data));
  return new Uint8Array(pt);
}

export async function hmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(message)));
}

/** The message the viewer signs to open a vault; shared with the server. */
export const openProofMessage = (vaultId: string, nonce: string): Uint8Array => utf8(`vault-viewer/v1/open:${vaultId}:${nonce}`);
