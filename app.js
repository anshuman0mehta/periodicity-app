// Periodicity for the iPhone: screens, settings, sync and the offline queue.
// All reading and writing goes through core/ (shared with the Node tests).

import { Store, githubApi, toBase64, fromBase64 } from "./core/store.js";
import { IdbCache } from "./core/db.js";
import * as ops from "./core/ops.js";
import * as views from "./core/views.js";
import * as iss from "./core/issue.js";
import { render, renderInline, esc } from "./core/render.js";
import { iso, hhmm, todayDate } from "./core/time.js";
import * as tables from "./core/tables.js";

const VERSION = "0.4.0";
const OPS = { addLog: ops.addLog, addAction: ops.addAction, tick: ops.tick, update: ops.update,
  create: ops.create, journalAdd: ops.journalAdd, registerPhone: ops.registerPhone,
  editAction: ops.editAction, editRow: ops.editRow };
const SYNC_EVERY = 10 * 60 * 1000;
const STATUS_BRANCH = "status/iphone";
const REPORT_EVERY = 10 * 60 * 1000;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- persisted state

const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let settings = { owner: "anshuman0mehta", repo: "periodicity-data", branch: "main", token: "", key: "", theme: "dark",
  ...load("p:settings", {}) };
let queue = load("p:queue", []);          // [{op, args}] waiting for the network, in order
let failed = load("p:failed", []);        // [{op, args, error}] that could not be applied
const ui = { minPriority: "any", ...load("p:ui", { open: {}, hideDone: true, logOpen: false }) };
const saveUi = () => keep("p:ui", ui);

let store = null;
let cache = null;
let syncing = null;
let lastSync = load("p:lastSync", null);
let syncState = "idle";                   // idle | busy | offline | error
let syncError = "";

// ---------------------------------------------------------------- store

async function makeStore() {
  cache = cache || new IdbCache();
  store = settings.token
    ? new Store({ api: githubApi(settings.token, settings.apiBase || undefined), cache, owner: settings.owner, repo: settings.repo, branch: settings.branch })
    : null;
  if (!store) return;
  try { await store.setKey(settings.key ? fromBase64(settings.key) : null); }
  catch (e) { toast("The git-crypt key could not be read: " + e.message, true); }
  try {
    if (await store.loadState(load("p:state", null))) reapplyQueue();
  } catch { /* a missing cached blob: the first sync fills it */ }
}

function saveState() { if (store?.head) keep("p:state", store.exportState()); }

function reapplyQueue() {
  for (const q of queue) {
    try { store.applyLocal(OPS[q.op], q.args); } catch { /* it will fail visibly when flushed */ }
  }
}

async function sync({ quiet = false } = {}) {
  if (!store) return;
  if (syncing) return syncing;
  syncing = (async () => {
    setSync("busy");
    try {
      await flush();
      const changed = await store.pull();
      if (changed) { saveState(); reapplyQueue(); }
      lastSync = Date.now(); keep("p:lastSync", lastSync);
      syncError = "";
      setSync(queue.length ? "offline" : "idle");
      if (changed || !quiet) route();
    } catch (e) {
      syncError = explain(e);
      if (e.offline) setSync("offline");
      else { setSync("error"); if (!quiet) toast(syncError, true); }
      if (!store.head) route();
    } finally {
      syncing = null;
      report();
    }
  })();
  return syncing;
}

/** What the app is doing, for Claude to read from the status/iphone branch.
 *  No token, no key, no issue titles or text: ids and counts only. */
let lastReport = { at: 0, digest: "" };
async function report() {
  if (!store) return;
  const issues = store.issues ? [...store.issues.values()] : [];
  let prefix = null;
  try { if (store.head) prefix = ops.prefix(snap()); } catch {}
  const status = {
    app: VERSION,
    at: iso(),
    device: navigator.userAgent,
    installed: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    online: navigator.onLine,
    repo: `${settings.owner}/${settings.repo}`,
    key: Boolean(settings.key),
    sync: { state: syncState, error: syncError || null, last: lastSync ? iso(lastSync) : null, head: store.head },
    issues: { total: issues.length, private: issues.filter((i) => i.private).length, locked: issues.filter((i) => i.locked).length },
    problems: (store.problems || []).length,
    prefix,
    waiting: queue.map((q) => ({ op: q.op, id: q.args.id || null })),
    failed: failed.map((f) => ({ op: f.op, id: f.args.id || null })),
  };
  const digest = JSON.stringify({ ...status, at: 0, online: 0 });
  if (digest === lastReport.digest && Date.now() - lastReport.at < REPORT_EVERY) return;
  try {
    await store.writeSideBranch(STATUS_BRANCH, "status.json", JSON.stringify(status, null, 2) + "\n", `iphone status ${status.at}`);
    lastReport = { at: Date.now(), digest };
  } catch { /* no access or offline: the missing report is itself the signal */ }
}

/** Send queued edits, oldest first. Stops at the first network failure. */
async function flush() {
  while (queue.length) {
    const q = queue[0];
    try {
      await store.commit(OPS[q.op], q.args);
    } catch (e) {
      if (e.offline) throw e;
      failed.push({ ...q, error: e.message }); keep("p:failed", failed);
    }
    queue.shift(); keep("p:queue", queue);
    saveState();
  }
}

/** Make a change: commit now, or queue it when offline (shown at once either way). */
async function act(op, args, { quiet = false } = {}) {
  if (!store) { toast("Set up GitHub access in Settings first", true); location.hash = "#settings"; throw new Error("no store"); }
  args = { when: iso(), ...args };
  if (queue.length) return enqueue(op, args);
  setSync("busy");
  try {
    const { result } = await store.commit(OPS[op], args);
    saveState();
    setSync("idle");
    if (!quiet) toast("Saved");
    return result;
  } catch (e) {
    if (e.offline) return enqueue(op, args);
    setSync("idle");
    toast(e.message, true);
    throw e;
  }
}

function enqueue(op, args) {
  const result = store.applyLocal(OPS[op], args);     // throws (and nothing is queued) if it cannot apply
  queue.push({ op, args }); keep("p:queue", queue);
  setSync("offline");
  toast("Saved on the phone — will sync");
  if (navigator.onLine) setTimeout(() => sync({ quiet: true }), 1500);
  return result;
}

// ---------------------------------------------------------------- chrome

function setSync(state) {
  syncState = state;
  const dot = $("#sync-dot");
  dot.className = "dot " + ({ busy: "busy", offline: "offline", error: "error" }[state] || (queue.length ? "pending" : ""));
  $("#sync-text").textContent = state === "busy" ? "Syncing" : queue.length ? `${queue.length} waiting`
    : state === "offline" ? "Offline" : state === "error" ? "Error" : lastSync ? hhmm(lastSync) : "Sync";
  banner();
}

