import type { OutboundMessage, Sender, SendResult } from "./types.ts";

export interface MockDelivery extends OutboundMessage {
  at: Date;
  providerId: string;
}

/**
 * Offline stand in for a messaging provider. It keeps every accepted message in
 * `outbox` and can be told to reject specific recipients to exercise failures.
 */
export class MockSender implements Sender {
  readonly outbox: MockDelivery[] = [];
  private readonly failing: Set<string>;
  private counter = 0;

  constructor(options: { failFor?: string[] } = {}) {
    this.failing = new Set(options.failFor ?? []);
  }

  async send(message: OutboundMessage, at: Date): Promise<SendResult> {
    if (this.failing.has(message.to)) {
      return { ok: false, error: "mock provider rejected the recipient" };
    }
    this.counter += 1;
    const providerId = `mock-${String(this.counter).padStart(4, "0")}`;
    this.outbox.push({ ...message, at, providerId });
    return { ok: true, providerId };
  }
}
