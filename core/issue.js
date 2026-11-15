// One issue = one Markdown file with a YAML front-matter block.
// A port of periodicity/issue.py: same regexes, same body edits, same header
// order. Header lines the phone did not change are written back exactly as
// they were read, so an edit never reformats a field it did not touch.

import yaml from "../vendor/js-yaml.mjs";
import * as emit from "./yaml-emit.js";
import { stamp } from "./time.js";

export const STATUSES = ["idea", "todo", "in-progress", "done", "cancelled", "archived"];
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
export const LOG_TYPES = ["CREATED", "UPDATE", "DECISION", "NOTE", "FIX", "BUG"];
export const FIELD_ORDER = ["id", "title", "parent", "status", "priority", "due", "pinned", "rank",
  "labels", "private", "created", "updated", "links", "legacy"];
const OPTIONAL = new Set(["due", "pinned", "rank", "labels", "private", "links", "legacy"]);

const LOG_HEADING = /^## Log[ \t]*$/m;
const NEXT_HEADING = /^## /m;
export const CHECKBOX = /^(\s*[-*] \[)([ xX])(\] .*)$/;

export class IssueFormatError extends Error {}

export class Issue {
  constructor(meta, body, path = null, raw = null) {
    this.meta = meta;
    this.body = body;
    this.path = path;
    // as read: { key: [lines], ... } and a deep copy of the values they encoded
    this.raw = raw || { lines: {}, values: {} };
  }
  get id() { return this.meta.id; }
  get title() { return this.meta.title || ""; }
  get parent() { return this.meta.parent || null; }
  get status() { return this.meta.status || "idea"; }
  get private() { return Boolean(this.meta.private); }
  openActions() {
    return this.body.split("\n").filter((l) => { const m = CHECKBOX.exec(l); return m && m[2] === " "; }).length;
  }
  clone() {
    return new Issue(structuredClone(this.meta), this.body, this.path, this.raw);
  }
}

// ---------------------------------------------------------------- parse/render