function banner() {
  const b = $("#banner");
  const parts = [];
  if (failed.length) {
    parts.push(`<b>${failed.length} change${failed.length > 1 ? "s" : ""} could not be applied</b> after syncing:` +
      failed.map((f, i) => `<div class="small">• ${esc(describe(f))} — <span class="muted">${esc(f.error)}</span>` +
        `${f.args.body ? ` <button class="btn quiet" data-copy="${i}">Copy text</button>` : ""}</div>`).join("") +
      `<div class="btns"><button class="btn quiet" id="dismiss-failed">Dismiss</button></div>`);
  }
  if (store?.problems.length) parts.push(`<div class="small">Unreadable files: ${esc(store.problems.join("; "))}</div>`);
  b.hidden = !parts.length;
  b.innerHTML = parts.join("");
}

function describe(q) {
  const a = q.args;
  return { addLog: `log on ${a.id}: ${a.text}`, addAction: `action on ${a.id}: ${a.text}`, tick: `tick on ${a.id}: ${a.label}`,
    update: `edit of ${a.id}`, create: `new issue “${a.title}”`, journalAdd: `journal: ${a.text}`, registerPhone: "register phone",
    editAction: `action on ${a.id}: ${a.label}`, editRow: `table row on ${a.id}` }[q.op] || q.op;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 5000 : 1800);
}

function setTitle(text, back = false) {
  $("#title").textContent = text;
  $("#back").hidden = !back;
}

function setTab(tab) {
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}

function composer(on) {
  $("#composer").hidden = !on;
  document.body.classList.toggle("composing", on);
}

// ---------------------------------------------------------------- helpers

const snap = () => store.snapshot();
const titles = () => new Map([...store.issues.values()].map((i) => [i.id, i.title]));

const PRIO_LABEL = { urgent: "Urgent", high: "High", medium: "Med", low: "Low" };

/** A small priority chip; nothing for "none". */
function prioBadge(i) {
  const p = i.meta.priority;
  return PRIO_LABEL[p] ? `<span class="prio p-${p}" title="${p} priority">${PRIO_LABEL[p]}</span>` : "";
}

/** The "Priority" filter shared by Today and Tree: minimum level shown. */
function prioFilter() {
  const o = (v, label) => `<option value="${v}"${ui.minPriority === v ? " selected" : ""}>${label}</option>`;
  return `<select id="min-priority" class="prio-filter" aria-label="Minimum priority">` +
    o("any", "All priorities") + o("urgent", "Urgent only") + o("high", "High and up") +
    o("medium", "Medium and up") + o("low", "Low and up") + `</select>`;
}
function bindPrioFilter(rerender) {
  $("#min-priority").onchange = (e) => { ui.minPriority = e.target.value; saveUi(); rerender(); };
}

function issueLink(i, extra = "") {
  const pend = i.pending ? ` <span class="pending-mark">●</span>` : "";
  return `<a class="item" href="#${esc(i.id)}"><span class="t${i.private ? " lock" : ""}">${esc(i.title)}${pend}</span>` +
    `${prioBadge(i)}${extra}<span class="id">${esc(i.id)}</span></a>`;
}

function statusPill(i) {
  return `<span class="pill st-${esc(i.status)}">${esc(i.status)}</span>`;
}

/** Plain words for the errors a first sync usually hits. */
function explain(e) {
  if (e.offline) return "Can't reach GitHub — check the connection.";
  if (e.status === 401) return "GitHub rejected the token (expired, deleted or mistyped). Paste a new one in Settings.";
  if (e.status === 403 || e.status === 404) return `The token can't see ${settings.owner}/${settings.repo}. ` +
    "Give it access to that repository with Contents: Read and write, or check Owner and Repo in Settings.";
  return e.message;
}

function needStore(view) {
  if (store && store.head) return true;
  view.innerHTML = store
    ? (syncError
      ? `<div class="card"><h2>Couldn't load the tracker</h2><p>${esc(syncError)}</p>` +
        `<div class="btns"><button class="btn" id="retry">Try again</button><a class="btn ghost" href="#settings">Settings</a></div></div>`
      : `<p class="empty">Loading the tracker…</p>`)
    : `<div class="card"><h2>Welcome</h2><p>Connect this phone to <b>${esc(settings.owner)}/${esc(settings.repo)}</b> in Settings to start.</p>` +
      `<a class="btn" href="#settings">Open Settings</a></div>`;
  $("#retry")?.addEventListener("click", () => { syncError = ""; route(); sync(); });
  return false;
}

// ---------------------------------------------------------------- actions: 📅 due · 💤 snooze · — Owner

const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const addDays = (n) => { const t = new Date(`${todayDate()}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const nextMonday = () => { const t = new Date(`${todayDate()}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + (((8 - t.getUTCDay()) % 7) || 7)); return t.toISOString().slice(0, 10); };

function chips(it, { owners = true } = {}) {
  let h = "";
  if (it.due) h += `<span class="pill${it.days < 0 ? " warn" : it.days <= 3 ? " accent" : ""}">` +
    `${it.days < 0 ? `${-it.days}d late` : it.days === 0 ? "today" : it.days === 1 ? "tomorrow" : shortDate(it.due)}</span>`;
  if (it.snoozed) h += `<span class="pill snz">💤 ${shortDate(it.snooze)}</span>`;
  if (it.waiting) h += `<span class="pill wait${it.waited >= 7 ? " warn" : ""}">⏳ ${it.waited}d</span>`;
  if (owners) for (const o of it.owners || []) h += `<span class="pill own">${esc(o)}</span>`;
  return h ? ` <span class="chips">${h}</span>` : "";
}

/** A tickable action row (Today, Focus, Home), with a ⋯ for date/snooze/owner. */
function actionRow(issue, it, where = "") {
  return `<div class="t-item${it.warn ? " warn" : ""}${it.snoozed ? " snoozed" : ""}">` +
    `<input type="checkbox" data-id="${esc(issue.id)}" data-n="${it.n}" aria-label="Done">` +
    `<span class="x">${renderInline(it.core, titles())}${chips(it)}${where}</span>` +
    `<button class="more" data-id="${esc(issue.id)}" data-n="${it.n}" aria-label="Due, snooze, owner">⋯</button></div>`;
}

/** Tick and ⋯ for every action row in a view. */
function wireActions(view) {
  view.onchange = async (e) => {
    const box = e.target;
    if (!box.matches(".t-item input[type=checkbox][data-n]")) return;
    const issue = store.issues.get(box.dataset.id);
    const a = iss.actionAt(issue.body, Number(box.dataset.n));
    box.disabled = true;
    try {
      await act("tick", { id: issue.id, label: a.label, occurrence: a.occurrence, done: true }, { quiet: true });
      box.closest(".t-item").style.opacity = ".35";
      toast("Ticked");
    } catch { box.checked = false; box.disabled = false; }
  };
  view.onclick = (e) => {
    const b = e.target.closest("button.more");
    if (!b) return;
    e.preventDefault();
    metaSheet(store.issues.get(b.dataset.id), Number(b.dataset.n));
  };
}

