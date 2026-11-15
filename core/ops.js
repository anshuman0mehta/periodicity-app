// Every change the phone can make, as a pure function of a snapshot of the
// data repo. A port of periodicity/ops.py, store.py and dashboard.py's
// journal. Each op returns { changes, message, result }: the files to write
// (or delete) and the commit message, so the store can re-run it on a newer
// snapshot when another machine pushed first — the API equivalent of
// `git pull --rebase`.
//
// Nothing here deletes an issue: a path is only removed when its issue is
// written to a new path (renamed title, privacy or archive move).

import * as iss from "./issue.js";
import { iso, monthTitle, dayHeading, hhmm } from "./time.js";
import { isCryptPath } from "./gitcrypt.js";

export const MACHINE = "iphone";
export const DEFAULT_PREFIX = "P-I-";
const LIVE_DIRS = { false: "issues", true: "private" };
const ARCHIVE_DIRS = { false: "archive", true: "archive/private" };
const PROTECTED = new Set(["id", "created", "updated"]);

export class OpError extends Error {}
export class StaleEdit extends OpError {}

// ---------------------------------------------------------------- config.toml

/** The small TOML subset config.toml uses: [sections] and `"key" = "value"`. */
export function parseConfig(text) {
  const out = {};
  let section = out;
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    let m = /^\[([^\]]+)\]$/.exec(line);
    if (m) { section = out[m[1].trim()] = out[m[1].trim()] || {}; continue; }
    m = /^("([^"]*)"|[A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[2] !== undefined ? m[2] : m[1];
    let v = m[3];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (v === "true" || v === "false") v = v === "true";
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    section[key] = v;
  }
  return out;
}

export function prefix(snap) {
  const machines = snap.config.machines;
  if (!machines || !(MACHINE in machines)) {
    throw new OpError("This phone has no id prefix yet. Register it in Settings before creating issues.");
  }
  return machines[MACHINE];
}

// ---------------------------------------------------------------- helpers

function get(snap, id) {
  const wanted = String(id || "").trim().toUpperCase();
  const issue = snap.issues.get(wanted);
  if (!issue) throw new OpError(`no issue ${id}`);
  if (issue.locked) throw new OpError(`${wanted} is encrypted; add the git-crypt key in Settings to edit it`);
  return issue.clone();
}

/** Private by its header, or by where it already lives: the phone never
 *  moves a file out of an encrypted folder on its own. */
export function isPrivate(issue) {
  return issue.private || Boolean(issue.path && isCryptPath(issue.path));
}

export function pathFor(issue) {
  const dirs = issue.status === "archived" ? ARCHIVE_DIRS : LIVE_DIRS;
  return `${dirs[isPrivate(issue)]}/${iss.fileName(issue)}`;
}

/** Write the issue, moving its file if title, status or privacy changed. */
function save(issue, { touch = true, now } = {}) {
  if (touch) issue.meta.updated = iso(now);
  const target = pathFor(issue);
  const changes = [{ path: target, text: iss.render(issue) }];
  if (issue.path && issue.path !== target) changes.push({ path: issue.path, delete: true });
  issue.path = target;
  return changes;
}

function nextId(snap) {
  const p = prefix(snap);
  const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)(?: |\\.md$)");
  let highest = 0;
  for (const path of [...snap.paths, ...(snap.knownNames || [])]) {
    const m = re.exec(path.split("/").pop());
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `${p}${String(highest + 1).padStart(4, "0")}`;
}

function check(meta) {
  if (!iss.STATUSES.includes(meta.status)) throw new OpError(`status must be one of ${iss.STATUSES.join(", ")}`);
  if (!iss.PRIORITIES.includes(meta.priority)) throw new OpError(`priority must be one of ${iss.PRIORITIES.join(", ")}`);
}

const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- ops

export function addLog(snap, { id, kind, text, when }) {
  const issue = get(snap, id);
  if (!oneLine(text)) throw new OpError("a log entry needs some text");
  issue.body = iss.appendLog(issue.body, kind, text, when);
  return { changes: save(issue), message: `${issue.id}: log ${kind.toUpperCase()}`, result: issue };
}

