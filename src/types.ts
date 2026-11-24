/** A job that has just been closed out in the field service system. */
export interface ClosedJob {
  id: string;
  customerId: string;
  customerName: string;
  /** Where the ask goes. Missing or blank means the customer cannot be asked. */
  phone?: string;
  title: string;
  closedAt: Date;
  /** True when the job itself was closed with a complaint on it. */
  complaintFlag?: boolean;
  /** True when the customer has asked not to receive messages. */
  optedOut?: boolean;
}

export type SuppressReason =
  | "complaint_flag"
  | "opted_out"
  | "no_contact"
  | "duplicate_job_event"
  | "ask_already_pending"
  | "recent_ask_in_window";

export type AskStatus = "scheduled" | "sent" | "suppressed" | "failed";

/** One review ask, in whatever state it ended up. Every closed job gets exactly one. */
export interface Ask {
  id: string;
  jobId: string;
  customerId: string;
  customerName: string;
  jobTitle: string;
  to: string | null;
  status: AskStatus;
  createdAt: Date;
  /** When the ask is planned to go out. Set while scheduled and kept afterwards. */
  scheduledFor: Date | null;
  sentAt: Date | null;
  suppressedAt: Date | null;
  reason: SuppressReason | null;
  /** Human readable explanation of the suppression or failure. */
  detail: string | null;
  /** How many times quiet hours pushed the send time later. */
  quietHourShifts: number;
  providerId: string | null;
}

export interface QuietHours {
  /** Minutes after local midnight, 0 to 1439. */
  startMinute: number;
  endMinute: number;
}

export interface EngineConfig {
  delayMs: number;
  quietHours: QuietHours;
  timeZone: string;
  dedupeWindowMs: number;
  reviewLink: string;
}

export interface OutboundMessage {
  askId: string;
  to: string;
  body: string;
}

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

/** The only thing the engine needs from a messaging provider. */
export interface Sender {
  send(message: OutboundMessage, at: Date): Promise<SendResult>;
}

export interface EngineEvent {
  at: Date;
  askId: string;
  kind: "scheduled" | "deferred" | "sent" | "suppressed" | "failed";
  message: string;
}
