import { formatLocal } from "./time.ts";
import type { Ask, SuppressReason } from "./types.ts";

export interface ReportRow {
  askId: string;
  jobId: string;
  customer: string;
  status: Ask["status"];
  when: Date | null;
  reason: SuppressReason | null;
  detail: string | null;
}

export interface Report {
  totals: {
    jobClosedEvents: number;
    sent: number;
    suppressed: number;
    failed: number;
    stillScheduled: number;
  };
  suppressedByReason: Partial<Record<SuppressReason, number>>;
  sent: ReportRow[];
  suppressed: ReportRow[];
  failed: ReportRow[];
  stillScheduled: ReportRow[];
}

function row(ask: Ask): ReportRow {
  const when =
    ask.status === "sent" ? ask.sentAt
    : ask.status === "suppressed" ? ask.suppressedAt
    : ask.scheduledFor;
  return {
    askId: ask.id,
    jobId: ask.jobId,
    customer: ask.customerName,
    status: ask.status,
    when,
    reason: ask.reason,
    detail: ask.detail,
  };
}

/** Summarise every ask the engine has seen. One ask per job closed event. */
export function buildReport(asks: readonly Ask[]): Report {
  const pick = (status: Ask["status"]) => asks.filter((a) => a.status === status).map(row);
  const suppressed = pick("suppressed");
  const suppressedByReason: Partial<Record<SuppressReason, number>> = {};
  for (const r of suppressed) {
    if (r.reason) suppressedByReason[r.reason] = (suppressedByReason[r.reason] ?? 0) + 1;
  }
  const sent = pick("sent");
  const failed = pick("failed");
  const stillScheduled = pick("scheduled");
  return {
    totals: {
      jobClosedEvents: asks.length,
      sent: sent.length,
      suppressed: suppressed.length,
      failed: failed.length,
      stillScheduled: stillScheduled.length,
    },
    suppressedByReason,
    sent,
    suppressed,
    failed,
    stillScheduled,
  };
}

function section(title: string, rows: ReportRow[], timeZone: string, verb: string): string[] {
  const lines = [`${title} (${rows.length})`];
  if (rows.length === 0) lines.push("  none");
  for (const r of rows) {
    const when = r.when ? formatLocal(r.when, timeZone) : "n/a";
    const why = r.reason ? `  ${r.reason}: ${r.detail}` : r.detail ? `  ${r.detail}` : "";
    lines.push(`  ${r.askId}  ${r.jobId.padEnd(6)} ${r.customer.padEnd(18)} ${verb} ${when}${why}`);
  }
  return lines;
}

/** Plain text version of the report, with times shown in the given time zone. */
export function formatReport(report: Report, timeZone: string): string {
  const t = report.totals;
  const lines = [
    "REVIEW ASK REPORT",
    `Times shown in ${timeZone}`,
    "",
    `Job closed events: ${t.jobClosedEvents}`,
    `Asks sent:         ${t.sent}`,
    `Asks suppressed:   ${t.suppressed}`,
    `Sends failed:      ${t.failed}`,
    `Still scheduled:   ${t.stillScheduled}`,
    "",
    "Suppressed by reason",
  ];
  const reasons = Object.entries(report.suppressedByReason).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (reasons.length === 0) lines.push("  none");
  for (const [reason, count] of reasons) lines.push(`  ${reason.padEnd(22)} ${count}`);
  lines.push("");
  lines.push(...section("Sent", report.sent, timeZone, "sent"));
  lines.push("");
  lines.push(...section("Suppressed", report.suppressed, timeZone, "at"));
  lines.push("");
  lines.push(...section("Failed", report.failed, timeZone, "due"));
  lines.push("");
  lines.push(...section("Still scheduled", report.stillScheduled, timeZone, "due"));
  return lines.join("\n");
}
