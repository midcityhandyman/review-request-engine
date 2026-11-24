import { DAY_MS, formatLocal, inQuietHours, nextAllowedTime } from "./time.ts";
import type {
  Ask,
  ClosedJob,
  EngineConfig,
  EngineEvent,
  Sender,
  SendResult,
  SuppressReason,
} from "./types.ts";

/**
 * Decides, for every closed job, whether one review ask goes out and when.
 *
 * Rules are checked twice: once when the job closes (so an ask that can never be
 * sent is never scheduled) and again at send time (so a complaint or another ask
 * that arrived in between still stops it). State lives in memory.
 */
export class ReviewRequestEngine {
  private readonly config: EngineConfig;
  private readonly sender: Sender;
  private readonly askList: Ask[] = [];
  private readonly eventList: EngineEvent[] = [];
  private readonly seenJobIds = new Set<string>();
  /** customerId to the time the complaint was flagged. */
  private readonly complaints = new Map<string, Date>();
  private ticking = false;

  constructor(config: EngineConfig, sender: Sender) {
    this.config = config;
    this.sender = sender;
  }

  /** Handle a job closed event. Always returns the ask record that was created. */
  jobClosed(job: ClosedJob): Ask {
    const now = job.closedAt;
    const ask = this.newAsk(job);

    if (this.seenJobIds.has(job.id)) {
      return this.suppress(ask, now, "duplicate_job_event", `job ${job.id} was already processed`);
    }
    this.seenJobIds.add(job.id);

    if (job.complaintFlag) {
      // Also cancels an ask still pending from an earlier job for this customer.
      this.flagComplaint(job.customerId, now);
    }
    const complaintAt = this.complaints.get(job.customerId);
    if (complaintAt) {
      return this.suppress(ask, now, "complaint_flag", this.complaintDetail(complaintAt));
    }
    if (job.optedOut) {
      // An opt out also stops an ask still waiting from an earlier job.
      for (const waiting of this.pendingFor(job.customerId)) {
        this.suppress(waiting, now, "opted_out", `customer opted out on job ${job.id}`);
      }
      return this.suppress(ask, now, "opted_out", "customer opted out of messages");
    }
    if (!ask.to) {
      return this.suppress(ask, now, "no_contact", "no phone number on the job");
    }
    const pending = this.pendingFor(job.customerId)[0];
    if (pending) {
      return this.suppress(
        ask,
        now,
        "ask_already_pending",
        `${pending.id} for job ${pending.jobId} is already scheduled`,
      );
    }

    const earliest = new Date(now.getTime() + this.config.delayMs);
    const planned = nextAllowedTime(earliest, this.config.quietHours, this.config.timeZone);
    const recent = this.recentSentAsk(job.customerId, planned);
    if (recent) {
      return this.suppress(ask, now, "recent_ask_in_window", this.recentDetail(recent));
    }

    ask.scheduledFor = planned;
    if (planned.getTime() !== earliest.getTime()) ask.quietHourShifts += 1;
    this.askList.push(ask);
    const shifted = ask.quietHourShifts > 0 ? " (moved out of quiet hours)" : "";
    this.log(now, ask, "scheduled", `scheduled for ${this.local(planned)}${shifted}`);
    return ask;
  }

  /**
   * Record a complaint against a customer. Any ask still waiting for that
   * customer is suppressed right away, and no new ask is scheduled until
   * `clearComplaint` is called. Returns the asks that were suppressed.
   */
  flagComplaint(customerId: string, at: Date): Ask[] {
    if (!this.complaints.has(customerId)) this.complaints.set(customerId, at);
    const hit = this.pendingFor(customerId);
    for (const ask of hit) {
      this.suppress(ask, at, "complaint_flag", this.complaintDetail(at));
    }
    return hit;
  }

  clearComplaint(customerId: string): void {
    this.complaints.delete(customerId);
  }

