// Due dates, snoozes and owners on checklist actions, as plain Markdown.
// A line-for-line port of periodicity/actions.py (test/parity checks it):
//   - [ ] 🔴 Book the cabs 📅 2026-12-01 💤 2026-11-25 — Anshuman & Ishika

const DUE = /[ \t]*📅[ \t]*(\d{4}-\d{2}-\d{2})/;
const SNOOZE = /[ \t]*💤[ \t]*(\d{4}-\d{2}-\d{2})/;
const DUE_G = new RegExp(DUE.source, "g");
const SNOOZE_G = new RegExp(SNOOZE.source, "g");
const WAIT = /[ \t]*⏳[ \t]*(\d{4}-\d{2}-\d{2})/;
const WAIT_G = new RegExp(WAIT.source, "g");
const NAME = "[A-Z][A-Za-z.'-]*";
const OWNER = new RegExp(`[ \\t]+—[ \\t]+_?(${NAME}(?:[ \\t]*(?:&|,|and)[ \\t]*${NAME})*)_?[ \\t]*$`);
const SPLIT = /[ \t]*(?:&|,|\band\b)[ \t]*/;
const FLAGS = ["⚠", "🔴"];
export const KEEP = Symbol("keep");

function validDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? s : null;
}

export function parse(text) {
  const due = DUE.exec(text);
  const snooze = SNOOZE.exec(text);
  const wait = WAIT.exec(text);
  let rest = text.replace(DUE_G, "").replace(SNOOZE_G, "").replace(WAIT_G, "");
  let owners = [];
  const m = OWNER.exec(rest);
  if (m) {
    owners = m[1].split(SPLIT).filter(Boolean);
    rest = rest.slice(0, m.index);
  }
  return {
    core: rest.replace(/\s+$/, ""), owners,
    due: due ? validDate(due[1]) : null,
    snooze: snooze ? validDate(snooze[1]) : null,
    waiting: wait ? validDate(wait[1]) : null,
    flag: FLAGS.some((f) => text.includes(f)),
  };
}

/** The same action with new metadata; null/[] clears, KEEP (default) keeps. */
export function withMeta(text, { due = KEEP, snooze = KEEP, owners = KEEP, waiting = KEEP } = {}) {
  if (due === KEEP && snooze === KEEP && owners === KEEP && waiting === KEEP) return text;
  const p = parse(text);
  due = due === KEEP ? p.due : validDate(due);
  snooze = snooze === KEEP ? p.snooze : validDate(snooze);
  owners = owners === KEEP ? p.owners : (owners || []).map((o) => (o || "").trim()).filter(Boolean);
  waiting = waiting === KEEP ? p.waiting : validDate(waiting);
  let out = p.core;
  if (due) out += ` 📅 ${due}`;
  if (snooze) out += ` 💤 ${snooze}`;
  if (waiting) out += ` ⏳ ${waiting}`;
  if (owners.length) out += " — " + owners.join(" & ");
  return out;
}

/** today: "YYYY-MM-DD" in IST. */
export function describe(text, today) {
  const p = parse(text);
  const diff = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return { ...p, days: p.due ? diff(p.due) : null, waited: p.waiting ? -diff(p.waiting) : null,
    snoozed: Boolean(p.snooze && p.snooze > today) };
}
