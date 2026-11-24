import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { ReviewRequestEngine } from "../src/engine.ts";
import { buildReport, formatReport } from "../src/report.ts";
import { MockSender } from "../src/sender.ts";
import type { ClosedJob } from "../src/types.ts";

const utc = (iso: string) => new Date(`${iso}:00Z`);

function setup(env: Record<string, string> = {}, failFor: string[] = []) {
  const config = loadConfig({ TIMEZONE: "UTC", ...env });
  const sender = new MockSender({ failFor });
  return { config, sender, engine: new ReviewRequestEngine(config, sender) };
}

let jobSeq = 0;
function job(closedAt: string, extra: Partial<ClosedJob> = {}): ClosedJob {
  jobSeq += 1;
  return {
    id: `J-${jobSeq}`,
    customerId: "c-1",
    customerName: "Alex Sample",
    phone: "+1-555-0101",
    title: "Faucet replacement",
    closedAt: utc(closedAt),
    ...extra,
  };
}

test("a closed job schedules one ask after the delay and tick sends it", async () => {
  const { engine, sender } = setup();
  const ask = engine.jobClosed(job("2026-11-02T10:00"));
  assert.equal(ask.status, "scheduled");
  assert.equal(ask.scheduledFor?.toISOString(), "2026-11-02T12:00:00.000Z");

  await engine.tick(utc("2026-11-02T11:59"));
  assert.equal(sender.outbox.length, 0, "nothing goes out before the delay has passed");

  await engine.tick(utc("2026-11-02T12:00"));
  assert.equal(ask.status, "sent");
  assert.equal(sender.outbox.length, 1);
  assert.equal(sender.outbox[0]?.to, "+1-555-0101");
  assert.match(sender.outbox[0]!.body, /^Hi Alex, .*https:\/\/example\.com\/review$/);

  await engine.tick(utc("2026-11-02T12:15"));
  assert.equal(sender.outbox.length, 1, "a sent ask is never sent again");
});

test("an ask that would land in quiet hours is planned for the end of quiet hours", async () => {
  const { engine, sender } = setup();
  const ask = engine.jobClosed(job("2026-11-02T19:15"));
  assert.equal(ask.scheduledFor?.toISOString(), "2026-11-03T09:00:00.000Z");
  assert.equal(ask.quietHourShifts, 1);
  await engine.tick(utc("2026-11-02T23:00"));
  assert.equal(sender.outbox.length, 0);
  await engine.tick(utc("2026-11-03T09:00"));
  assert.equal(ask.status, "sent");
});

test("a late tick inside quiet hours defers instead of sending", async () => {
  const { engine, sender } = setup();
  const ask = engine.jobClosed(job("2026-11-02T17:30")); // due 19:30
  await engine.tick(utc("2026-11-02T20:05")); // worker was down, now it is quiet hours
  assert.equal(ask.status, "scheduled");
  assert.equal(ask.scheduledFor?.toISOString(), "2026-11-03T09:00:00.000Z");
  assert.equal(sender.outbox.length, 0);
  await engine.tick(utc("2026-11-03T09:10"));
  assert.equal(ask.status, "sent");
});

test("a job closed with a complaint flag never gets an ask", async () => {
  const { engine, sender } = setup();
  const ask = engine.jobClosed(job("2026-11-02T10:00", { complaintFlag: true }));
  assert.equal(ask.status, "suppressed");
  assert.equal(ask.reason, "complaint_flag");
  await engine.tick(utc("2026-11-03T12:00"));
  assert.equal(sender.outbox.length, 0);
});

test("a complaint raised after scheduling cancels the pending ask", async () => {
  const { engine, sender } = setup();
  const ask = engine.jobClosed(job("2026-11-02T10:00"));
  const hit = engine.flagComplaint("c-1", utc("2026-11-02T11:00"));
  assert.deepEqual(hit.map((a) => a.id), [ask.id]);
  assert.equal(ask.status, "suppressed");
  assert.equal(ask.reason, "complaint_flag");
  await engine.tick(utc("2026-11-02T12:00"));
  assert.equal(sender.outbox.length, 0);
});

test("a complaint blocks later jobs for that customer until it is cleared", () => {
  const { engine } = setup();
  engine.flagComplaint("c-1", utc("2026-11-01T10:00"));
  assert.equal(engine.jobClosed(job("2026-11-20T10:00")).reason, "complaint_flag");
  assert.equal(engine.jobClosed(job("2026-11-20T10:00", { customerId: "c-2" })).status, "scheduled");
  engine.clearComplaint("c-1");
  assert.equal(engine.jobClosed(job("2026-11-21T10:00")).status, "scheduled");
});