function knownOwners() {
  const set = new Set(["Anshuman", "Ishika"]);
  for (const i of store.issues.values()) {
    if (i.locked) continue;
    for (const it of views.actionItems(i)) it.owners.forEach((o) => set.add(o));
  }
  return [...set].sort();
}

/** Every checkbox in the body with its metadata, whatever section it is in. */
function allItems(issue) {
  const body = "## Actions\n" + issue.body.split("\n").map((l) => (l.startsWith("## ") ? "## Actions" : l)).join("\n");
  return views.actionItems({ body }, undefined, { includeDone: true });
}

function metaSheet(issue, n) {
  const it = allItems(issue).find((x) => x.n === n);
  if (!it) return;
  const a = iss.actionAt(issue.body, n);
  const quick = (name, list) => list.map(([v, l]) => `<button type="button" class="btn quiet" data-${name}="${v}">${l}</button>`).join("");
  sheet(`<h3>${renderInline(it.core, titles())}</h3>` +
    `<label>Due<input type="date" name="due" value="${esc(it.due || "")}"></label>` +
    `<div class="quick">${quick("due", [[addDays(0), "Today"], [addDays(1), "Tomorrow"], [addDays(7), "+1 week"], ["", "Clear"]])}</div>` +
    `<label>Snooze until<input type="date" name="snooze" value="${esc(it.snooze || "")}"></label>` +
    `<div class="quick">${quick("snooze", [[addDays(1), "Tomorrow"], [addDays(3), "3 days"], [nextMonday(), "Monday"], ["", "Wake"]])}</div>` +
    `<label class="inline"><input type="checkbox" name="waiting"${it.waiting ? " checked" : ""}> Waiting on someone else` +
    `${it.waiting ? ` (since ${shortDate(it.waiting)})` : ""}</label>` +
    `<label>Owner<input name="owners" list="owner-list" value="${esc(it.owners.join(" & "))}" placeholder="Anshuman & Ishika"></label>` +
    `<datalist id="owner-list">${knownOwners().map((o) => `<option value="${esc(o)}">`).join("")}</datalist>` +
    `<p class="small muted">Saved into the line as 📅 · 💤 · — Owner. A snoozed action leaves Today and Home until its day.</p>`,
    (f) => {
      const owners = f.owners.value.split(/\s*(?:&|,|\band\b)\s*/).map((s) => s.trim()).filter(Boolean)
        .map((s) => s[0].toUpperCase() + s.slice(1));
      const changes = {};
      if ((f.due.value || null) !== it.due) changes.due = f.due.value || null;
      if ((f.snooze.value || null) !== it.snooze) changes.snooze = f.snooze.value || null;
      if (owners.join("&") !== it.owners.join("&")) changes.owners = owners;
      if (f.waiting.checked !== Boolean(it.waiting)) changes.waiting = f.waiting.checked ? todayDate() : null;
      if (!Object.keys(changes).length) return Promise.resolve();
      return act("editAction", { id: issue.id, label: a.label, occurrence: a.occurrence, ...changes });
    });
  $("#sheet-form").onclick = (e) => {
    const b = e.target.closest("button[data-due], button[data-snooze]");
    if (!b) return;
    const f = $("#sheet-form");
    if (b.dataset.due !== undefined) f.due.value = b.dataset.due;
    else f.snooze.value = b.dataset.snooze;
  };
}

// ---------------------------------------------------------------- screens

function screenHome(view) {
  setTitle("Periodicity"); setTab("home");
  if (!needStore(view)) return;
  const h = views.home(snap());
  const j = h.journal;
  let html = `<div class="date">${esc(h.today)}</div>`;
  html += `<div class="stats"><div class="stat${h.totals.warn ? " warn" : ""}"><b>${h.totals.warn}</b><span>⚠ warnings</span></div>` +
    `<div class="stat"><b>${h.totals.open}</b><span>open actions</span></div>` +
    `<div class="stat"><b>${h.totals.issues}</b><span>live issues</span></div></div>`;

  html += `<section class="card"><h2>Journal · ${esc(j.heading)}</h2>`;
  if (!j.configured) html += `<p class="muted small">No Journchive found. Add <code>[journal] parent = "P-…"</code> to config.toml.</p>`;
  else if (j.locked) html += `<p class="muted small">The Journchive is encrypted. Add the git-crypt key in Settings.</p>`;
  else {
    html += j.entries.length ? j.entries.map((e) => `<div class="journal-entry"><time>${esc(e.time)}</time><div class="grow">${renderInline(e.text, titles())}` +
      `${e.feeling && e.feeling !== "—" ? ` <span class="muted small">· ${esc(e.feeling)}</span>` : ""}</div></div>`).join("")
      : `<p class="muted small">Nothing yet today.</p>`;
    html += `<form class="journal-form" id="journal-form" autocomplete="off"><input name="text" placeholder="What did you do?" enterkeyhint="done">` +
      `<div class="row"><input name="feeling" placeholder="Feeling (optional)"><button class="btn">Add</button></div></form>`;
  }
  html += `</section>`;

  const block = (title, items, extra) => items.length
    ? `<section class="card"><h2>${title}</h2><ul class="list">${items.map((x) => `<li>${extra(x)}</li>`).join("")}</ul></section>` : "";
  if (h.countdowns.length) {
    html += `<div class="cds">${h.countdowns.map((c) => {
      const pct = c.total ? Math.round((100 * c.done) / c.total) : 0;
      return `<a class="cd" href="#${esc(c.issue.id)}/focus"><b>${c.days < 0 ? -c.days : c.days}</b>` +
        `<span>${c.days < 0 ? "days ago" : c.days === 1 ? "day to go" : "days to go"}</span>` +
        `<div class="cd-t">${esc(c.issue.title)}</div><div class="small muted">${c.open} open${c.overdue ? ` · ${c.overdue} overdue` : ""} · ${pct}%</div>` +
        `<div class="progress"><i style="width:${pct}%"></i></div></a>`;
    }).join("")}</div>`;
  }
  const weekItems = h.week.reduce((n, d) => n + d.items.length, 0);
  if (weekItems) {
    html += `<section class="card"><h2>The week ahead</h2>` + h.week.filter((d) => d.items.length).map((d) =>
      `<div class="wk-h${d.label === "Overdue" ? " over" : ""}">${esc(d.label)}</div>` + d.items.map((it) => it.kind === "action"
        ? actionRow(it.issue, it, ` <a class="where" href="#${esc(it.issue.id)}">${esc(it.issue.title)}</a>`)
        : it.kind === "event"
          ? `<div class="wk-ev">◆ ${renderInline(it.text, titles())} <a class="where" href="#${esc(it.issue.id)}">${esc(it.issue.title)}</a></div>`
          : `<div class="wk-ev">■ <a href="#${esc(it.issue.id)}"><b>${esc(it.issue.title)}</b></a> <span class="muted small">due</span></div>`).join("")).join("") +
      `</section>`;
  }
  for (const t of h.tiles) {
    html += `<section class="card"><h2><a href="#${esc(t.issue.id)}" style="color:inherit">${esc(t.issue.title)}</a></h2><div class="md">${render(t.text, titles())}</div></section>`;
  }
  if (h.waiting.length) {
    html += `<section class="card"><h2>Waiting on others</h2>` +
      h.waiting.map((w) => actionRow(w.issue, w, ` <a class="where" href="#${esc(w.issue.id)}">${esc(w.issue.title)}</a>`)).join("") + `</section>`;
  }
  if (h.dueActions.length && !weekItems) {
    html += `<section class="card"><h2>Actions due · next 2 weeks</h2>` +
      h.dueActions.map((a) => actionRow(a.issue, a, ` <a class="where" href="#${esc(a.issue.id)}">${esc(a.issue.title)}</a>`)).join("") + `</section>`;
  }
  html += block("Due", h.upcoming, (u) => issueLink(u.issue, ` <span class="pill${u.days < 0 ? " warn" : u.days <= 3 ? " accent" : ""}">` +
    `${u.days < 0 ? `${-u.days}d late` : u.days === 0 ? "today" : `${u.days}d`}</span>`));
  html += block("Urgent &amp; high", h.priority, (i) => issueLink(i, i.meta.due ? ` <span class="pill">${esc(String(i.meta.due).slice(5).split("-").reverse().join("-"))}</span>` : ""));
  html += block("Pinned", h.pinned, (i) => issueLink(i));
  html += block("In progress", h.inProgress, (i) => issueLink(i));
  html += block("Recently changed", h.recent, (i) => issueLink(i));
  html += block("Not touched in two weeks", h.neglected, (n) => issueLink(n.issue, ` <span class="pill">${n.open} open · ${n.idle}d</span>`));
  html += `<section><div class="section-title">Areas</div><div class="areas">` + h.areas.map((a) =>
    `<a class="area" href="#${esc(a.issue.id)}/focus"><b class="${a.issue.private ? "lock" : ""}">${esc(a.issue.title)}</b>` +
    `<div class="n">${a.open} open${a.warn ? ` · <span style="color:var(--coral)">${a.warn} ⚠</span>` : ""} · ${a.issues} issues</div></a>`).join("") + `</div></section>`;
  view.innerHTML = html;
  wireActions(view);

  $("#journal-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.text.value.trim()) return;
    try {
      await act("journalAdd", { text: f.text.value, feeling: f.feeling.value });
      route();
    } catch {}
  });
}