export function append(snap, { id, text, section = null }) {
  const issue = get(snap, id);
  if (!String(text || "").trim()) throw new OpError("nothing to add");
  issue.body = iss.appendText(issue.body, text, section);
  return { changes: save(issue), message: `${issue.id}: append` + (section ? ` to ${section}` : ""), result: issue };
}

/** Tick by the item's text and which occurrence of it, not by position, so a
 *  tick queued offline lands on the right line even if others were added. */
export function tick(snap, { id, label, occurrence = 0, done }) {
  const issue = get(snap, id);
  const n = iss.findAction(issue.body, label, occurrence);
  if (n < 0) throw new OpError(`${issue.id} no longer has the action "${label.slice(0, 60)}"`);
  issue.body = iss.setActionLine(issue.body, n, done);
  return { changes: save(issue), message: `${issue.id}: ${done ? "tick" : "untick"} action`, result: issue };
}

export function addAction(snap, { id, text }) {
  const t = oneLine(text);
  if (!t) throw new OpError("an action needs some text");
  return append(snap, { id, text: `- [ ] ${t}`, section: "Actions" });
}

/** Header fields and/or the whole body, refusing to overwrite a newer edit. */
export function update(snap, { id, fields = {}, body = null, expectedUpdated = null }) {
  const issue = get(snap, id);
  if (expectedUpdated && issue.meta.updated !== expectedUpdated) {
    throw new StaleEdit(`${issue.id} was changed elsewhere (at ${issue.meta.updated}) since you opened it`);
  }
  const changed = [];
  for (let [key, value] of Object.entries(fields)) {
    if (PROTECTED.has(key)) throw new OpError(`${key} cannot be changed`);
    if (key === "parent" || (key === "status" && value === "archived")) {
      throw new OpError(`change ${key === "parent" ? "the parent" : "archiving"} on a computer for now`);
    }
    if (key === "status" && !iss.STATUSES.includes(value)) throw new OpError(`status must be one of ${iss.STATUSES.join(", ")}`);
    if (key === "priority" && !iss.PRIORITIES.includes(value)) throw new OpError(`priority must be one of ${iss.PRIORITIES.join(", ")}`);
    if (key === "title") { value = oneLine(value); if (!value) throw new OpError("the title cannot be empty"); }
    if (key === "due") {
      value = value ? String(value).trim() : null;
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OpError("due must be a date as YYYY-MM-DD");
    }
    if (key === "private") throw new OpError("change privacy on a computer, where git-crypt moves the file");
    if (key === "pinned") value = Boolean(value);
    if (JSON.stringify(issue.meta[key] ?? null) === JSON.stringify(value ?? null)) continue;
    issue.meta[key] = value;
    changed.push(key);
  }
  if (body !== null && body !== issue.body) { issue.body = body; changed.push("body"); }
  if (!changed.length) return { changes: [], message: "", result: issue };
  return { changes: save(issue), message: `${issue.id}: update ${changed.join(", ")}`, result: issue };
}

function createIssue(snap, { title, parent = null, lede = "", status = "idea", priority = "none",
  private: priv = null, note = "", when }) {
  title = oneLine(title);
  if (!title) throw new OpError("an issue needs a title");
  let parentIssue = null;
  if (parent) {
    parentIssue = snap.issues.get(String(parent).trim().toUpperCase());
    if (!parentIssue) throw new OpError(`no issue ${parent}`);
  }
  // private=null inherits from the parent, so a child of an encrypted issue
  // is never created unencrypted by accident
  if (priv === null) priv = parentIssue ? isPrivate(parentIssue) : false;
  const now = iso(when);
  const meta = { id: nextId(snap), title, parent: parentIssue ? parentIssue.id : null, status, priority,
    labels: [], private: Boolean(priv), created: now, updated: now };
  check(meta);
  const body = iss.appendLog(iss.newBody(lede), "CREATED", note || title, when);
  const issue = new iss.Issue(meta, body);
  return { issue, changes: save(issue, { touch: false }) };
}

export function create(snap, args) {
  const { issue, changes } = createIssue(snap, args);
  return { changes, message: `${issue.id}: new — ${issue.title}`, result: issue };
}

