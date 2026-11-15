// The data repo, read and written through GitHub's Git Data API.
//
// pull():   ref → commit → recursive tree → blobs (cached by sha, so only
//           changed files are fetched) → decrypt git-crypt files → parse.
// commit(): run an op on the current snapshot, write blobs (encrypting
//           private paths), a tree, a commit on the current head, then move
//           the branch with force=false. If another machine pushed first the
//           ref update is refused; pull and run the op again on the new
//           snapshot. That is `git pull --rebase` for a single op, and why ops
//           are functions of a snapshot rather than patches.

import * as iss from "./issue.js";
import * as gc from "./gitcrypt.js";
import { parseConfig } from "./ops.js";

const ISSUE_DIRS = ["issues/", "private/", "archive/", "archive/private/"];
const CONFIG = ".periodicity/config.toml";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export class Conflict extends Error {}
export class Locked extends Error {}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function isIssuePath(path) {
  if (!path.endsWith(".md")) return false;
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return ISSUE_DIRS.includes(dir);
}

/** GitHub REST, for the browser. Errors carry .status. */
export function githubApi(token, base = "https://api.github.com") {
  return async (method, path, body) => {
    let r;
    try {
      r = await fetch(base + path, {
        method, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error("offline: " + e.message); err.offline = true; throw err;
    }
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).message || msg; } catch {}
      const err = new Error(`GitHub ${r.status}: ${msg}`); err.status = r.status; throw err;
    }
    return r.status === 204 ? null : r.json();
  };
}