function screenToday(view) {
  setTitle("Today"); setTab("today");
  if (!needStore(view)) return;
  const all = views.today(snap());
  const groups = all.map((g) => ({ ...g, issues: g.issues.filter(({ issue }) => views.atLeast(issue, ui.minPriority)) }))
    .filter((g) => g.issues.length);
  const head = `<div class="filters">${prioFilter()}<span class="grow"></span></div>`;
  if (!groups.length) {
    view.innerHTML = head + `<p class="empty">${all.length ? "No open actions at this priority." : "No open actions. 🎉"}</p>`;
    bindPrioFilter(() => screenToday(view));
    return;
  }
  const t = titles();
  view.innerHTML = head + groups.map((g) => `<section class="t-group"><a class="section-title" href="#${esc(g.area)}/focus">${esc(g.areaTitle)} ›</a>` +
    g.issues.map(({ issue, items }) => `<div class="card"><a class="t-issue" href="#${esc(issue.id)}">${esc(issue.title)} ${prioBadge(issue)}<span class="id">${esc(issue.id)}</span></a>` +
      items.map((it) => actionRow(issue, it)).join("") + `</div>`).join("") + `</section>`).join("");
  wireActions(view);
  bindPrioFilter(() => screenToday(view));
}

// ---------------------------------------------------------------- focus: one project

function screenFocus(view, id) {
  setTab("");
  if (!needStore(view)) return;
  const f = views.focus(snap(), id.toUpperCase());
  if (!f) { setTitle(id, true); view.innerHTML = `<p class="empty">No issue ${esc(id)}.</p>`; return; }
  setTitle("Focus", true);
  const p = ui.focus || (ui.focus = { owner: "", only: "", snoozed: false });
  const t = f.totals;
  const pct = t.total ? Math.round((100 * t.done) / t.total) : 0;
  const keepIt = (it) => (p.snoozed || !it.snoozed)
    && (!p.owner || (p.owner === "(no owner)" ? !it.owners.length : it.owners.includes(p.owner)))
    && (p.only !== "flagged" || it.flag) && (p.only !== "overdue" || (it.days !== null && it.days < 0))
    && (p.only !== "week" || (it.days !== null && it.days >= 0 && it.days <= 7));
  const stat = (key, n, label) => `<button class="stat${p.only === key ? " on" : ""}${key && key !== "week" && n ? " warn" : ""}" data-only="${key}"><b>${n}</b><span>${label}</span></button>`;
  let html = `<h2 class="issue-title"><a href="#${esc(f.issue.id)}">${esc(f.issue.title)}</a></h2>` +
    `<p class="small muted">${t.done} of ${t.total} actions done · ${t.issues} issues` +
    `${f.days !== null ? ` · ${f.days < 0 ? `${-f.days} days past` : `${f.days} days to go`}` : ""}</p>` +
    `<div class="progress"><i style="width:${pct}%"></i></div>` +
    `<div class="stats">${stat("", t.open, "open")}${stat("flagged", t.flagged, "flagged")}${stat("overdue", t.overdue, "overdue")}${stat("week", t.dueWeek, "this week")}</div>` +
    `<div class="f-tools"><select id="f-owner"><option value="">Everyone</option>${f.owners.map(([o, n]) =>
      `<option value="${esc(o)}"${p.owner === o ? " selected" : ""}>${esc(o)} · ${n}</option>`).join("")}</select>` +
    `<label class="inline"><input type="checkbox" id="f-snz"${p.snoozed ? " checked" : ""}> Snoozed (${t.snoozed})</label></div>`;
  let shown = 0, clear = 0;
  for (const g of f.groups) {
    const items = g.items.filter(keepIt);
    if (!items.length) { if (g.total && !g.items.length) clear++; continue; }
    shown += items.length;
    html += `<div class="card f-card" style="margin-left:${Math.min(g.depth, 3) * 10}px"><a class="t-issue" href="#${esc(g.issue.id)}">${esc(g.issue.title)}` +
      ` <span class="id">${g.done}/${g.total}</span></a>${items.map((it) => actionRow(g.issue, it)).join("")}</div>`;
  }
  if (!shown) html += `<p class="empty">Nothing matches.</p>`;
  if (clear) html += `<p class="small faint">✓ ${clear} sub-issue${clear > 1 ? "s" : ""} with every action done.</p>`;
  const money = views.money(snap(), f.issue.id);
  if (money.length) {
    html += `<section class="card"><h2>Money in tables · ${tables.rupees(money.reduce((s, m) => s + m.total, 0))}</h2><ul class="list">` +
      money.map((m) => `<li>${issueLink(m.issue, ` <span class="pill">${esc(m.column)} ${esc(m.shown)}</span>`)}</li>`).join("") + `</ul></section>`;
  }
  view.innerHTML = html;
  wireActions(view);
  const click = view.onclick;
  view.onclick = (e) => {
    const s = e.target.closest("[data-only]");
    if (s) { p.only = p.only === s.dataset.only ? "" : s.dataset.only; saveUi(); route(); return; }
    click(e);
  };
  $("#f-owner").onchange = (e) => { p.owner = e.target.value; saveUi(); route(); };
  $("#f-snz").onchange = (e) => { e.stopPropagation(); p.snoozed = e.target.checked; saveUi(); route(); };
}

