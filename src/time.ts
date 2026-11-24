import type { QuietHours } from "./types.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Parse "HH:MM" on a 24 hour clock into minutes after midnight. */
export function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid clock time "${value}", expected HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid clock time "${value}", expected HH:MM`);
  }
  return hours * 60 + minutes;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

function parts(at: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** Minutes after local midnight for an instant in a given IANA time zone. */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const p = parts(at, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** "Mon 2026-11-02 09:00" in the given time zone. Used by the report and the demo. */
export function formatLocal(at: Date, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * True when the instant falls inside quiet hours. The start is inclusive and the
 * end is exclusive, so with 20:00 to 09:00 a send at exactly 09:00 is allowed.
 */
export function inQuietHours(at: Date, quiet: QuietHours, timeZone: string): boolean {
  const { startMinute, endMinute } = quiet;
  if (startMinute === endMinute) return false;
  const minute = localMinuteOfDay(at, timeZone);
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/**
 * The earliest instant at or after `at` that is outside quiet hours.
 * Returns `at` unchanged when it is already allowed.
 */
export function nextAllowedTime(at: Date, quiet: QuietHours, timeZone: string): Date {
  let candidate = at;
  // One pass is enough on a normal day. The extra passes cover a daylight saving
  // change between the candidate and the end of quiet hours.
  for (let pass = 0; pass < 4 && inQuietHours(candidate, quiet, timeZone); pass++) {
    const minute = localMinuteOfDay(candidate, timeZone);
    const minutesUntilEnd = (quiet.endMinute - minute + 1440) % 1440;
    const startOfMinute = Math.floor(candidate.getTime() / MINUTE_MS) * MINUTE_MS;
    candidate = new Date(startOfMinute + minutesUntilEnd * MINUTE_MS);
  }
  return candidate;
}
