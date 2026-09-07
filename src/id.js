// Content-addressed short IDs. Same canonical spec => same 6-char ID.
// 62^6 = 56,800,235,584 possible IDs.

export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const ID_LENGTH = 6;

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base62(n, length) {
  let out = '';
  const base = BigInt(ALPHABET.length);
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(n % base)] + out;
    n = n / base;
  }
  return out;
}

export async function shortId(text, length = ID_LENGTH) {
  const hex = await sha256Hex(text);
  const n = BigInt('0x' + hex.slice(0, 16)); // first 64 bits
  const space = BigInt(ALPHABET.length) ** BigInt(length);
  return base62(n % space, length);
}

export function isValidId(s, length = ID_LENGTH) {
  return typeof s === 'string' && s.length === length && [...s].every((c) => ALPHABET.includes(c));
}