function screenTree(view) {
  setTitle("Tree"); setTab("tree");
  if (!needStore(view)) return;
  const s = snap();
  const hidden = (i) => ui.hideDone && (i.status === "done" || i.status === "cancelled");
  // with a priority filter, keep an issue if it or anything under it qualifies, and open the path to it
  const filtering = ui.minPriority && ui.minPriority !== "any";
  const memo = new Map();
  const keep = (i) => {
    if (memo.has(i.id)) return memo.get(i.id);
    memo.set(i.id, false);                                  // guards against parent cycles
    const ok = !hidden(i) && (views.atLeast(i, ui.minPriority) || views.children(s, i.id).some(keep));
    memo.set(i.id, ok);
    return ok;
  };
  const node = (i, depth) => {
    const kids = views.children(s, i.id).filter(keep);
    const open = filtering ? true : ui.open[i.id] ?? depth < 1;
    const n = i.openActions();
    return `<li><div class="node${i.status === "done" ? " done" : ""}">` +
      (kids.length ? `<button class="tw" data-tw="${esc(i.id)}" aria-label="${open ? "Collapse" : "Expand"}">${open ? "▾" : "▸"}</button>` : `<span class="tw"></span>`) +
      `<a href="#${esc(i.id)}" class="${i.private ? "lock" : ""}${filtering && !views.atLeast(i, ui.minPriority) ? " dim" : ""}">${esc(i.title)}</a>` +
      `${prioBadge(i)}${n ? `<span class="cnt">${n}</span>` : ""}</div>` +
      (kids.length && open ? `<ul>${kids.map((k) => node(k, depth + 1)).join("")}</ul>` : "") + `</li>`;
  };
  const roots = views.roots(s).filter((i) => !i.locked && keep(i));
  const locked = [...s.issues.values()].filter((i) => i.locked && i.status !== "archived");
  view.innerHTML = `<div class="filters"><label><input type="checkbox" id="hide-done"${ui.hideDone ? " checked" : ""}> Hide done</label>` +
    prioFilter() + `<span class="grow"></span><button class="btn ghost" id="new-root">+ New issue</button></div>` +
    `<ul class="tree">${roots.map((r) => node(r, 0)).join("")}</ul>` +
    (locked.length ? `<div class="card" style="margin-top:14px"><h2>Encrypted (${locked.length})</h2><p class="small muted">` +
      `Add the git-crypt key in Settings to read these and place them in the tree.</p><ul class="list">${locked.map((i) => `<li>${issueLink(i)}</li>`).join("")}</ul></div>` : "");
  view.onclick = (e) => {
    const tw = e.target.closest("[data-tw]");
    if (!tw) return;
    const id = tw.dataset.tw;
    ui.open[id] = !(ui.open[id] ?? tw.textContent === "▾"); saveUi();
    screenTree(view);
  };
  $("#hide-done").onchange = (e) => { ui.hideDone = e.target.checked; saveUi(); screenTree(view); };
  bindPrioFilter(() => screenTree(view));
  $("#new-root").onclick = () => newIssueSheet(null);
}

let lastQuery = "";
function screenSearch(view) {
  setTitle("Search"); setTab("search");
  if (!needStore(view)) return;
  view.innerHTML = `<input id="q" type="search" placeholder="Title, text, id or KAN-/PER- key" value="${esc(lastQuery)}" enterkeyhint="search">` +
    `<label class="small muted" style="display:flex;gap:6px;margin:8px 0"><input type="checkbox" id="qa" style="width:auto"> Include archived</label><div id="results"></div>`;
  const run = () => {
    lastQuery = $("#q").value;
    const hits = views.search(snap(), lastQuery, { archived: $("#qa").checked });
    $("#results").innerHTML = !lastQuery.trim() ? "" : hits.length
      ? `<ul class="list">${hits.map((h) => `<li>${issueLink(h.issue)}<div class="small faint" style="margin:-6px 0 10px">${esc(h.snippet)}</div></li>`).join("")}</ul>`
      : `<p class="empty">No matches.</p>`;
  };
  $("#q").oninput = run; $("#qa").onchange = run;
  run();
  if (!lastQuery) setTimeout(() => $("#q").focus(), 50);
}

