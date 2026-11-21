// Read-only views over a snapshot: tree, Today, Home, search, backlinks.
// Ports of the reading helpers in ops.py and dashboard.py.

import { CHECKBOX, PRIORITIES } from "./issue.js";
import { daysUntil } from "./time.js";
import { journalRoot, journalMonth, todayBlock } from "./ops.js";
import { dayHeading, weekday, todayDate } from "./time.js";
import { describe } from "./actions.js";
import * as tables from "./tables.js";

export const LIVE = ["idea", "todo", "in-progress"];
const ACTION_SECTION = /^## .*(action|next)/i;
const JOURNAL_ENTRY = /^- \[([ xX])\] (\d{2}:\d{2}) IST — (.*?)(?: \| Feeling: (.*))?$/;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const TOP_PRIORITIES = ["urgent", "high"];

/** 0 for urgent … 4 for none; a missing or unknown priority counts as none. */
export function priorityIndex(p) {
  const i = PRIORITIES.indexOf(p);
  return i < 0 ? PRIORITIES.length - 1 : i;
}
export const priorityRank = (issue) => priorityIndex(issue.meta.priority);

/** True when the issue is at `min` priority or above ("" or "any" keeps all). */
export function atLeast(issue, min) {
  return !min || min === "any" || priorityRank(issue) <= priorityIndex(min);
}

