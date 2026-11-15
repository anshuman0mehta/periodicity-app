// Read-only views over a snapshot: tree, Today, Home, search, backlinks.
// Ports of the reading helpers in ops.py and dashboard.py.

import { CHECKBOX } from "./issue.js";
import { daysUntil } from "./time.js";
import { journalRoot, journalMonth, todayBlock } from "./ops.js";
import { dayHeading, weekday } from "./time.js";

export const LIVE = ["idea", "todo", "in-progress"];
const ACTION_SECTION = /^## .*(action|next)/i;
const JOURNAL_ENTRY = /^- \[([ xX])\] (\d{2}:\d{2}) IST — (.*?)(?: \| Feeling: (.*))?$/;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function children(snap, id, { archived = false } = {}) {
  const kids = [...snap.issues.values()].filter((i) => (i.parent || null) === (id || null)
    && (archived || i.status !== "archived"));
  return kids.sort((a, b) => {
    const ra = a.meta.rank, rb = b.meta.rank;
    if ((ra == null) !== (rb == null)) return ra == null ? 1 : -1;
    if ((ra || 0) !== (rb || 0)) return (ra || 0) - (rb || 0);
    return byId(a, b);
  });
}

export function roots(snap, { archived = false } = {}) {
  return [...snap.issues.values()]
    .filter((i) => (!i.parent || !snap.issues.has(i.parent)) && (archived || i.status !== "archived"))
    .sort(byId);
}

export function area(snap, issue) {
  const seen = new Set();
  while (issue.parent && snap.issues.has(issue.parent) && !seen.has(issue.id)) {
    seen.add(issue.id);
    issue = snap.issues.get(issue.parent);
  }
  return issue;
}

export function ancestors(snap, issue) {
  const out = [];
  const seen = new Set([issue.id]);
  let cur = issue;
  while (cur.parent && snap.issues.has(cur.parent) && !seen.has(cur.parent)) {
    cur = snap.issues.get(cur.parent);
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

export function backlinks(snap, id) {
  const out = [];
  for (const other of snap.issues.values()) {
    for (const l of other.meta.links || []) if (l && l.to === id) out.push({ type: l.type, from: other.id, title: other.title });
  }
  return out;
}

/** Open actions in a live issue's Actions/Next sections, ⚠ first. `n` counts
 *  ALL checkboxes in the body, as the renderer numbers them. */
export function openItems(issue) {
  const items = [];
  let n = -1, inActions = false;
  for (const line of issue.body.split("\n")) {
    if (line.startsWith("## ")) inActions = ACTION_SECTION.test(line);
    const m = CHECKBOX.exec(line);
    if (!m) continue;
    n++;
    if (inActions && m[2] === " ") {
      const text = m[3].slice(2).trim();
      items.push({ n, text, label: m[3].slice(2), warn: text.includes("⚠") });
    }
  }
  items.sort((a, b) => (a.warn === b.warn ? a.n - b.n : a.warn ? -1 : 1));
  return items;
}

export function today(snap) {
  const groups = new Map();
  for (const issue of [...snap.issues.values()].sort(byId)) {
    if (!LIVE.includes(issue.status)) continue;
    const items = openItems(issue);
    if (!items.length) continue;
    const root = area(snap, issue);
    if (!groups.has(root.id)) groups.set(root.id, { area: root.id, areaTitle: root.title, issues: [] });
    groups.get(root.id).issues.push({ issue, items });
  }
  return [...groups.values()].sort((a, b) => (a.area < b.area ? -1 : 1));
}

export function journalToday(snap, when) {
  const month = journalMonth(snap, when);
  const heading = dayHeading(when);
  const entries = [];
  if (month) {
    for (const line of todayBlock(month.body, heading) || []) {
      const m = JOURNAL_ENTRY.exec(line.trim());
      if (m) entries.push({ done: m[1] !== " ", time: m[2], text: m[3], feeling: m[4] || "" });
    }
  }
  const root = journalRoot(snap);
  return { month, heading, entries, configured: Boolean(root), locked: Boolean(root && root.locked) };
}

export function home(snap, when) {
  const issues = [...snap.issues.values()];
  const journal = journalRoot(snap);
  const journalIds = new Set(issues.filter((i) => journal && i.parent === journal.id).map((i) => i.id));
  const live = issues.filter((i) => LIVE.includes(i.status));
  const perArea = new Map();
  for (const g of today(snap)) {
    let open = 0, warn = 0;
    for (const { items } of g.issues) { open += items.length; warn += items.filter((x) => x.warn).length; }
    perArea.set(g.area, { open, warn });
  }
  const areas = issues.filter((i) => !i.parent && i.status !== "archived").sort(byId).map((r) => {
    const members = live.filter((i) => area(snap, i).id === r.id);
    return { issue: r, issues: members.length, inProgress: members.filter((i) => i.status === "in-progress").length,
      ...(perArea.get(r.id) || { open: 0, warn: 0 }) };
  });
  const upcoming = [];
  for (const i of live) {
    if (!i.meta.due) continue;
    const days = daysUntil(i.meta.due, when);
    if (days === null) continue;
    upcoming.push({ issue: i, due: String(i.meta.due), days, area: area(snap, i).title });
  }
  upcoming.sort((a, b) => a.days - b.days);
  const byUpdated = (a, b) => ((b.meta.updated || "") > (a.meta.updated || "") ? 1 : (b.meta.updated || "") < (a.meta.updated || "") ? -1 : 0);
  return {
    today: `${weekday(when)}, ${dayHeading(when)}`,
    journal: journalToday(snap, when),
    areas,
    totals: { open: areas.reduce((s, a) => s + a.open, 0), warn: areas.reduce((s, a) => s + a.warn, 0),
      issues: live.filter((i) => !journalIds.has(i.id)).length },
    pinned: issues.filter((i) => i.meta.pinned && i.status !== "archived").sort((a, b) => a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1),
    upcoming: upcoming.slice(0, 12),
    inProgress: live.filter((i) => i.status === "in-progress" && !journalIds.has(i.id) && i.parent).sort(byUpdated).slice(0, 10),
    recent: issues.filter((i) => i.status !== "archived" && !journalIds.has(i.id)).sort(byUpdated).slice(0, 10),
  };
}

export function search(snap, text, { archived = false, limit = 50 } = {}) {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const issue of [...snap.issues.values()].sort(byId)) {
    if (issue.status === "archived" && !archived) continue;
    const legacy = (issue.meta.legacy || []).join(" ");
    const hay = `${issue.id}\n${issue.title}\n${legacy}\n${issue.body}`;
    const pos = hay.toLowerCase().indexOf(needle);
    if (pos < 0) continue;
    const start = Math.max(0, pos - 60);
    const snippet = hay.slice(start, pos + needle.length + 60).replace(/\n/g, " ");
    // title and id hits first
    out.push({ issue, snippet: (start ? "…" : "") + snippet + "…", rank: pos < issue.id.length + issue.title.length + 2 ? 0 : 1 });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, limit);
}