function screenIssue(view, id) {
  setTab("");
  if (!needStore(view)) return;
  const s = snap();
  const issue = store.issues.get(id.toUpperCase());
  if (!issue) { setTitle(id, true); view.innerHTML = `<p class="empty">No issue ${esc(id)}.</p>`; return; }
  setTitle(issue.id, true);
  if (issue.locked) {
    view.innerHTML = `<div class="issue-title lock">${esc(issue.title)}</div><div class="locked-note">This issue is encrypted with git-crypt. ` +
      `Add the key in <a href="#settings">Settings</a> to read and edit it on this phone.</div>`;
    return;
  }
  const t = titles();
  const crumbs = views.ancestors(s, issue);
  const kids = views.children(s, issue.id, { archived: true });
  const back = views.backlinks(s, issue.id);
  const boxes = issue.body.split("\n").filter((l) => iss.CHECKBOX.test(l));
  const done = boxes.filter((l) => iss.CHECKBOX.exec(l)[2] !== " ").length;

  // render the whole body once so checkbox numbering matches the file
  const labs = (issue.meta.labels || []).map((l) => String(l).toLowerCase());
  const opts = (list, cur) => list.map((x) => `<option${x === cur ? " selected" : ""}>${x}</option>`).join("");
  let html = crumbs.length ? `<div class="crumbs">${crumbs.map((c) => `<a href="#${esc(c.id)}">${esc(c.title)}</a>`).join(" › ")}</div>` : "";
  html += `<h2 class="issue-title${issue.private ? " lock" : ""}" id="rename">${esc(issue.title)}${issue.pending ? ` <span class="pending-mark">● waiting to sync</span>` : ""}</h2>`;
  html += `<div class="meta">` +
    (issue.status === "archived" ? `<span class="pill">archived</span>`
      : `<select id="f-status" aria-label="Status">${opts(iss.STATUSES.filter((x) => x !== "archived"), issue.status)}</select>`) +
    `<select id="f-priority" aria-label="Priority">${opts(iss.PRIORITIES, issue.meta.priority || "none")}</select>` +
    `<input id="f-due" type="date" aria-label="Due" value="${esc(issue.meta.due || "")}">` +
    `<button class="pin${issue.meta.pinned ? " on" : ""}" id="f-pin">${issue.meta.pinned ? "★ Pinned" : "☆ Pin"}</button>` +
    `<button class="pin${labs.includes("countdown") ? " on" : ""}" id="f-cd">⏱ Countdown</button>` +
    `<button class="pin${labs.includes("calendar") ? " on" : ""}" id="f-cal">▦ Calendar</button></div>`;
  if (boxes.length) html += `<div class="progress" title="${done}/${boxes.length} actions done"><i style="width:${(100 * done / boxes.length).toFixed(1)}%"></i></div>`;
  const rendered = render(issue.body, t);
  html += `<div class="md" id="body">${rendered}</div>`;
  html += `<div class="btns"><button class="btn ghost" id="add-action">+ Action</button><button class="btn ghost" id="new-child">+ Child issue</button>` +
    `<button class="btn quiet" id="edit">Edit text</button>` +
    `${kids.length || boxes.length ? `<a class="btn quiet" href="#${esc(issue.id)}/focus">Focus</a>` : ""}</div>`;
  if (kids.length) html += `<section class="card" style="margin-top:16px"><h2>Children</h2><ul class="list">${kids.map((k) => `<li>${issueLink(k, statusPill(k))}</li>`).join("")}</ul></section>`;
  if (back.length) html += `<section class="card"><h2>Linked from</h2><ul class="list">${back.map((b) => `<li>${issueLink(store.issues.get(b.from), `<span class="pill">${esc(b.type)}</span>`)}</li>`).join("")}</ul></section>`;
  html += `<p class="small faint">Updated ${esc((issue.meta.updated || "").replace("T", " ").slice(0, 16))} · created ${esc((issue.meta.created || "").slice(0, 10))}` +
    `${issue.meta.legacy?.length ? ` · was ${esc(issue.meta.legacy.join(", "))}` : ""}</p>`;
  view.innerHTML = html;
  foldLog($("#body"));
  decorateBody($("#body"), issue);
  enhanceTables($("#body"), issue);

  const set = async (fields) => { try { await act("update", { id: issue.id, fields }, { quiet: true }); toast("Saved"); } catch {} route(); };
  $("#f-status") && ($("#f-status").onchange = (e) => set({ status: e.target.value }));
  $("#f-priority").onchange = (e) => set({ priority: e.target.value });
  $("#f-due").onchange = (e) => set({ due: e.target.value || null });
  $("#f-pin").onclick = () => set({ pinned: !issue.meta.pinned });
  const toggleLabel = (name) => {
    const list = (issue.meta.labels || []).map(String);
    const has = list.some((l) => l.toLowerCase() === name);
    if (!has && name === "countdown" && !issue.meta.due) { toast("Set a due date first — the countdown runs to it", true); return; }
    set({ labels: has ? list.filter((l) => l.toLowerCase() !== name) : [...list, name] });
  };
  $("#f-cd").onclick = () => toggleLabel("countdown");
  $("#f-cal").onclick = () => toggleLabel("calendar");
  $("#rename").onclick = () => renameSheet(issue);
  $("#add-action").onclick = () => actionSheet(issue);
  $("#new-child").onclick = () => newIssueSheet(issue);
  $("#edit").onclick = () => editSheet(issue);
  $("#body").onclick = (e) => {
    const more = e.target.closest("button.more");
    if (more) { e.preventDefault(); metaSheet(issue, Number(more.dataset.n)); return; }
    const th = e.target.closest(".tbl th");
    if (th) { sortTable(th); return; }
    const add = e.target.closest(".tbl-add");
    if (add) { rowSheet(issue, Number(add.dataset.k), null); return; }
    const tr = e.target.closest(".tbl tbody tr");
    if (tr && !e.target.closest("a")) rowSheet(issue, Number(tr.closest(".tbl").dataset.k), tr.dataset.row);
  };
  $("#body").oninput = (e) => {
    if (!e.target.matches(".tbl-q")) return;
    const q = e.target.value.toLowerCase();
    $$("tbody tr", e.target.closest(".tbl")).forEach((tr) => { tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q); });
  };
  $("#body").onchange = async (e) => {
    if (!e.target.classList.contains("tick")) return;
    const box = e.target;
    const a = iss.actionAt(issue.body, Number(box.dataset.n));
    box.disabled = true;
    try { await act("tick", { id: issue.id, label: a.label, occurrence: a.occurrence, done: box.checked }, { quiet: true }); }
    catch { box.checked = !box.checked; }
    route();
  };

  composer(issue.status !== "archived");
  $("#composer").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("#log-text").value.trim();
    if (!text) return;
    try {
      await act("addLog", { id: issue.id, kind: $("#log-type").value, text });
      $("#log-text").value = "";
      ui.logOpen = true; saveUi();
      route();
    } catch {}
  };
}

const META_TOKEN = /\s*(📅|💤|⏳)\s*\d{4}-\d{2}-\d{2}/g;

/** Body actions: hide the raw 📅/💤 tokens, show chips and a ⋯ button. */
function decorateBody(root, issue) {
  const meta = new Map(allItems(issue).map((x) => [x.n, x]));
  for (const box of $$("input.tick", root)) {
    const it = meta.get(Number(box.dataset.n));
    const li = box.closest("li");
    if (!it || !li) continue;
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest("ul,ol") === li.parentElement ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) if (/[📅💤⏳]/u.test(t.nodeValue)) t.nodeValue = t.nodeValue.replace(META_TOKEN, "");
    const holder = document.createElement("span");
    holder.innerHTML = (it.done ? "" : chips(it, { owners: false })) +
      (issue.status === "archived" ? "" : ` <button class="more" data-n="${it.n}" aria-label="Due, snooze, owner">⋯</button>`);
    const nested = $(":scope > ul, :scope > ol", li);
    [...holder.childNodes].forEach((n) => li.insertBefore(n, nested));
  }
}

