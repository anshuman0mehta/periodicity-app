// Markdown → HTML, a port of periodicity/web/render.py with markdown-it (the
// JS original of markdown-it-py, same options). Raw HTML is escaped.
// Checkboxes and [[P-…]] links become placeholders before rendering, so the
// n-th checkbox on the page is exactly the n-th checklist line in the body.

import { CHECKBOX } from "./issue.js";

const WIKI = /\[\[([A-Za-z]+(?:-[A-Za-z]+)?-\d+)(?:\|([^\]\n]+))?\]\]/g;
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
const PLACEHOLDER = /⟦(cb|wl)(\d+)⟧/g;

let md = null;
function engine() {
  if (!md) {
    md = globalThis.markdownit("commonmark", { html: false, linkify: false, typographer: false });
    md.enable(["table", "strikethrough"]);
    const link = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
    md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
      const href = tokens[i].attrGet("href") || "";
      if (/^https?:/i.test(href)) { tokens[i].attrSet("target", "_blank"); tokens[i].attrSet("rel", "noopener"); }
      return link(tokens, i, opts, env, self);
    };
  }
  return md;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** titles: Map id → title, for link text and dangling-link detection. */
export function render(body, titles) {
  const boxes = [];
  const links = [];
  const lines = body.split("\n").map((line) => {
    const m = CHECKBOX.exec(line);
    if (!m) return line;
    boxes.push(m[2] !== " ");
    return `${m[1].slice(0, -1)}⟦cb${boxes.length - 1}⟧${m[3].slice(1)}`;
  });
  const wiki = (s) => s.replace(WIKI, (_, id, label) => { links.push([id.toUpperCase(), label || null]); return `⟦wl${links.length - 1}⟧`; });
  // [[P-…]] inside code is an example, not a link
  const joined = lines.join("\n");
  let out = "", last = 0;
  for (const m of joined.matchAll(CODE)) {
    out += wiki(joined.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += wiki(joined.slice(last));
  const html = engine().render(out);
  return html.replace(PLACEHOLDER, (_, kind, n) => {
    n = Number(n);
    if (kind === "cb") return `<input type="checkbox" class="tick" data-n="${n}"${boxes[n] ? " checked" : ""}> `;
    const [pid, label] = links[n];
    const shown = label ? engine().renderInline(label) : esc(titles.get(pid) || pid);
    if (!titles.has(pid)) return `<span class="dangling" title="no such issue">${shown}</span>`;
    return `<a class="wl" href="#${pid}" title="${pid} — ${esc(titles.get(pid))}">${shown}</a>`;
  });
}

export function renderInline(text, titles) {
  let out = render(text, titles).trim();
  if (out.startsWith("<p>") && out.endsWith("</p>")) out = out.slice(3, -4);
  return out;
}