  /**
   * Send every ask that is due at `now`. Call this from a timer or a cron job.
   * Returns the asks whose state changed during this tick. A tick that starts
   * while an earlier one is still sending does nothing, so a slow provider on a
   * short timer cannot send the same ask twice.
   */
  async tick(now: Date): Promise<Ask[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.sendDue(now);
    } finally {
      this.ticking = false;
    }
  }

  private async sendDue(now: Date): Promise<Ask[]> {
    const due = this.askList
      .filter((a) => a.status === "scheduled" && a.scheduledFor !== null)
      .filter((a) => a.scheduledFor!.getTime() <= now.getTime())
      .sort((a, b) => a.scheduledFor!.getTime() - b.scheduledFor!.getTime());

    const touched: Ask[] = [];
    for (const ask of due) {
      // A complaint or opt out can arrive while an earlier send is in flight.
      if (ask.status !== "scheduled") continue;
      touched.push(ask);
      const complaintAt = this.complaints.get(ask.customerId);
      if (complaintAt) {
        this.suppress(ask, now, "complaint_flag", this.complaintDetail(complaintAt));
        continue;
      }
      // A late tick can land inside quiet hours even though the plan did not.
      if (inQuietHours(now, this.config.quietHours, this.config.timeZone)) {
        ask.scheduledFor = nextAllowedTime(now, this.config.quietHours, this.config.timeZone);
        ask.quietHourShifts += 1;
        this.log(now, ask, "deferred", `quiet hours, moved to ${this.local(ask.scheduledFor)}`);
        continue;
      }
      const recent = this.recentSentAsk(ask.customerId, now);
      if (recent) {
        this.suppress(ask, now, "recent_ask_in_window", this.recentDetail(recent));
        continue;
      }
      const to = ask.to!;
      let result: SendResult;
      try {
        result = await this.sender.send({ askId: ask.id, to, body: this.messageFor(ask) }, now);
      } catch (error) {
        // A sender that throws must not block the asks queued behind it.
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) {
        ask.status = "sent";
        ask.sentAt = now;
        ask.providerId = result.providerId;
        this.log(now, ask, "sent", `sent to ${to} (${result.providerId})`);
      } else {
        ask.status = "failed";
        ask.detail = result.error;
        this.log(now, ask, "failed", `send failed: ${result.error}`);
      }
    }
    return touched;
  }

  asks(): readonly Ask[] {
    return this.askList;
  }

  events(): readonly EngineEvent[] {
    return this.eventList;
  }

  messageFor(ask: Ask): string {
    const firstName = ask.customerName.trim().split(/\s+/)[0] || "there";
    return (
      `Hi ${firstName}, thanks for having us out for "${ask.jobTitle}". ` +
      `If you have a minute, a short review helps a lot: ${this.config.reviewLink}`
    );
  }

  private pendingFor(customerId: string): Ask[] {
    return this.askList.filter((a) => a.status === "scheduled" && a.customerId === customerId);
  }

  private newAsk(job: ClosedJob): Ask {
    return {
      id: `ask-${String(this.askList.length + 1).padStart(3, "0")}`,
      jobId: job.id,
      customerId: job.customerId,
      customerName: job.customerName,
      jobTitle: job.title,
      to: job.phone?.trim() || null,
      status: "scheduled",
      createdAt: job.closedAt,
      scheduledFor: null,
      sentAt: null,
      suppressedAt: null,
      reason: null,
      detail: null,
      quietHourShifts: 0,
      providerId: null,
    };
  }

  private suppress(ask: Ask, at: Date, reason: SuppressReason, detail: string): Ask {
    ask.status = "suppressed";
    ask.suppressedAt = at;
    ask.reason = reason;
    ask.detail = detail;
    if (!this.askList.includes(ask)) this.askList.push(ask);
    this.log(at, ask, "suppressed", `suppressed: ${reason} (${detail})`);
    return ask;
  }

  /** The latest ask sent to this customer inside the dedupe window ending at `at`. */
  private recentSentAsk(customerId: string, at: Date): Ask | undefined {
    const windowStart = at.getTime() - this.config.dedupeWindowMs;
    return this.askList
      .filter((a) => a.status === "sent" && a.customerId === customerId && a.sentAt !== null)
      .filter((a) => a.sentAt!.getTime() > windowStart)
      .sort((a, b) => b.sentAt!.getTime() - a.sentAt!.getTime())[0];
  }

  private recentDetail(recent: Ask): string {
    const days = Math.round(this.config.dedupeWindowMs / DAY_MS);
    return `${recent.id} was sent ${this.local(recent.sentAt!)}, inside the ${days} day window`;
  }

  private complaintDetail(at: Date): string {
    return `complaint flagged ${this.local(at)}`;
  }

  private local(at: Date): string {
    return formatLocal(at, this.config.timeZone);
  }

  private log(at: Date, ask: Ask, kind: EngineEvent["kind"], message: string): void {
    this.eventList.push({ at, askId: ask.id, kind, message });
  }
}
