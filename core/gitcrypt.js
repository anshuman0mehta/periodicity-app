// git-crypt's file format, in WebCrypto, so the phone reads and writes the
// same ciphertext the git-crypt filter produces on the desktops.
//
// Encrypted file: "\0GITCRYPT\0" + 12-byte nonce + AES-256-CTR ciphertext.
// The nonce is the first 12 bytes of HMAC-SHA1(hmac_key, plaintext), which
// makes encryption deterministic (same plaintext → same blob → clean diffs)
// and doubles as the integrity check. The CTR counter block is the nonce
// followed by a 32-bit big-endian block counter starting at 0.
//
// Key file (`git-crypt export-key`): "\0GITCRYPTKEY" + u32 format version (2),
// header fields until field 0, then key entries; each entry is fields
// (u32 id, u32 length, bytes) until field 0: 1 = key version (u32),
// 3 = AES key (32 bytes), 5 = HMAC key (64 bytes). All integers big-endian.

const FILE_MAGIC = new Uint8Array([0, 71, 73, 84, 67, 82, 89, 80, 84, 0]);           // \0GITCRYPT\0
const KEY_MAGIC = new Uint8Array([0, 71, 73, 84, 67, 82, 89, 80, 84, 75, 69, 89]);   // \0GITCRYPTKEY
const subtle = globalThis.crypto.subtle;

export class GitCryptError extends Error {}

function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

export function isEncrypted(bytes) {
  return startsWith(bytes, FILE_MAGIC);
}

/** Parse an exported key file into { version, aes, hmac } (the newest entry). */
export function parseKeyFile(bytes) {
  bytes = new Uint8Array(bytes);
  if (!startsWith(bytes, KEY_MAGIC)) throw new GitCryptError("not a git-crypt key file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = KEY_MAGIC.length;
  const u32 = () => {
    if (pos + 4 > bytes.length) throw new GitCryptError("truncated key file");
    const v = view.getUint32(pos); pos += 4; return v;
  };
  const format = u32();
  if (format !== 2) throw new GitCryptError(`unsupported key file format ${format}`);
  for (;;) {                                   // header fields: none are defined yet
    const id = u32();
    if (id === 0) break;
    const len = u32();
    if (id & 1) throw new GitCryptError(`unknown critical header field ${id}`);
    pos += len;
  }
  const entries = [];
  while (pos < bytes.length) {
    const entry = {};
    for (;;) {
      const id = u32();
      if (id === 0) break;
      const len = u32();
      if (pos + len > bytes.length) throw new GitCryptError("truncated key file");
      const data = bytes.slice(pos, pos + len);
      pos += len;
      if (id === 1) entry.version = new DataView(data.buffer).getUint32(0);
      else if (id === 3) entry.aes = data;
      else if (id === 5) entry.hmac = data;
      else if (id & 1) throw new GitCryptError(`unknown critical key field ${id}`);
    }
    if (entry.aes && entry.hmac) entries.push(entry);
  }
  if (!entries.length) throw new GitCryptError("key file has no keys");
  entries.sort((a, b) => (b.version || 0) - (a.version || 0));
  const k = entries[0];
  if (k.aes.length !== 32 || k.hmac.length !== 64) throw new GitCryptError("unexpected key sizes");
  return k;
}

/** CryptoKeys for a parsed key, ready for encrypt/decrypt. */
export async function importKey(parsed) {
  const aes = await subtle.importKey("raw", parsed.aes, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
  const hmac = await subtle.importKey("raw", parsed.hmac, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return { aes, hmac };
}

function counter(nonce) {
  const block = new Uint8Array(16);
  block.set(nonce, 0);                          // last 4 bytes: block counter, starting at 0
  return block;
}

async function ctr(keys, nonce, data) {
  return new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter: counter(nonce), length: 32 }, keys.aes, data));
}

async function nonceFor(keys, plaintext) {
  return new Uint8Array(await subtle.sign("HMAC", keys.hmac, plaintext)).slice(0, 12);
}

export async function encrypt(keys, plaintext) {
  plaintext = new Uint8Array(plaintext);
  const nonce = await nonceFor(keys, plaintext);
  const body = await ctr(keys, nonce, plaintext);
  const out = new Uint8Array(FILE_MAGIC.length + 12 + body.length);
  out.set(FILE_MAGIC, 0);
  out.set(nonce, FILE_MAGIC.length);
  out.set(body, FILE_MAGIC.length + 12);
  return out;
}

export async function decrypt(keys, bytes) {
  bytes = new Uint8Array(bytes);
  if (!isEncrypted(bytes)) throw new GitCryptError("not a git-crypt file");
  const nonce = bytes.slice(FILE_MAGIC.length, FILE_MAGIC.length + 12);
  const plain = await ctr(keys, nonce, bytes.slice(FILE_MAGIC.length + 12));
  const check = await nonceFor(keys, plain);
  for (let i = 0; i < 12; i++) {
    if (check[i] !== nonce[i]) throw new GitCryptError("wrong key, or the file has been tampered with");
  }
  return plain;
}

/** Paths the data repo's .gitattributes sends through the git-crypt filter. */
export function isCryptPath(path) {
  if (path.endsWith("/.gitkeep")) return false;
  return path.startsWith("private/") || path.startsWith("archive/private/") || path.startsWith("legacy/");
}