function headerLines(text) {
  // top-level keys: a line starting at column 0; continuation lines are indented
  const out = {};
  let key = null;
  for (const l of text.split("\n")) {
    const m = /^([^\s#][^:]*?):(?:\s|$)/.exec(l);
    if (m && !l.startsWith(" ") && !l.startsWith("-")) {
      key = m[1].replace(/^['"]|['"]$/g, "");
      out[key] = [l];
    } else if (key && l !== "") {
      out[key].push(l);
    }
  }
  return out;
}

export function parse(text, path = null) {
  text = text.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) throw new IssueFormatError(`${path || "issue"}: missing front matter`);
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new IssueFormatError(`${path || "issue"}: unterminated front matter`);
  const head = text.slice(4, end);
  const meta = yaml.load(head, { schema: yaml.CORE_SCHEMA }) || {};
  if (typeof meta !== "object" || Array.isArray(meta) || !("id" in meta)) {
    throw new IssueFormatError(`${path || "issue"}: front matter has no id`);
  }
  const body = text.slice(end + 5).replace(/^\n+/, "");
  return new Issue(meta, body, path, { lines: headerLines(head), values: structuredClone(meta) });
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function skip(key, value) {
  // Python: `value in (None, False, [], "")`, and 0 == False there
  return OPTIONAL.has(key) && (value === null || value === undefined || value === false || value === ""
    || value === 0 || (Array.isArray(value) && value.length === 0));
}

function fieldLine(issue, key, value) {
  const raw = issue.raw.lines[key];
  if (raw && key in issue.raw.values && same(issue.raw.values[key], value)) return raw.join("\n");
  return emit.line(key, value, { isFloat: key === "rank" });
}

export function render(issue) {
  const out = [];
  const seen = new Set();
  for (const key of FIELD_ORDER) {
    if (!(key in issue.meta)) continue;
    seen.add(key);
    const value = issue.meta[key];
    if (skip(key, value)) continue;
    out.push(fieldLine(issue, key, value));
  }
  for (const [key, value] of Object.entries(issue.meta)) {
    if (seen.has(key)) continue;
    out.push(fieldLine(issue, key, value));
  }
  return "---\n" + out.join("\n") + "\n---\n\n" + issue.body.replace(/^\n+|\n+$/g, "") + "\n";
}

// ---------------------------------------------------------------- body edits

export function newBody(lede = "") {
  lede = lede.trim();
  return (lede ? lede + "\n\n" : "") + "## Actions\n\n## Reference\n\n## Log\n";
}

export function logEntry(kind, text, when) {
  kind = kind.toUpperCase();
  if (!LOG_TYPES.includes(kind)) throw new Error(`log type must be one of ${LOG_TYPES.join(", ")}`);
  return `${stamp(when)}: ${kind}: ${text.trim()}`;
}

/** Insert a new entry directly under `## Log` (newest first); a `---` rule
 *  separates it from the previous day's entries. */
export function appendLog(body, kind, text, when) {
  let entry = logEntry(kind, text, when);
  const m = LOG_HEADING.exec(body);
  if (!m) return body.replace(/\n+$/, "") + "\n\n## Log\n\n" + entry + "\n";
  const headEnd = m.index + m[0].length;
  const head = body.slice(0, headEnd);
  const rest = body.slice(headEnd).replace(/^\n+/, "");
  const top = /^(\d{2}-\d{2}-\d{4})/.exec(rest);
  if (top && top[1] !== entry.slice(0, 10)) entry += "\n\n---";
  return head + "\n\n" + entry + (rest.trim() ? "\n\n" + rest : "\n");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Append text to the end of a `## section` (created before `## Log` if
 *  missing), or with no section, to the end of the body before `## Log`. */
export function appendText(body, text, section = null) {
  text = text.replace(/^\n+|\n+$/g, "");
  const log = LOG_HEADING.exec(body);
  let block;
  if (section) {
    const heading = new RegExp(`^## ${escapeRe(section)}[ \\t]*$`, "m");
    const m = heading.exec(body);
    if (m) {
      const after = m.index + m[0].length;
      const nxtRel = NEXT_HEADING.exec(body.slice(after));
      const end = nxtRel ? after + nxtRel.index : body.length;
      return body.slice(0, end).replace(/\n+$/, "") + "\n\n" + text + "\n" + (nxtRel ? "\n" + body.slice(end) : "");
    }
    block = `## ${section}\n\n${text}\n`;
  } else {
    block = text + "\n";
  }
  if (log) return body.slice(0, log.index).replace(/\n+$/, "") + "\n\n" + block + "\n" + body.slice(log.index);
  return body.replace(/\n+$/, "") + "\n\n" + block;
}

/** Tick (or untick) the n-th checklist line, counting from 0 in body order. */
export function setActionLine(body, n, done) {
  const lines = body.split("\n");
  const hits = [];
  lines.forEach((l, i) => { if (CHECKBOX.test(l)) hits.push(i); });
  if (!(n >= 0 && n < hits.length)) throw new Error(`there is no checklist item #${n} (found ${hits.length})`);
  const m = CHECKBOX.exec(lines[hits[n]]);
  lines[hits[n]] = m[1] + (done ? "x" : " ") + m[3];
  return lines.join("\n");
}

/** The n-th checklist line, and which occurrence of that exact text it is. */
export function actionAt(body, n) {
  const boxes = body.split("\n").filter((l) => CHECKBOX.test(l));
  const text = boxes[n];
  if (text === undefined) return null;
  const label = CHECKBOX.exec(text)[3].slice(2);
  const occurrence = boxes.slice(0, n).filter((l) => CHECKBOX.exec(l)[3].slice(2) === label).length;
  return { label, occurrence };
}

/** Find the checklist line by its text (robust to other lines moving), so a
 *  tick queued offline still lands on the right item after a sync. */
export function findAction(body, label, occurrence = 0) {
  const boxes = body.split("\n").filter((l) => CHECKBOX.test(l));
  let seen = 0;
  for (let n = 0; n < boxes.length; n++) {
    if (CHECKBOX.exec(boxes[n])[3].slice(2) === label) {
      if (seen === occurrence) return n;
      seen++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------- file names

export function slug(title) {
  const s = title.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return s.slice(0, 60).replace(/-+$/, "") || "untitled";
}

export function fileName(issue) {
  return `${issue.id} ${slug(issue.title)}.md`;
}
