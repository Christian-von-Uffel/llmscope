// Short IDs, six characters of base62: 62^6 = 56,800,235,584 possible values.
//
// Two kinds come out of here and they name different things. `shortId` is content-addressed — the same canonical
// text always hashes to the same ID — and is what an eval's spec is filed under, so the same question asked the
// same way is one file in evals/, however often it is run. `freshId` is minted, never repeated: every run of an
// eval is a new generation with its own replies, so it gets its own ID, its own results file and its own card,
// and running the same eval twice leaves two runs on disk rather than the second written over the first.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 6;

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base62(n, length) {
  let out = '';
  const base = BigInt(ALPHABET.length);
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(n % base)] + out;
    n = n / base;
  }
  return out;
}

/** Content-addressed: the same text gives the same ID. */
export async function shortId(text, length = ID_LENGTH) {
  const hex = await sha256Hex(text);
  const n = BigInt('0x' + hex.slice(0, 16)); // first 64 bits
  const space = BigInt(ALPHABET.length) ** BigInt(length);
  return base62(n % space, length);
}

/** Random bytes as hex, from the same crypto both Node and the browser expose. */
function nonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A new ID every call. `seed` — the eval's own ID, say — is folded in so the ID is still tied to what it names,
 * but the moment and a random nonce are folded in with it, so two runs of one eval never share an ID.
 */
export async function freshId(seed = '', length = ID_LENGTH) {
  return shortId(`${seed}\n${Date.now()}\n${nonce()}`, length);
}

export function isValidId(s, length = ID_LENGTH) {
  return typeof s === 'string' && s.length === length && [...s].every((c) => ALPHABET.includes(c));
}
