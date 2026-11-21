// Markdown pipe tables in an issue body. A line-for-line port of
// periodicity/tables.py (test/parity checks it). The n-th table here is the
// n-th <table> the renderer outputs.

const DELIM_CELL = /^\s*:?-+:?\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isDelim(line, n) {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length === n && cells.every((c) => DELIM_CELL.test(c));
}

/** [{start, end, header, rows, delim}], line indexes into body.split("\n"). */
export function find(body) {
  const lines = body.split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1] === fence) fence = null; i++; continue; }
    if (f) { fence = f[1]; i++; continue; }
    const indent = line.length - line.replace(/^ +/, "").length;
    if (line.includes("|") && indent < 4 && i + 1 < lines.length && isDelim(lines[i + 1], splitRow(line).length)) {
      const header = splitRow(line);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) { rows.push(splitRow(lines[j])); j++; }
      out.push({ start: i, end: j, header, rows, delim: lines[i + 1] });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

export function escapeCell(text) {
  return String(text ?? "").split(/\s+/).filter(Boolean).join(" ").replace(/(?<!\\)\|/g, "\\|");
}

export function formatTable(header, rows, delim = null) {
  const n = header.length;
  const fmt = (cells) => "| " + cells.map(escapeCell).join(" | ") + " |";
  const keep = delim !== null && splitRow(delim).length === n ? delim : null;
  const out = [fmt(header), keep !== null ? keep : "|" + Array(n).fill("---").join("|") + "|"];
  for (let r of rows) {
    r = [...r].slice(0, n);
    while (r.length < n) r.push("");
    out.push(fmt(r));
  }
  return out;
}

export function replace(body, k, header, rows, expectedHeader = null) {
  const tables = find(body);
  if (!(k >= 0 && k < tables.length)) throw new Error(`there is no table #${k} (found ${tables.length})`);
  const t = tables[k];
  if (expectedHeader !== null && JSON.stringify(expectedHeader.map((c) => c.trim())) !== JSON.stringify(t.header)) {
    throw new Error("that table changed since the page was loaded; reload it");
  }
  if (!header.length || !header.some((h) => h.trim())) throw new Error("a table needs at least one column heading");
  const lines = body.split("\n");
  return [...lines.slice(0, t.start), ...formatTable(header, rows, t.delim), ...lines.slice(t.end)].join("\n");
}

// ---------------------------------------------------------------- money totals (port of tables.py)

const MONEY = /^(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(crore|cr|lakhs|lakh|lac|l|k)?(?![A-Za-z])/i;
const MULT = { crore: 1e7, cr: 1e7, lakhs: 1e5, lakh: 1e5, lac: 1e5, l: 1e5, k: 1e3 };
const MONEY_HEAD = /₹|\b(cost|amount|price|budget|paid|total|fee|fees|advance|spent|spend|rs|inr|balance)\b/i;
const TOTAL_ROW = /^\W*total\b/i;

export function plain(cell) {
  return String(cell ?? "").replaceAll("\\|", "|").replace(/\*\*|__|`|~~/g, "").trim().replace(/^[_*]+|[_*]+$/g, "").trim();
}

export function money(cell) {
  const m = MONEY.exec(plain(cell));
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, "")) * (MULT[(m[2] || "").toLowerCase()] || 1);
}

export function totals(header, rows) {
  const out = {};
  const body = rows.filter((r) => !(r.length && TOTAL_ROW.test(plain(r[0]))));
  header.forEach((h, c) => {
    const cells = body.filter((r) => c < r.length && plain(r[c])).map((r) => plain(r[c]));
    if (!cells.length) return;
    const rupees = cells.filter((x) => x.startsWith("₹")).length;
    if (!(MONEY_HEAD.test(plain(h)) || rupees * 10 >= cells.length * 6)) return;
    const vals = cells.map(money).filter((v) => v !== null);
    if (vals.length && c > 0) out[c] = Math.round(vals.reduce((s, v) => s + v, 0) * 100) / 100;
  });
  return out;
}

export const rupees = (v) => (v < 0 ? "-" : "") + "₹" + Math.abs(Math.round(v)).toLocaleString("en-IN");

// ---------------------------------------------------------------- dates in cells

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})\b/;
const DMON = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?/i;
const MOND = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i;
const DATE_HEAD = /\b(date|day|when)\b/i;

function mk(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

/** "YYYY-MM-DD" or null; today is "YYYY-MM-DD". */
export function cellDate(cell, today) {
  const s = plain(cell);
  let m;
  if ((m = ISO.exec(s))) return mk(+m[1], +m[2], +m[3]);
  if ((m = DMY.exec(s))) return mk(+m[3], +m[2], +m[1]);
  let day, mon, year;
  if ((m = DMON.exec(s))) [day, mon, year] = [m[1], m[2], m[3]];
  else if ((m = MOND.exec(s))) [mon, day, year] = [m[1], m[2], m[3]];
  if (!day || !MONTHS.includes(mon.toLowerCase().slice(0, 3))) return null;
  const mo = MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1;
  if (year) return mk(+year, mo, +day);
  const t0 = Date.parse(`${today}T00:00:00Z`);
  let best = null;
  for (const y of [+today.slice(0, 4) - 1, +today.slice(0, 4), +today.slice(0, 4) + 1]) {
    const c = mk(y, mo, +day);
    if (c && (best === null || Math.abs(Date.parse(`${c}T00:00:00Z`) - t0) < Math.abs(Date.parse(`${best}T00:00:00Z`) - t0))) best = c;
  }
  return best;
}

export function events(header, rows, today) {
  let col = header.findIndex((h) => DATE_HEAD.test(plain(h)));
  if (col < 0) {
    for (let c = 0; c < header.length; c++) {
      const cells = rows.filter((r) => c < r.length && plain(r[c])).map((r) => r[c]);
      if (cells.length && cells.filter((x) => cellDate(x, today)).length * 2 >= cells.length) { col = c; break; }
    }
  }
  if (col < 0) return [];
  const out = [];
  let last = null;
  for (const r of rows) {
    const cell = col < r.length ? r[col] : "";
    const d = plain(cell) ? cellDate(cell, today) : last;
    if (plain(cell)) last = d;
    if (d) out.push({ date: d, text: r.filter((x, c) => c !== col && plain(x)).join(" · ") });
  }
  return out;
}