test("a customer is not asked twice inside the window, and is asked again after it", async () => {
  const { engine, sender } = setup({ DEDUPE_WINDOW_DAYS: "30" });
  engine.jobClosed(job("2026-11-02T10:00"));
  await engine.tick(utc("2026-11-02T12:00"));

  const second = engine.jobClosed(job("2026-11-20T10:00"));
  assert.equal(second.status, "suppressed");
  assert.equal(second.reason, "recent_ask_in_window");

  const third = engine.jobClosed(job("2026-12-02T10:00")); // due 12:00, exactly 30 days on
  assert.equal(third.status, "scheduled");
  await engine.tick(utc("2026-12-02T12:00"));
  assert.equal(sender.outbox.length, 2);
});

test("a second job while an ask is pending does not create a second ask", async () => {
  const { engine, sender } = setup();
  const first = engine.jobClosed(job("2026-11-02T10:00"));
  const second = engine.jobClosed(job("2026-11-02T10:30"));
  assert.equal(second.reason, "ask_already_pending");
  await engine.tick(utc("2026-11-02T13:00"));
  assert.equal(first.status, "sent");
  assert.equal(sender.outbox.length, 1);
});

test("replayed job events, opt outs and missing phones are suppressed with a reason", () => {
  const { engine } = setup();
  const original = job("2026-11-02T10:00");
  engine.jobClosed(original);
  assert.equal(engine.jobClosed({ ...original }).reason, "duplicate_job_event");
  assert.equal(
    engine.jobClosed(job("2026-11-02T10:00", { customerId: "c-2", optedOut: true })).reason,
    "opted_out",
  );
  assert.equal(
    engine.jobClosed(job("2026-11-02T10:00", { customerId: "c-3", phone: "  " })).reason,
    "no_contact",
  );
});

test("a failed send is reported as failed and does not use up the window", async () => {
  const { engine } = setup({}, ["+1-555-0101"]);
  const ask = engine.jobClosed(job("2026-11-02T10:00"));
  await engine.tick(utc("2026-11-02T12:00"));
  assert.equal(ask.status, "failed");
  assert.equal(engine.jobClosed(job("2026-11-03T10:00")).status, "scheduled");
});

test("the report counts every ask once and groups suppressions by reason", async () => {
  const { engine, config } = setup();
  engine.jobClosed(job("2026-11-02T10:00"));
  engine.jobClosed(job("2026-11-02T10:05", { customerId: "c-2", complaintFlag: true }));
  engine.jobClosed(job("2026-11-02T10:10", { customerId: "c-3", complaintFlag: true }));
  engine.jobClosed(job("2026-11-02T10:15", { customerId: "c-4", phone: undefined }));
  engine.jobClosed(job("2026-11-02T18:30", { customerId: "c-5" }));
  await engine.tick(utc("2026-11-02T12:00"));

  const report = buildReport(engine.asks());
  assert.deepEqual(report.totals, {
    jobClosedEvents: 5, sent: 1, suppressed: 3, failed: 0, stillScheduled: 1,
  });
  assert.deepEqual(report.suppressedByReason, { complaint_flag: 2, no_contact: 1 });
  const t = report.totals;
  assert.equal(t.sent + t.suppressed + t.failed + t.stillScheduled, t.jobClosedEvents);

  const text = formatReport(report, config.timeZone);
  assert.match(text, /Asks sent:\s+1/);
  assert.match(text, /complaint_flag\s+2/);
  assert.match(text, /Still scheduled \(1\)/);
});

test("loadConfig applies defaults and rejects bad values", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.delayMs, 2 * 3_600_000);
  assert.equal(cfg.dedupeWindowMs, 90 * 86_400_000);
  assert.deepEqual(cfg.quietHours, { startMinute: 1200, endMinute: 540 });
  assert.throws(() => loadConfig({ REVIEW_DELAY_HOURS: "-1" }), /REVIEW_DELAY_HOURS/);
  assert.throws(() => loadConfig({ TIMEZONE: "Mars/Olympus" }), /TIMEZONE/);
  assert.throws(() => loadConfig({ SENDER: "sms" }), /SENDER/);
  assert.throws(() => loadConfig({ QUIET_HOURS_START: "late" }), /clock time/);
});