export function children(snap, id, { archived = false } = {}) {
  const kids = [...snap.issues.values()].filter((i) => (i.parent || null) === (id || null)
    && (archived || i.status !== "archived"));
  return kids.sort((a, b) => {
    const ra = a.meta.rank, rb = b.meta.rank;
    if ((ra == null) !== (rb == null)) return ra == null ? 1 : -1;
    if ((ra || 0) !== (rb || 0)) return (ra || 0) - (rb || 0);
    return priorityRank(a) - priorityRank(b) || byId(a, b);
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

/** Actions in an issue's Actions/Next sections with their 📅/💤/owner
 *  metadata; flagged (⚠ 🔴) first, then by due date. `n` counts ALL
 *  checkboxes in the body, as the renderer numbers them. A port of
 *  ops._action_items. */
export function actionItems(issue, when, { includeDone = false } = {}) {
  const today = todayDate(when);
  const items = [];
  let n = -1, inActions = false;
  for (const line of issue.body.split("\n")) {
    if (line.startsWith("## ")) inActions = ACTION_SECTION.test(line);
    const m = CHECKBOX.exec(line);
    if (!m) continue;
    n++;
    const done = m[2] !== " ";
    if (inActions && (includeDone || !done)) {
      const text = m[3].slice(2).trim();
      const d = describe(text, today);
      items.push({ n, text, label: m[3].slice(2), done, warn: d.flag, ...d });
    }
  }
  return items;
}

const itemOrder = (a, b) => (a.done - b.done) || (b.flag - a.flag)
  || (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99") || a.n - b.n;

export function openItems(issue, when, { includeSnoozed = false } = {}) {
  return actionItems(issue, when).filter((x) => includeSnoozed || !x.snoozed).sort(itemOrder);
}

export function today(snap, when) {
  const groups = new Map();
  for (const issue of [...snap.issues.values()].sort(byId)) {
    if (!LIVE.includes(issue.status) || issue.locked) continue;
    const items = openItems(issue, when);
    if (!items.length) continue;
    const root = area(snap, issue);
    if (!groups.has(root.id)) groups.set(root.id, { area: root.id, areaTitle: root.title, issues: [] });
    groups.get(root.id).issues.push({ issue, items });
  }
  for (const g of groups.values()) g.issues.sort((a, b) => priorityRank(a.issue) - priorityRank(b.issue));
  return [...groups.values()].sort((a, b) => (a.area < b.area ? -1 : 1));
}

/** One project: every action in `id` and its live descendants, in tree
 *  order. A port of ops.focus. */
export function focus(snap, id, when) {
  const root = snap.issues.get(id);
  if (!root) return null;
  const groups = [];
  const seen = new Set();
  const walk = (issue, depth) => {
    if (seen.has(issue.id)) return;
    seen.add(issue.id);
    const items = issue.status !== "archived" && !issue.locked ? actionItems(issue, when, { includeDone: true }) : [];
    const open = LIVE.includes(issue.status) ? items.filter((x) => !x.done).sort(itemOrder) : [];
    groups.push({ issue, depth, items: open, done: items.filter((x) => x.done).length, total: items.length,
      days: issue.meta.due ? daysUntil(issue.meta.due, when) : null });
    for (const k of children(snap, issue.id)) walk(k, depth + 1);
  };
  walk(root, 0);
  const open = groups.flatMap((g) => g.items);
  const awake = open.filter((x) => !x.snoozed);
  const owners = new Map();
  for (const x of open) for (const o of x.owners.length ? x.owners : ["(no owner)"]) owners.set(o, (owners.get(o) || 0) + 1);
  return {
    issue: root, days: root.meta.due ? daysUntil(root.meta.due, when) : null, groups,
    owners: [...owners.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    totals: { open: awake.length, flagged: awake.filter((x) => x.flag).length,
      overdue: awake.filter((x) => x.days !== null && x.days < 0).length,
      dueWeek: awake.filter((x) => x.days !== null && x.days >= 0 && x.days <= 7).length,
      snoozed: open.length - awake.length, done: groups.reduce((s, g) => s + g.done, 0),
      total: groups.reduce((s, g) => s + g.total, 0), issues: groups.length },
  };
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
  const dueActions = [];
  const todayGroups = today(snap, when);
  for (const g of todayGroups) {
    for (const { issue, items } of g.issues) {
      for (const it of items) if (it.days !== null && it.days <= 14) dueActions.push({ ...it, issue, area: g.areaTitle });
    }
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
  upcoming.sort((a, b) => a.days - b.days || priorityRank(a.issue) - priorityRank(b.issue));
  // urgent, then high; sooner due date first, undated last
  const top = live.filter((i) => TOP_PRIORITIES.includes(i.meta.priority) && !journalIds.has(i.id))
    .sort((a, b) => priorityRank(a) - priorityRank(b)
      || (String(a.meta.due || "9999") < String(b.meta.due || "9999") ? -1 : String(a.meta.due || "9999") > String(b.meta.due || "9999") ? 1 : 0)
      || byId(a, b));
  const byUpdated = (a, b) => ((b.meta.updated || "") > (a.meta.updated || "") ? 1 : (b.meta.updated || "") < (a.meta.updated || "") ? -1 : 0);
  return {
    today: `${weekday(when)}, ${dayHeading(when)}`,
    journal: journalToday(snap, when),
    areas,
    totals: { open: areas.reduce((s, a) => s + a.open, 0), warn: areas.reduce((s, a) => s + a.warn, 0),
      issues: live.filter((i) => !journalIds.has(i.id)).length },
    pinned: issues.filter((i) => i.meta.pinned && i.status !== "archived").sort((a, b) => a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1),
    upcoming: upcoming.slice(0, 12),
    countdowns: countdowns(snap, when),
    week: week(snap, todayGroups, when),
    waiting: waiting(todayGroups),
    neglected: neglected(snap, todayGroups, when, journalIds),
    tiles: tiles(snap),
    dueActions: dueActions.sort((a, b) => a.days - b.days || (b.flag - a.flag) || (a.issue.id < b.issue.id ? -1 : 1) || a.n - b.n).slice(0, 20),
    priority: top.slice(0, 12),
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

// ---------------------------------------------------------------- dashboard panels (port of board.py)

const NEGLECT_DAYS = 14;
const labelsOf = (i) => (i.meta.labels || []).map((l) => String(l).toLowerCase());
const addDays = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function countdowns(snap, when) {
  return [...snap.issues.values()]
    .filter((i) => labelsOf(i).includes("countdown") && i.status !== "archived" && i.meta.due && !i.locked)
    .map((i) => { const f = focus(snap, i.id, when); return { issue: i, days: daysUntil(i.meta.due, when), ...f.totals }; })
    .sort((a, b) => a.days - b.days);
}

export function week(snap, groups, when, n = 7) {
  const today = todayDate(when);
  const dates = Array.from({ length: n }, (_, k) => addDays(today, k));
  const last = dates[n - 1];
  const buckets = new Map([["overdue", []], ...dates.map((d) => [d, []])]);
  for (const g of groups) for (const { issue, items } of g.issues) for (const it of items) {
    if (!it.due || it.due > last) continue;
    buckets.get(it.due >= today ? it.due : "overdue").push({ kind: "action", issue, ...it });
  }
  for (const i of snap.issues.values()) {
    if (i.locked) continue;
    if (LIVE.includes(i.status) && i.meta.due && String(i.meta.due) >= today && String(i.meta.due) <= last) {
      buckets.get(String(i.meta.due)).push({ kind: "issue", issue: i });
    }
    if (labelsOf(i).includes("calendar") && i.status !== "archived") {
      for (const t of tables.find(i.body)) for (const e of tables.events(t.header, t.rows, today)) {
        if (buckets.has(e.date) && e.date !== "overdue") buckets.get(e.date).push({ kind: "event", issue: i, text: e.text });
      }
    }
  }
  const order = { event: 0, issue: 1, action: 2 };
  const out = [];
  if (buckets.get("overdue").length) out.push({ date: null, label: "Overdue", items: buckets.get("overdue").sort((a, b) => (a.due < b.due ? -1 : 1)) });
  dates.forEach((d, k) => {
    const t = new Date(`${d}T00:00:00Z`);
    const label = k === 0 ? "Today" : k === 1 ? "Tomorrow" : `${DAY_NAMES[t.getUTCDay()]} ${t.getUTCDate()} ${MON_NAMES[t.getUTCMonth()]}`;
    out.push({ date: d, label, items: buckets.get(d).sort((a, b) => order[a.kind] - order[b.kind] || (b.flag ? 1 : 0) - (a.flag ? 1 : 0)) });
  });
  return out;
}

export function waiting(groups) {
  return groups.flatMap((g) => g.issues.flatMap(({ issue, items }) => items.filter((it) => it.waiting).map((it) => ({ ...it, issue, area: g.areaTitle }))))
    .sort((a, b) => (b.waited || 0) - (a.waited || 0) || (a.issue.id < b.issue.id ? -1 : 1));
}

export function neglected(snap, groups, when, journalIds, limit = 10) {
  const open = new Map(groups.flatMap((g) => g.issues.map(({ issue, items }) => [issue.id, items.length])));
  return [...snap.issues.values()]
    .filter((i) => LIVE.includes(i.status) && !journalIds.has(i.id) && open.get(i.id))
    .map((i) => ({ issue: i, open: open.get(i.id), idle: -daysUntil(String(i.meta.updated || "").slice(0, 10), when), area: area(snap, i).title }))
    .filter((x) => Number.isFinite(x.idle) && x.idle >= NEGLECT_DAYS)
    .sort((a, b) => b.idle - a.idle).slice(0, limit);
}

export function statusSection(body) {
  const m = /^## Status[ \t]*$/m.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const nxt = /^## /m.exec(rest);
  const text = (nxt ? rest.slice(0, nxt.index) : rest).replace(/^\n+|\n+$/g, "");
  return text || null;
}

export function tiles(snap) {
  return [...snap.issues.values()]
    .filter((i) => i.status !== "archived" && !i.locked && (i.meta.pinned || labelsOf(i).includes("countdown")))
    .map((i) => ({ issue: i, text: statusSection(i.body) })).filter((t) => t.text)
    .sort((a, b) => (a.issue.title.toLowerCase() < b.issue.title.toLowerCase() ? -1 : 1));
}

export function money(snap, id) {
  const out = [];
  const seen = new Set();
  const walk = (i) => {
    if (seen.has(i.id) || i.locked) return;
    seen.add(i.id);
    tables.find(i.body).forEach((t, k) => {
      for (const [c, total] of Object.entries(tables.totals(t.header, t.rows))) {
        out.push({ issue: i, table: k, column: tables.plain(t.header[c]), total, shown: tables.rupees(total) });
      }
    });
    for (const kid of children(snap, i.id)) walk(kid);
  };
  if (snap.issues.has(id)) walk(snap.issues.get(id));
  return out;
}
