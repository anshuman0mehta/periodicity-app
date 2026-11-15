// Blob cache in IndexedDB, keyed by git blob sha. Blobs are immutable, so the
// cache never goes stale; it holds the bytes exactly as they are in git
// (private files stay encrypted at rest and are decrypted on each load).

const DB = "periodicity";
const STORE = "blobs";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class IdbCache {
  constructor() { this.db = open(); this.mem = new Map(); }
  async get(sha) {
    if (this.mem.has(sha)) return this.mem.get(sha);
    try {
      const v = await tx(await this.db, "readonly", (s) => s.get(sha));
      if (v) this.mem.set(sha, new Uint8Array(v));
      return v ? new Uint8Array(v) : null;
    } catch { return null; }
  }
  async put(sha, bytes) {
    this.mem.set(sha, bytes);
    try { await tx(await this.db, "readwrite", (s) => s.put(bytes, sha)); } catch { /* memory only */ }
  }
  async clear() {
    this.mem.clear();
    try { await tx(await this.db, "readwrite", (s) => s.clear()); } catch {}
  }
}
