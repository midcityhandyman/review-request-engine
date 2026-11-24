// Offline simulation: one week of closed jobs, a worker that ticks every
// 15 minutes, a mock sender, and the final report. All data is invented.
import {
  buildReport,
  formatLocal,
  formatReport,
  loadConfig,
  MockSender,
  ReviewRequestEngine,
} from "../src/index.ts";
import type { ClosedJob } from "../src/index.ts";

const config = loadConfig({
  REVIEW_DELAY_HOURS: "2",
  QUIET_HOURS_START: "20:00",
  QUIET_HOURS_END: "09:00",
  DEDUPE_WINDOW_DAYS: "90",
  TIMEZONE: "America/Chicago",
});

// November in America/Chicago is UTC-6, so local wall time is written with -06:00.
const at = (day: number, clock: string) => new Date(`2026-11-${String(day).padStart(2, "0")}T${clock}:00-06:00`);

const sender = new MockSender({ failFor: ["+1-555-0107"] });
const engine = new ReviewRequestEngine(config, sender);

type Step =
  | { at: Date; kind: "job"; job: ClosedJob }
  | { at: Date; kind: "complaint"; customerId: string; name: string };

const job = (
  id: string, day: number, clock: string, customerId: string, customerName: string,
  phone: string | undefined, title: string, extra: Partial<ClosedJob> = {},
): Step => ({
  at: at(day, clock),
  kind: "job",
  job: { id, customerId, customerName, phone, title, closedAt: at(day, clock), ...extra },
});

const steps: Step[] = [
  job("J-101", 2, "10:00", "c-1", "Alex Sample", "+1-555-0101", "Faucet replacement"),
  job("J-102", 2, "11:00", "c-4", "Riley Demo", "+1-555-0104", "Drywall patch"),
  { at: at(2, "12:10"), kind: "complaint", customerId: "c-4", name: "Riley Demo" },
  job("J-103", 2, "14:30", "c-3", "Casey Placeholder", "+1-555-0103", "Door rehang", { complaintFlag: true }),
  job("J-104", 2, "19:15", "c-2", "Jordan Example", "+1-555-0102", "Ceiling fan install"),
  job("J-105", 2, "19:40", "c-2", "Jordan Example", "+1-555-0102", "Light switch swap"),
  job("J-106", 3, "09:30", "c-5", "Morgan Test", undefined, "Gutter cleaning"),
  job("J-107", 3, "10:15", "c-6", "Taylor Mock", "+1-555-0106", "Deck repair", { optedOut: true }),
  job("J-108", 3, "13:00", "c-7", "Sam Fixture", "+1-555-0107", "Tile regrout"),
  job("J-101", 4, "08:00", "c-1", "Alex Sample", "+1-555-0101", "Faucet replacement"),
  job("J-109", 5, "15:00", "c-1", "Alex Sample", "+1-555-0101", "Shelf install"),
  job("J-110", 6, "18:30", "c-8", "Drew Dummy", "+1-555-0108", "Fence gate repair"),
];

const TICK_MS = 15 * 60_000;
const end = at(6, "19:00");
let cursor = 0;

console.log("Review request engine demo (offline, mock sender, synthetic data)");
console.log(`Rules: 2h delay, quiet hours 20:00 to 09:00 ${config.timeZone}, one ask per customer per 90 days`);
console.log("");
console.log("TIMELINE");

for (let now = at(2, "09:00"); now <= end; now = new Date(now.getTime() + TICK_MS)) {
  while (cursor < steps.length && steps[cursor]!.at <= now) {
    const step = steps[cursor++]!;
    const stamp = formatLocal(step.at, config.timeZone);
    if (step.kind === "job") {
      console.log(`${stamp}  job closed    ${step.job.id} ${step.job.customerName}: ${step.job.title}`);
      engine.jobClosed(step.job);
    } else {
      console.log(`${stamp}  complaint     flagged for ${step.name}`);
      engine.flagComplaint(step.customerId, step.at);
    }
  }
  await engine.tick(now);
}

console.log("");
console.log("ENGINE LOG");
for (const e of engine.events()) {
  console.log(`${formatLocal(e.at, config.timeZone)}  ${e.askId}  ${e.message}`);
}

console.log("");
console.log("MOCK OUTBOX");
for (const m of sender.outbox) {
  console.log(`${formatLocal(m.at, config.timeZone)}  ${m.providerId} -> ${m.to}`);
  console.log(`  ${m.body}`);
}

console.log("");
console.log(formatReport(buildReport(engine.asks()), config.timeZone));
