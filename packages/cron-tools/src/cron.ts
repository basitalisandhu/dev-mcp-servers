/**
 * Five-field cron (minute hour day-of-month month day-of-week) in the Vixie cron dialect:
 * lists, ranges, steps, names for months and weekdays, 0 or 7 for Sunday, and the @ macros.
 * When both day fields are restricted, a day matches if either field matches (as in Vixie cron).
 */

export const FIELD_NAMES = ["minute", "hour", "day_of_month", "month", "day_of_week"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

const RANGES: Record<FieldName, [number, number]> = { minute: [0, 59], hour: [0, 23], day_of_month: [1, 31], month: [1, 12], day_of_week: [0, 6] };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MACROS: Record<string, string> = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };

export interface ParsedField {
  raw: string;
  /** Every value the field accepts, ascending. */
  values: number[];
  /** True when the field is "*" (or "?"), which also changes day matching semantics. */
  wildcard: boolean;
  /** A description of the field used by the explainer. */
  shape: { kind: "all" } | { kind: "step"; from: number; to: number; step: number } | { kind: "single"; value: number } | { kind: "range"; from: number; to: number } | { kind: "list"; values: number[] };
}

export interface ParsedCron {
  expression: string;
  normalised: string;
  fields: Record<FieldName, ParsedField>;
  macro?: string;
}

export class CronSyntaxError extends Error {}

function parseValue(token: string, field: FieldName): number {
  const t = token.toLowerCase();
  if (field === "month") {
    const idx = MONTHS.indexOf(t);
    if (idx >= 0) return idx + 1;
  }
  if (field === "day_of_week") {
    const idx = DAYS.indexOf(t);
    if (idx >= 0) return idx;
  }
  if (!/^\d+$/.test(t)) throw new CronSyntaxError(`${field}: ${JSON.stringify(token)} is not a number${field === "month" ? " or month name" : field === "day_of_week" ? " or weekday name" : ""}`);
  let n = Number(t);
  if (field === "day_of_week" && n === 7) n = 0;
  const [lo, hi] = RANGES[field];
  if (n < lo || n > hi) throw new CronSyntaxError(`${field}: ${n} is outside ${lo}-${hi}`);
  return n;
}