/** A blob cache keyed by sha; blobs never change, so entries never go stale. */
export class MemoryCache {
  constructor() { this.m = new Map(); }
  async get(sha) { return this.m.get(sha) || null; }
  async put(sha, bytes) { this.m.set(sha, bytes); }
  async keys() { return [...this.m.keys()]; }
  async remove(sha) { this.m.delete(sha); }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export class Store {
  constructor({ api, cache = new MemoryCache(), owner, repo, branch = "main" }) {
    Object.assign(this, { api, cache, owner, repo, branch });
    this.keys = null;           // git-crypt CryptoKeys, once a key is added
    this.head = null;
    this.treeSha = null;
    this.tree = new Map();      // path → blob sha, every file in the repo
    this.issues = new Map();    // id → Issue (path is repo-relative)
    this.configText = "";
    this.config = {};
    this.problems = [];         // files that could not be read
    this.knownNames = [];       // file names seen before, so ids are never reused
  }

  get base() { return `/repos/${this.owner}/${this.repo}`; }

  async setKey(keyFileBytes) {
    this.keys = keyFileBytes ? await gc.importKey(gc.parseKeyFile(keyFileBytes)) : null;
    this.head = null;           // re-read so locked files open
  }

  async blob(sha) {
    let bytes = await this.cache.get(sha);
    if (!bytes) {
      const b = await this.api("GET", `${this.base}/git/blobs/${sha}`);
      bytes = fromBase64(b.content);
      await this.cache.put(sha, bytes);
    }
    return bytes;
  }

  async text(path, bytes) {
    if (gc.isEncrypted(bytes)) {
      if (!this.keys) throw new Locked(path);
      bytes = await gc.decrypt(this.keys, bytes);
    }
    return dec.decode(bytes);
  }

  /** Read the branch. Returns false if nothing changed since the last pull. */
  async pull({ force = false } = {}) {
    const ref = await this.api("GET", `${this.base}/git/ref/heads/${this.branch}`);
    const head = ref.object.sha;
    if (head === this.head && !force) return false;
    const commit = await this.api("GET", `${this.base}/git/commits/${head}`);
    const t = await this.api("GET", `${this.base}/git/trees/${commit.tree.sha}?recursive=1`);
    if (t.truncated) throw new Error("the data repo's tree is too large for one API call");
    const tree = new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
    await this.build(head, commit.tree.sha, tree);
    return true;
  }

  /** What to keep between launches, to open offline from the blob cache. */
  exportState() {
    return { head: this.head, treeSha: this.treeSha, tree: [...this.tree], knownNames: this.knownNames };
  }

  async loadState(state) {
    if (!state || !state.head) return false;
    this.knownNames = state.knownNames || [];
    await this.build(state.head, state.treeSha, new Map(state.tree));
    return true;
  }

  async build(head, treeSha, tree) {
    const wanted = [...tree.keys()].filter((p) => isIssuePath(p) || p === CONFIG);
    const issues = new Map();
    const problems = [];
    let configText = "";
    await pool(wanted, 8, async (path) => {
      const bytes = await this.blob(tree.get(path));
      if (path === CONFIG) { configText = dec.decode(bytes); return; }
      try {
        const issue = iss.parse(await this.text(path, bytes), path);
        issue.path = path;
        if (issues.has(issue.id)) problems.push(`duplicate id ${issue.id}: ${issues.get(issue.id).path} and ${path}`);
        else issues.set(issue.id, issue);
      } catch (e) {
        if (e instanceof Locked) {
          const issue = lockedIssue(path);
          if (issue) issues.set(issue.id, issue);
        } else {
          problems.push(`${path}: ${e.message}`);
        }
      }
    });
    Object.assign(this, { head, treeSha, tree, issues, problems, configText, config: parseConfig(configText) });
  }

  /** Show an op's result before it is committed (queued while offline). The
   *  next pull replaces it with what is really on the branch. */
  applyLocal(op, args) {
    const { changes, result } = op(this.snapshot(), args);
    for (const c of changes) {
      if (c.delete) { for (const [id, i] of this.issues) if (i.path === c.path) this.issues.delete(id); continue; }
      if (c.path === CONFIG) { this.configText = c.text; this.config = parseConfig(c.text); continue; }
      const issue = iss.parse(c.text, c.path);
      issue.path = c.path;
      issue.pending = true;
      this.issues.set(issue.id, issue);
    }
    return result;
  }

  snapshot() {
    return { issues: this.issues, paths: [...this.tree.keys()], knownNames: this.knownNames,
      config: this.config, configText: this.configText };
  }

  /** Run op(snapshot, args) and commit what it returns; retry on a newer head. */
  async commit(op, args, { attempts = 4 } = {}) {
    if (!this.head) await this.pull();
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await this.pull();
      const { changes, message, result } = op(this.snapshot(), args);
      if (!changes.length) return { result, sha: null };
      const entries = [];
      const written = [];
      for (const c of changes) {
        if (c.delete) {
          if (this.tree.has(c.path)) entries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
          continue;
        }
        let bytes = enc.encode(c.text);
        if (gc.isCryptPath(c.path)) {
          if (!this.keys) throw new Locked(`${c.path} must be encrypted; add the git-crypt key in Settings`);
          bytes = await gc.encrypt(this.keys, bytes);
        }
        const b = await this.api("POST", `${this.base}/git/blobs`, { content: toBase64(bytes), encoding: "base64" });
        await this.cache.put(b.sha, bytes);
        entries.push({ path: c.path, mode: "100644", type: "blob", sha: b.sha });
        written.push([c, b.sha]);
      }
      const tree = await this.api("POST", `${this.base}/git/trees`, { base_tree: this.treeSha, tree: entries });
      const commit = await this.api("POST", `${this.base}/git/commits`, { message, tree: tree.sha, parents: [this.head] });
      try {
        await this.api("PATCH", `${this.base}/git/refs/heads/${this.branch}`, { sha: commit.sha, force: false });
      } catch (e) {
        if (e.status === 422 || e.status === 409) continue;     // someone pushed first: rebase the op
        throw e;
      }
      // apply locally, without another round trip
      this.head = commit.sha;
      this.treeSha = tree.sha;
      for (const c of changes) {
        if (!c.delete) continue;
        for (const [id, i] of this.issues) if (i.path === c.path) this.issues.delete(id);
        this.knownNames.push(c.path.split("/").pop());
        this.tree.delete(c.path);
      }
      for (const [c, sha] of written) {
        this.tree.set(c.path, sha);
        if (c.path === CONFIG) { this.configText = c.text; this.config = parseConfig(c.text); continue; }
        const issue = iss.parse(c.text, c.path);
        issue.path = c.path;
        this.issues.set(issue.id, issue);
      }
      return { result: this.issues.get(result?.id) || result, sha: commit.sha };
    }
    throw new Conflict("the data repo kept changing under this edit; try again");
  }
}

/** A placeholder for an encrypted issue, from its file name alone. */
function lockedIssue(path) {
  const name = path.split("/").pop().replace(/\.md$/, "");
  const m = /^(\S+) (.*)$/.exec(name);
  if (!m) return null;
  const issue = new iss.Issue({ id: m[1], title: m[2].replace(/-/g, " "), status: path.startsWith("archive/") ? "archived" : "todo",
    private: true }, "", path);
  issue.locked = true;
  return issue;
}