/** Tables: tap a heading to sort, filter long ones, tap a row to edit it. */
function enhanceTables(root, issue) {
  const src = tables.find(issue.body);
  $$("table", root).forEach((table, k) => {
    const t = src[k];
    const heads = $$("thead th", table);
    const editable = t && t.header.length === heads.length && issue.status !== "archived";
    const wrap = document.createElement("div");
    wrap.className = "tbl";
    wrap.dataset.k = k;
    const rows = $$("tbody tr", table);
    if (editable) rows.forEach((tr, i) => { tr.dataset.row = i; });
    wrap.innerHTML = `<div class="tbl-bar">${rows.length > 6 ? `<input class="tbl-q" type="search" placeholder="Filter ${rows.length} rows">` : `<span class="small faint">${rows.length} rows</span>`}` +
      (editable ? `<button type="button" class="btn quiet tbl-add" data-k="${k}">+ Row</button>` : "") + `</div>`;
    table.replaceWith(wrap);
    wrap.appendChild(table);
    if (!editable) wrap.classList.add("ro");
    const sums = editable ? tables.totals(t.header, t.rows) : {};
    if (Object.keys(sums).length) {
      const foot = document.createElement("tfoot");
      foot.innerHTML = `<tr>${heads.map((_, c) => `<td>${c === 0 ? "Total" : sums[c] !== undefined ? esc(tables.rupees(sums[c])) : ""}</td>`).join("")}</tr>`;
      table.appendChild(foot);
    }
  });
}

function sortTable(th) {
  const table = th.closest("table");
  const heads = $$("thead th", table);
  const c = heads.indexOf(th);
  const dir = th.dataset.sort === "asc" ? "desc" : "asc";
  heads.forEach((h) => delete h.dataset.sort);
  th.dataset.sort = dir;
  const key = (tr) => (tr.children[c]?.textContent || "").trim();
  const num = (s) => { const n = Number(s.replace(/[,₹%\s]/g, "")); return s && !Number.isNaN(n) ? n : null; };
  const body = $("tbody", table);
  $$("tr", body).sort((a, b) => {
    const x = key(a), y = key(b), nx = num(x), ny = num(y);
    const r = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true });
    return dir === "asc" ? r : -r;
  }).forEach((tr) => body.appendChild(tr));
}

function rowSheet(issue, k, rowIndex) {
  const t = tables.find(issue.body)[k];
  if (!t) return;
  const before = rowIndex === null || rowIndex === undefined ? null : t.rows[Number(rowIndex)];
  const unesc = (s) => (s || "").replace(/\\\|/g, "|");
  sheet(`<h3>${before ? "Edit row" : "New row"} · table ${k + 1}</h3>` +
    t.header.map((h, c) => `<label>${esc(unesc(h).replace(/\*\*/g, ""))}<textarea name="c${c}" rows="1">${esc(unesc(before ? before[c] : ""))}</textarea></label>`).join("") +
    (before ? `<label class="inline"><input type="checkbox" name="del"> Delete this row</label>` : "") +
    `<p class="small muted">Cells are Markdown. Refused if this row changed on another machine.</p>`,
    (f) => act("editRow", { id: issue.id, k, header: t.header, before,
      after: before && f.del?.checked ? null : t.header.map((_, c) => f[`c${c}`].value) }));
}

/** Wrap the rendered `## Log` section (to the next h2) in a <details>. */
function foldLog(root) {
  for (const h of $$("h2", root)) {
    const name = h.textContent.trim();
    if (name !== "Log" && name !== "Attached documents") continue;
    const det = document.createElement("details");
    det.className = "fold";
    if (name === "Log" && ui.logOpen) det.open = true;
    det.addEventListener("toggle", () => { if (name === "Log") { ui.logOpen = det.open; saveUi(); } });
    const sum = document.createElement("summary");
    sum.textContent = name;
    det.append(sum);
    const box = document.createElement("div");
    box.className = name === "Log" ? "log-body" : "";
    let n = h.nextSibling;
    while (n && !(n.nodeName === "H2")) { const next = n.nextSibling; box.append(n); n = next; }
    det.append(box);
    h.replaceWith(det);
  }
}

// ---------------------------------------------------------------- sheets

function sheet(html, onSubmit) {
  const d = $("#sheet"), f = $("#sheet-form");
  f.innerHTML = html + `<div class="btns"><button class="btn" value="ok">Save</button><button class="btn quiet" value="cancel" formnovalidate>Cancel</button></div>`;
  f.onsubmit = async (e) => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    try { await onSubmit(f); d.close(); route(); } catch { if (btn) btn.disabled = false; }
  };
  d.showModal();
  setTimeout(() => f.querySelector("input, textarea")?.focus(), 60);
}

function actionSheet(issue) {
  sheet(`<h3>New action on ${esc(issue.id)}</h3><label>Action<input name="text" required placeholder="Start with ⚠ to flag it"></label>`,
    (f) => act("addAction", { id: issue.id, text: f.text.value }));
}

function renameSheet(issue) {
  sheet(`<h3>Rename ${esc(issue.id)}</h3><label>Title<input name="title" required value="${esc(issue.title)}"></label>`,
    (f) => act("update", { id: issue.id, fields: { title: f.title.value } }));
}

function editSheet(issue) {
  sheet(`<h3>Edit ${esc(issue.id)}</h3><label>Markdown<textarea name="body" spellcheck="true">${esc(issue.body)}</textarea></label>` +
    `<p class="small muted">Refused if the issue changed on another machine since you opened it.</p>`,
    (f) => act("update", { id: issue.id, body: f.body.value, expectedUpdated: issue.meta.updated }));
}

function newIssueSheet(parent) {
  let prefix = null;
  try { prefix = ops.prefix(snap()); } catch { /* not registered */ }
  if (!prefix) { toast("Register this phone in Settings before creating issues", true); location.hash = "#settings"; return; }
  sheet(`<h3>New ${parent ? `child of ${esc(parent.title)}` : "top-level issue"}</h3>` +
    `<label>Title<input name="title" required></label>` +
    `<label>Lede<input name="lede" placeholder="**One line in bold.**"></label>` +
    `<label>Status<select name="status">${iss.STATUSES.filter((s) => s !== "archived").map((s) => `<option${s === "todo" ? " selected" : ""}>${s}</option>`).join("")}</select></label>` +
    (parent ? `<p class="small muted">${parent.private || ops.isPrivate(parent) ? "🔒 Private, like its parent (encrypted)." : "Public, like its parent."}</p>`
      : `<label class="inline"><input type="checkbox" name="private"> Private (encrypted with git-crypt)</label>`),
    async (f) => {
      const made = await act("create", { title: f.title.value, parent: parent ? parent.id : null, lede: f.lede.value,
        status: f.status.value, private: parent ? null : f.private.checked });
      if (made?.id) setTimeout(() => { location.hash = "#" + made.id; }, 0);
    });
}

// ---------------------------------------------------------------- settings