export function parseField(raw: string, field: FieldName): ParsedField {
  const [lo, hi] = RANGES[field];
  if (raw === "*" || (raw === "?" && (field === "day_of_month" || field === "day_of_week"))) {
    const values = [];
    for (let v = lo; v <= hi; v++) values.push(v);
    return { raw, values, wildcard: true, shape: { kind: "all" } };
  }
  if (raw.includes("#") || raw.split(/[,\-/]/).some((tok) => /^(\d*[LW]|LW)$/i.test(tok))) throw new CronSyntaxError(`${field}: L, W and # are Quartz extensions and are not part of 5-field cron`);
  const items = raw.split(",");
  const set = new Set<number>();
  let shape: ParsedField["shape"] | undefined;
  for (const item of items) {
    if (item === "") throw new CronSyntaxError(`${field}: empty list item in ${JSON.stringify(raw)}`);
    const [base, stepText, extra] = item.split("/");
    if (extra !== undefined) throw new CronSyntaxError(`${field}: more than one / in ${JSON.stringify(item)}`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new CronSyntaxError(`${field}: step must be a positive number in ${JSON.stringify(item)}`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (base === "*") {
      from = lo;
      to = hi;
    } else if (base.includes("-")) {
      const [a, b, more] = base.split("-");
      if (more !== undefined || a === "" || b === "") throw new CronSyntaxError(`${field}: bad range ${JSON.stringify(base)}`);
      from = parseValue(a, field);
      to = parseValue(b, field);
      if (field === "day_of_week" && b === "7") to = 7;
      if (to < from) throw new CronSyntaxError(`${field}: range ${base} runs backwards`);
    } else {
      from = parseValue(base, field);
      to = stepText !== undefined ? hi : from;
    }
    if (step > hi - lo + 1) throw new CronSyntaxError(`${field}: step ${step} is larger than the field range`);
    const itemValues: number[] = [];
    for (let v = from; v <= to; v += step) itemValues.push(field === "day_of_week" && v === 7 ? 0 : v);
    itemValues.forEach((v) => set.add(v));
    const itemShape: ParsedField["shape"] =
      stepText !== undefined ? { kind: "step", from, to, step } : from === to ? { kind: "single", value: from } : { kind: "range", from, to };
    shape = shape === undefined ? itemShape : { kind: "list", values: [] };
  }
  const values = [...set].sort((a, b) => a - b);
  if (shape?.kind === "list") shape = { kind: "list", values };
  return { raw, values, wildcard: false, shape: shape ?? { kind: "list", values } };
}

export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  if (trimmed === "") throw new CronSyntaxError("expression is empty");
  let macro: string | undefined;
  let source = trimmed;
  if (trimmed.startsWith("@")) {
    const m = MACROS[trimmed.toLowerCase()];
    if (!m) throw new CronSyntaxError(trimmed.toLowerCase() === "@reboot" ? "@reboot runs at daemon start and has no schedule to compute" : `unknown macro ${trimmed}; known: ${Object.keys(MACROS).join(", ")}`);
    macro = trimmed.toLowerCase();
    source = m;
  }
  const parts = source.split(" ");
  if (parts.length !== 5) throw new CronSyntaxError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}${parts.length === 6 ? "; a leading seconds field is not supported" : ""}`);
  const fields = {} as Record<FieldName, ParsedField>;
  FIELD_NAMES.forEach((name, i) => {
    fields[name] = parseField(parts[i], name);
  });
  return { expression, normalised: parts.join(" "), fields, macro };
}

export interface Validation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  parsed?: ParsedCron;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function validateCron(expression: string): Validation {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(expression);
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)], warnings: [] };
  }
  const warnings: string[] = [];
  const f = parsed.fields;
  if (!f.day_of_month.wildcard && !f.day_of_week.wildcard) warnings.push("Both day-of-month and day-of-week are restricted. In Vixie cron (Linux crontab) the job runs when EITHER matches, not both. Some schedulers (for example Quartz) require ? in one of the two fields.");
  if (!f.day_of_month.wildcard) {
    const reachable = f.day_of_month.values.some((d) => f.month.values.some((m) => d <= DAYS_IN_MONTH[m - 1]));
    if (!reachable) warnings.push(`Day-of-month ${f.day_of_month.raw} never occurs in month ${f.month.raw}; the job never runs.`);
    else if (f.day_of_month.values.some((d) => d > 28) && f.day_of_week.wildcard) warnings.push(`Day-of-month ${f.day_of_month.raw} does not exist in every month; the job is skipped in shorter months.`);
  }
  if (f.day_of_week.raw.split(",").some((p) => /(^|-)7(\/|$)/.test(p))) warnings.push("7 was used for Sunday; it is accepted and treated as 0, but 0 is more portable.");
  if (/\?/.test(parsed.normalised)) warnings.push("? is a Quartz spelling of *; Vixie cron rejects it.");
  if (parsed.macro) warnings.push(`${parsed.macro} expands to ${parsed.normalised}.`);
  return { valid: true, errors: [], warnings, parsed };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function nameOf(field: FieldName, v: number): string {
  if (field === "month") return MONTH_NAMES[v - 1];
  if (field === "day_of_week") return DAY_NAMES[v];
  return String(v);
}

function describeField(pf: ParsedField, field: FieldName, unit: string): string {
  const s = pf.shape;
  switch (s.kind) {
    case "all":
      return `every ${unit}`;
    case "single":
      return field === "month" || field === "day_of_week" ? nameOf(field, s.value) : `${unit} ${s.value}`;
    case "range":
      return field === "month" || field === "day_of_week" ? `${nameOf(field, s.from)} through ${nameOf(field, s.to)}` : `every ${unit} from ${s.from} through ${s.to}`;
    case "step": {
      const [lo, hi] = RANGES[field];
      const span = s.from === lo && s.to === hi ? "" : s.to === hi ? ` from ${nameOf(field, s.from)}` : ` from ${nameOf(field, s.from)} through ${nameOf(field, s.to)}`;
      return `every ${ordinal(s.step)} ${unit}${span}`;
    }
    case "list":
      return field === "month" || field === "day_of_week" ? joinList(s.values.map((v) => nameOf(field, v))) : `${unit}s ${joinList(s.values.map(String))}`;
  }
}

export function explainCron(expression: string): string {
  const p = parseCron(expression);
  const f = p.fields;
  const pad = (n: number) => String(n).padStart(2, "0");
  let time: string;
  const minute = f.minute.shape;
  const hour = f.hour.shape;
  if (minute.kind === "all" && hour.kind === "all") time = "Every minute";
  else if (minute.kind === "step" && minute.from === 0 && minute.to === 59 && hour.kind === "all") time = `Every ${minute.step} minutes`;
  else if (minute.kind === "single" && hour.kind === "single") time = `At ${pad(hour.value)}:${pad(minute.value)}`;
  else if (minute.kind === "single" && hour.kind === "list") time = `At ${joinList(hour.values.map((h) => `${pad(h)}:${pad(minute.value)}`))}`;
  else if (minute.kind === "list" && hour.kind === "single") time = `At ${joinList(minute.values.map((m) => `${pad(hour.value)}:${pad(m)}`))}`;
  else if (minute.kind === "all") time = `Every minute of ${describeField(f.hour, "hour", "hour")}`;
  else time = `At ${describeField(f.minute, "minute", "minute")} past ${describeField(f.hour, "hour", "hour")}`;
  const parts = [time];
  const dom = f.day_of_month.wildcard ? "" : `on ${describeField(f.day_of_month, "day_of_month", "day-of-month")}`;
  const dow = f.day_of_week.wildcard ? "" : `on ${describeField(f.day_of_week, "day_of_week", "day-of-week")}`;
  if (dom && dow) parts.push(`${dom} or ${dow}`);
  else if (dom || dow) parts.push(dom || dow);
  if (!f.month.wildcard) parts.push(`in ${describeField(f.month, "month", "month")}`);
  return `${parts.join(" ")}.`;
}

/* Time zone arithmetic with Intl only. */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)) };
}

function wallMs(p: { year: number; month: number; day: number; hour: number; minute: number }): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** The UTC instant at which the given wall-clock time occurs in tz (approximate inside DST gaps). */
export function wallToUtc(wall: number, tz: string): number {
  const offsetAt = (t: number) => wallMs(localParts(t, tz)) - t;
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}

export function matches(p: LocalParts, c: ParsedCron): boolean {
  const f = c.fields;
  if (!f.minute.values.includes(p.minute) || !f.hour.values.includes(p.hour) || !f.month.values.includes(p.month)) return false;
  return dayMatches(p, c);
}

function dayMatches(p: LocalParts, c: ParsedCron): boolean {
  const f = c.fields;
  const domOk = f.day_of_month.values.includes(p.day);
  const dowOk = f.day_of_week.values.includes(p.weekday);
  if (f.day_of_month.wildcard && f.day_of_week.wildcard) return true;
  if (f.day_of_month.wildcard) return dowOk;
  if (f.day_of_week.wildcard) return domOk;
  return domOk || dowOk;
}

export const MAX_RUNS = 100;
const MAX_ITERATIONS = 200_000;
const HORIZON_MS = 10 * 365.25 * 86400_000;

/** Next `count` run instants strictly after `fromMs`, as UTC milliseconds. */
export function nextRuns(c: ParsedCron, fromMs: number, tz: string, count: number): number[] {
  const out: number[] = [];
  const f = c.fields;
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const horizon = fromMs + HORIZON_MS;
  for (let iter = 0; iter < MAX_ITERATIONS && out.length < count; iter++) {
    if (t > horizon) break;
    const p = localParts(t, tz);
    const advance = (wall: number) => {
      t = Math.max(wallToUtc(wall, tz), t + 60_000);
    };
    if (!f.month.values.includes(p.month)) {
      advance(Date.UTC(p.year, p.month, 1, 0, 0));
      continue;
    }
    if (!dayMatches(p, c)) {
      advance(Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0));
      continue;
    }
    if (!f.hour.values.includes(p.hour)) {
      // Step to the next hour boundary in UTC. Local hours map onto contiguous UTC hours, and unlike a
      // wall-clock jump this visits both occurrences of an hour that repeats when clocks fall back.
      t = t - p.minute * 60_000 + 3_600_000;
      continue;
    }
    if (!f.minute.values.includes(p.minute)) {
      t += 60_000;
      continue;
    }
    out.push(t);
    t += 60_000;
  }
  return out;
}

/** Previous `count` run instants strictly before `fromMs`, newest first. */
export function previousRuns(c: ParsedCron, fromMs: number, tz: string, count: number): number[] {
  const out: number[] = [];
  const f = c.fields;
  let t = Math.ceil(fromMs / 60_000) * 60_000 - 60_000;
  const horizon = fromMs - HORIZON_MS;
  for (let iter = 0; iter < MAX_ITERATIONS && out.length < count; iter++) {
    if (t < horizon) break;
    const p = localParts(t, tz);
    const retreat = (wall: number) => {
      t = Math.min(wallToUtc(wall, tz), t - 60_000);
    };
    if (!f.month.values.includes(p.month)) {
      retreat(Date.UTC(p.year, p.month - 1, 0, 23, 59));
      continue;
    }
    if (!dayMatches(p, c)) {
      retreat(Date.UTC(p.year, p.month - 1, p.day, 0, 0) - 60_000);
      continue;
    }
    if (!f.hour.values.includes(p.hour)) {
      // A non-hour DST transition can start an hour partway through its minute range.
      // Only skip minutes when the candidate boundary is still in this local hour.
      const back = t - (p.minute + 1) * 60_000;
      t = localParts(back + 60_000, tz).hour === p.hour ? back : t - 60_000;
      continue;
    }
    if (!f.minute.values.includes(p.minute)) {
      t -= 60_000;
      continue;
    }
    out.push(t);
    t -= 60_000;
  }
  return out;
}

export function formatLocal(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = Math.round((wallMs(p) - ms) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const DAY_NAMES_EXPORT = DAY_NAMES;