// ---------------------------------------------------------------- journal

export function journalRoot(snap) {
  const configured = (snap.config.journal || {}).parent;
  if (configured && snap.issues.has(configured)) return snap.issues.get(configured);
  const tops = [...snap.issues.values()].filter((i) => !i.parent && i.title.toLowerCase().endsWith("journchive"));
  tops.sort((a, b) => (a.id < b.id ? -1 : 1));
  return tops[0] || null;
}

export function journalMonth(snap, when) {
  const root = journalRoot(snap);
  if (!root) return null;
  const title = monthTitle(when);
  return [...snap.issues.values()].find((i) => i.parent === root.id && i.title === title && i.status !== "archived") || null;
}

export function todayBlock(body, heading) {
  const lines = body.split("\n");
  const start = lines.indexOf(`### ${heading}`);
  if (start < 0) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("### ") || line.startsWith("## ") || line.trim() === "---") break;
    block.push(line);
  }
  return block;
}

/** One entry under today's heading, creating the month and the heading if
 *  needed — exactly what the `journ` skill and `pt ui` write. */
export function journalAdd(snap, { text, feeling = "", when }) {
  text = oneLine(text);
  if (!text) throw new OpError("an entry needs some text");
  const root = journalRoot(snap);
  if (!root) throw new OpError('no Journchive found: add [journal] parent = "P-…" to .periodicity/config.toml');
  if (root.locked) throw new OpError("the Journchive is encrypted; add the git-crypt key in Settings");
  let month = journalMonth(snap, when);
  const changes = [];
  const messages = [];
  if (!month) {
    const title = monthTitle(when);
    const made = createIssue(snap, { title, parent: root.id, lede: `**Journal for ${title}.**`, status: "in-progress", when });
    month = made.issue;
    messages.push(`${month.id}: new — ${title}`);
  } else {
    month = get(snap, month.id);
  }
  const heading = dayHeading(when);
  feeling = oneLine(feeling) || "—";
  let entry = `- [${feeling !== "—" ? "x" : " "}] ${hhmm(when)} IST — ${text} | Feeling: ${feeling}`;
  if (todayBlock(month.body, heading) === null) {
    const dated = /^### /m.test(month.body);
    entry = (dated ? "---\n\n" : "") + `### ${heading}\n\n` + entry;
  }
  month.body = iss.appendText(month.body, entry, null);
  changes.push(...save(month));
  messages.push(`${month.id}: append`);
  // the create and the append land in one commit; drop the create's own write
  const seen = new Set();
  const merged = changes.reverse().filter((c) => !seen.has(c.path) && seen.add(c.path)).reverse();
  return { changes: merged, message: messages.join("; "), result: month };
}

// ---------------------------------------------------------------- this phone

export function registerPhone(snap) {
  const text = snap.configText || "";
  const cfg = parseConfig(text);
  if (cfg.machines && MACHINE in cfg.machines) return { changes: [], message: "", result: cfg.machines[MACHINE] };
  const taken = new Set(Object.values(cfg.machines || {}));
  if (taken.has(DEFAULT_PREFIX)) throw new OpError(`${DEFAULT_PREFIX} is already used by another machine`);
  const entry = `"${MACHINE}" = "${DEFAULT_PREFIX}"`;
  let out;
  if (/^\[machines\][ \t]*$/m.test(text)) {
    // add at the end of the [machines] section
    const lines = text.replace(/\n+$/, "").split("\n");
    const start = lines.findIndex((l) => /^\[machines\]\s*$/.test(l));
    let end = lines.findIndex((l, i) => i > start && /^\[/.test(l));
    if (end < 0) end = lines.length;
    while (end > start + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, entry);
    out = lines.join("\n") + "\n";
  } else {
    out = text.replace(/\n*$/, text ? "\n\n" : "") + `[machines]\n${entry}\n`;
  }
  return { changes: [{ path: ".periodicity/config.toml", text: out }],
    message: `config: register the iPhone as ${DEFAULT_PREFIX}`, result: DEFAULT_PREFIX };
}
