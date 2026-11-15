// A port of the parts of PyYAML's emitter that Periodicity's headers use, so a
// header written on the phone is byte-for-byte what `pt` would write:
// block mapping at the top, one-line flow style for list values
// (`labels: [a, b]`, `links: [{type: relates, to: P-0001}]`), allow_unicode,
// width 10000 (no folding). Scalar style follows PyYAML's analyze_scalar and
// choose_scalar_style; a string that would read back as another type is quoted.

const WS = "\0 \t\r\n\x85  ";
const BREAKS = "\n\x85  ";

// PyYAML's implicit resolvers (resolver.py), for deciding when a plain string
// would read back as something other than a string.
const IMPLICIT = [
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/,
  /^(?:<<)$/,
  /^(?:~|null|Null|NULL|)$/,
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  /^(?:=)$/,
];

function resolvesToString(s) {
  return !IMPLICIT.some((re) => re.test(s));
}

function analyze(scalar) {
  const chars = Array.from(scalar);                 // code points, as Python iterates
  if (!chars.length) {
    return { empty: true, multiline: false, flowPlain: false, blockPlain: true, single: true };
  }
  let blockInd = false, flowInd = false, lineBreaks = false, special = false;
  let leadSpace = false, leadBreak = false, trailSpace = false, trailBreak = false;
  let breakSpace = false, spaceBreak = false;
  if (scalar.startsWith("---") || scalar.startsWith("...")) blockInd = flowInd = true;
  let precededWs = true;
  let followedWs = chars.length === 1 || WS.includes(chars[1]);
  let prevSpace = false, prevBreak = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (i === 0) {
      if ("#,[]{}&*!|>'\"%@`".includes(ch)) { flowInd = true; blockInd = true; }
      if ("?:".includes(ch)) { flowInd = true; if (followedWs) blockInd = true; }
      if (ch === "-" && followedWs) { flowInd = true; blockInd = true; }
    } else {
      if (",?[]{}".includes(ch)) flowInd = true;
      if (ch === ":") { flowInd = true; if (followedWs) blockInd = true; }
      if (ch === "#" && precededWs) { flowInd = true; blockInd = true; }
    }
    if (BREAKS.includes(ch)) lineBreaks = true;
    const cp = ch.codePointAt(0);
    if (!(ch === "\n" || (cp >= 0x20 && cp <= 0x7e))) {
      const printable = (cp === 0x85 || (cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)
        || (cp >= 0x10000 && cp < 0x10ffff)) && cp !== 0xfeff;
      if (!printable) special = true;                // allow_unicode=True: printable unicode is fine
    }
    if (ch === " ") {
      if (i === 0) leadSpace = true;
      if (i === chars.length - 1) trailSpace = true;
      if (prevBreak) breakSpace = true;
      prevSpace = true; prevBreak = false;
    } else if (BREAKS.includes(ch)) {
      if (i === 0) leadBreak = true;
      if (i === chars.length - 1) trailBreak = true;
      if (prevSpace) spaceBreak = true;
      prevSpace = false; prevBreak = true;
    } else {
      prevSpace = false; prevBreak = false;
    }
    precededWs = WS.includes(ch);
    followedWs = i + 2 >= chars.length || WS.includes(chars[i + 2]);
  }
  let flowPlain = true, blockPlain = true, single = true;
  if (leadSpace || leadBreak || trailSpace || trailBreak) flowPlain = blockPlain = false;
  if (breakSpace) flowPlain = blockPlain = single = false;
  if (spaceBreak || special) flowPlain = blockPlain = single = false;
  if (lineBreaks) flowPlain = blockPlain = false;
  if (flowInd) flowPlain = false;
  if (blockInd) blockPlain = false;
  return { empty: false, multiline: lineBreaks, flowPlain, blockPlain, single };
}

const ESCAPES = {
  "\0": "0", "\x07": "a", "\b": "b", "\t": "t", "\n": "n", "\x0B": "v", "\f": "f",
  "\r": "r", "\x1B": "e", '"': '"', "\\": "\\", "\x85": "N", "\xA0": "_",
  " ": "L", " ": "P",
};

function doubleQuoted(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch in ESCAPES) out += "\\" + ESCAPES[ch];
    else if ((cp >= 0x20 && cp <= 0x7e) || ((cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)
      || (cp >= 0x10000 && cp < 0x10ffff)) && cp !== 0xfeff) out += ch;
    else if (cp <= 0xff) out += "\\x" + cp.toString(16).toUpperCase().padStart(2, "0");
    else if (cp <= 0xffff) out += "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
    else out += "\\U" + cp.toString(16).toUpperCase().padStart(8, "0");
  }
  return out + '"';
}

export function str(s, flow = false) {
  const a = analyze(s);
  const plainOk = resolvesToString(s) && (flow ? a.flowPlain : a.blockPlain);
  if (plainOk) return s;
  if (a.single) return "'" + s.replace(/'/g, "''") + "'";
  return doubleQuoted(s);
}

function float(n) {
  if (Number.isNaN(n)) return ".nan";
  if (n === Infinity) return ".inf";
  if (n === -Infinity) return "-.inf";
  // Python's repr, then PyYAML's tweak: an exponent with no "." gets ".0"
  let r = String(n).replace(/e([+-])(\d)$/, "e$10$2");
  if (!r.includes(".") && !r.includes("e")) r += ".0";
  if (!r.includes(".") && r.includes("e")) r = r.replace("e", ".0e");
  return r;
}

export function scalar(v, flow = false, { isFloat = false } = {}) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return isFloat || !Number.isInteger(v) ? float(v) : String(v);
  return str(String(v), flow);
}

function flowValue(v) {
  if (Array.isArray(v)) return "[" + v.map(flowValue).join(", ") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => `${str(k, true)}: ${flowValue(x)}`).join(", ") + "}";
  }
  return scalar(v, true);
}

/** One `key: value` header line, as PyYAML's dump with the house Dumper writes it. */
export function line(key, value, opts = {}) {
  if (Array.isArray(value)) return `${str(key)}: ${value.length ? flowValue(value) : "[]"}`;
  if (value && typeof value === "object") {
    // a nested mapping in block style (not used by Periodicity's own fields)
    const inner = Object.entries(value).map(([k, x]) => "  " + line(k, x)).join("\n");
    return inner ? `${str(key)}:\n${inner}` : `${str(key)}: {}`;
  }
  return `${str(key)}: ${scalar(value, false, opts)}`;
}
