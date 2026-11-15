// IST clock. IST has no DST, so a fixed +05:30 offset is exact, whatever
// zone the phone is set to.

const OFFSET = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const p2 = (n) => String(n).padStart(2, "0");

/** The IST wall-clock fields for a moment (default now), seconds truncated. */
export function ist(when) {
  const d = new Date((when ? new Date(when).getTime() : Date.now()) + OFFSET);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(),
    mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() };
}

/** Log-entry stamp: `01-10-2026 15:40 IST`. */
export function stamp(when) {
  const t = ist(when);
  return `${p2(t.d)}-${p2(t.mo)}-${t.y} ${p2(t.h)}:${p2(t.mi)} IST`;
}

/** Python's `datetime.now(IST).replace(microsecond=0).isoformat()`. */
export function iso(when) {
  const t = ist(when);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}T${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}+05:30`;
}

export function hhmm(when) {
  const t = ist(when);
  return `${p2(t.h)}:${p2(t.mi)}`;
}

export function todayDate(when) {
  const t = ist(when);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}`;
}

export function monthTitle(when) {
  const t = ist(when);
  return `${MONTHS[t.mo - 1]} ${t.y}`;
}

export function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${suffix}`;
}

/** `8th October 2026`, the journal's day heading. */
export function dayHeading(when) {
  const t = ist(when);
  return `${ordinal(t.d)} ${MONTHS[t.mo - 1]} ${t.y}`;
}

export function weekday(when) {
  return DAYS[ist(when).wd];
}

/** Whole days from today (IST) to a YYYY-MM-DD date. */
export function daysUntil(dateText, when) {
  const [y, m, d] = String(dateText).split("-").map(Number);
  if (!y || !m || !d) return null;
  const t = ist(when);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.y, t.mo - 1, t.d)) / 86400000);
}