function screenSettings(view) {
  setTitle("Settings"); setTab("settings");
  let prefix = null;
  try { if (store?.head) prefix = ops.prefix(snap()); } catch {}
  const privateCount = store ? [...store.issues.values()].filter((i) => i.private).length : 0;
  const lockedCount = store ? [...store.issues.values()].filter((i) => i.locked).length : 0;
  view.innerHTML = `
  ${!settings.token ? `<div class="card"><h2>Set up</h2><ol class="steps">
    <li>On github.com, open <b>Settings → Developer settings → Fine-grained tokens → Generate new token</b>.</li>
    <li>Repository access: <b>Only select repositories → ${esc(settings.repo)}</b>. Permissions: <b>Contents: Read and write</b>. Set a long expiry.</li>
    <li>Paste the token below, then add the git-crypt key so private issues open.</li>
    <li>In Safari, tap <b>Share → Add to Home Screen</b>.</li></ol></div>` : ""}
  <form class="card" id="gh"><h2>GitHub</h2>
    <label class="field">Token<input name="token" type="password" autocomplete="off" placeholder="github_pat_…" value="${esc(settings.token)}"></label>
    <div class="row"><label class="field grow">Owner<input name="owner" value="${esc(settings.owner)}"></label>
    <label class="field grow">Repo<input name="repo" value="${esc(settings.repo)}"></label></div>
    <button class="btn">Save and sync</button>
  </form>
  <div class="card"><h2>git-crypt key</h2>
    <p class="small muted">${settings.key ? "✓ Key added. " + (lockedCount ? `${lockedCount} files still locked — wrong key?` : `${privateCount} private issues open.`)
      : `Needed for private issues${lockedCount ? ` (${lockedCount} locked)` : ""}. On a computer: <code>git-crypt export-key periodicity.key</code>, then AirDrop or Files it to the phone.`}</p>
    <input type="file" id="keyfile">
    ${settings.key ? `<div class="btns"><button class="btn quiet" id="forget-key">Remove key</button></div>` : ""}
  </div>
  <div class="card"><h2>This phone</h2>
    ${store?.head ? (prefix ? `<p>Creates issues as <b>${esc(prefix)}0001</b>, <b>${esc(prefix)}0002</b>, …</p>`
      : `<p class="small muted">Not registered: it can log, tick and edit, but needs its own id prefix to create issues, so two machines never hand out the same id.</p>
         <button class="btn" id="register">Register as ${ops.DEFAULT_PREFIX}</button>`) : `<p class="small muted">Connect first.</p>`}
  </div>
  <div class="card"><h2>Sync</h2><dl class="kv">
    <dt>Status</dt><dd>${esc(syncState)}${queue.length ? ` · ${queue.length} waiting` : ""}</dd>
    <dt>Last sync</dt><dd>${lastSync ? esc(new Date(lastSync).toLocaleString()) : "never"}</dd>
    <dt>Commit</dt><dd>${store?.head ? esc(store.head.slice(0, 10)) : "—"}</dd>
    <dt>Issues</dt><dd>${store ? store.issues.size : 0}</dd></dl>
    <div class="btns"><button class="btn ghost" id="sync-now">Sync now</button><button class="btn quiet" id="reset">Clear local data</button></div>
  </div>
  <div class="card"><h2>Appearance</h2><select id="theme">${["dark", "light", "auto"].map((t) => `<option${settings.theme === t ? " selected" : ""}>${t}</option>`).join("")}</select></div>
  <p class="small faint">Periodicity mobile ${VERSION}. The token and key stay on this phone; edits go straight to GitHub as commits on ${esc(settings.branch)}.
    After each sync it also writes a status report (version, sync state, counts — no issue text) to the <code>${STATUS_BRANCH}</code> branch.</p>`;

  $("#gh").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    Object.assign(settings, { token: f.token.value.trim(), owner: f.owner.value.trim(), repo: f.repo.value.trim() });
    keep("p:settings", settings);
    localStorage.removeItem("p:state");
    await makeStore();
    await sync();
    route();
  };
  $("#keyfile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const { parseKeyFile } = await import("./core/gitcrypt.js");
      parseKeyFile(bytes);
      settings.key = toBase64(bytes); keep("p:settings", settings);
      await makeStore();
      await sync();
      toast("Key added");
    } catch (err) { toast(err.message, true); }
    route();
  };
  $("#forget-key")?.addEventListener("click", async () => { settings.key = ""; keep("p:settings", settings); await makeStore(); route(); });
  $("#register")?.addEventListener("click", async () => { try { await act("registerPhone", {}); } catch {} route(); });
  $("#sync-now").onclick = () => sync();
  $("#reset").onclick = async () => {
    if (!confirm("Clear the cached issues and settings on this phone? Nothing on GitHub is touched." + (queue.length ? `\n\n${queue.length} unsynced changes will be lost.` : ""))) return;
    await cache?.clear();
    ["p:settings", "p:state", "p:queue", "p:failed", "p:lastSync", "p:ui"].forEach((k) => localStorage.removeItem(k));
    location.reload();
  };
  $("#theme").onchange = (e) => {
    settings.theme = e.target.value; keep("p:settings", settings);
    if (settings.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
  };
}

// ---------------------------------------------------------------- routing

function route() {
  const view = $("#view");
  const hash = decodeURIComponent(location.hash.slice(1)) || "home";
  composer(false);
  view.onchange = null; view.onclick = null;
  const scroll = route.lastHash === hash ? window.scrollY : 0;
  route.lastHash = hash;
  if (hash === "home") screenHome(view);
  else if (hash === "today") screenToday(view);
  else if (hash === "tree") screenTree(view);
  else if (hash === "search") screenSearch(view);
  else if (hash === "settings") screenSettings(view);
  else if (hash.endsWith("/focus")) screenFocus(view, hash.slice(0, -"/focus".length));
  else screenIssue(view, hash);
  window.scrollTo(0, scroll);
  banner();
}

document.addEventListener("click", (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) { navigator.clipboard?.writeText(failed[Number(copy.dataset.copy)].args.body || ""); toast("Copied"); }
  if (e.target.id === "dismiss-failed") { failed = []; keep("p:failed", failed); banner(); }
});
$("#back").onclick = () => (history.length > 1 ? history.back() : (location.hash = "#home"));
$("#sync").onclick = () => sync();
window.addEventListener("hashchange", route);
window.addEventListener("online", () => sync({ quiet: true }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!lastSync || Date.now() - lastSync > 60 * 1000)) sync({ quiet: true });
});
setInterval(() => { if (document.visibilityState === "visible") sync({ quiet: true }); }, SYNC_EVERY);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  await makeStore();
  setSync(queue.length ? "offline" : "idle");
  route();
  if (store) {
    await sync({ quiet: true });
    route();
  } else if (!location.hash) {
    location.hash = "#settings";
  }
})();
