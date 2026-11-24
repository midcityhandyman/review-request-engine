import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLocal, inQuietHours, nextAllowedTime, parseClock } from "../src/time.ts";

const overnight = { startMinute: parseClock("20:00"), endMinute: parseClock("09:00") };
const utc = (iso: string) => new Date(`${iso}:00Z`);

test("parseClock accepts HH:MM and rejects anything else", () => {
  assert.equal(parseClock("09:30"), 570);
  assert.equal(parseClock("0:00"), 0);
  assert.throws(() => parseClock("24:00"));
  assert.throws(() => parseClock("9am"));
});

test("overnight quiet hours: start is inclusive, end is exclusive", () => {
  assert.equal(inQuietHours(utc("2026-11-02T19:59"), overnight, "UTC"), false);
  assert.equal(inQuietHours(utc("2026-11-02T20:00"), overnight, "UTC"), true);
  assert.equal(inQuietHours(utc("2026-11-03T03:00"), overnight, "UTC"), true);
  assert.equal(inQuietHours(utc("2026-11-03T08:59"), overnight, "UTC"), true);
  assert.equal(inQuietHours(utc("2026-11-03T09:00"), overnight, "UTC"), false);
});

test("same day quiet hours and the disabled case", () => {
  const lunch = { startMinute: parseClock("12:00"), endMinute: parseClock("13:00") };
  assert.equal(inQuietHours(utc("2026-11-02T12:30"), lunch, "UTC"), true);
  assert.equal(inQuietHours(utc("2026-11-02T13:00"), lunch, "UTC"), false);
  const off = { startMinute: 0, endMinute: 0 };
  assert.equal(inQuietHours(utc("2026-11-02T02:00"), off, "UTC"), false);
});

test("nextAllowedTime leaves allowed times alone and moves quiet ones to the end", () => {
  const ok = utc("2026-11-02T14:00");
  assert.equal(nextAllowedTime(ok, overnight, "UTC").getTime(), ok.getTime());
  assert.equal(
    nextAllowedTime(utc("2026-11-02T21:15"), overnight, "UTC").toISOString(),
    "2026-11-03T09:00:00.000Z",
  );
  assert.equal(
    nextAllowedTime(new Date("2026-11-03T02:10:45Z"), overnight, "UTC").toISOString(),
    "2026-11-03T09:00:00.000Z",
  );
});

test("quiet hours follow the configured time zone, not UTC", () => {
  // 01:30 UTC is 19:30 the previous evening in Chicago (UTC-6 in November).
  const at = utc("2026-11-03T01:30");
  assert.equal(inQuietHours(at, overnight, "UTC"), true);
  assert.equal(inQuietHours(at, overnight, "America/Chicago"), false);
  assert.equal(formatLocal(at, "America/Chicago"), "Mon 2026-11-02 19:30");
});

test("nextAllowedTime lands on the local end time across a daylight saving change", () => {
  // Clocks in Chicago go back one hour at 02:00 on 2026-11-01.
  const before = new Date("2026-10-31T22:00:00-05:00");
  const next = nextAllowedTime(before, overnight, "America/Chicago");
  assert.equal(formatLocal(next, "America/Chicago"), "Sun 2026-11-01 09:00");
  assert.equal(inQuietHours(next, overnight, "America/Chicago"), false);
});
