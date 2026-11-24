import { DAY_MS, HOUR_MS, parseClock } from "./time.ts";
import type { EngineConfig } from "./types.ts";

type Env = Record<string, string | undefined>;

function nonNegativeNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a number that is zero or greater, got "${raw}"`);
  }
  return value;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`TIMEZONE "${timeZone}" is not a known IANA time zone`);
  }
}

/** Build engine config from environment style input. Every key is optional. */
export function loadConfig(env: Env = process.env): EngineConfig {
  const sender = env.SENDER?.trim() || "mock";
  if (sender !== "mock") {
    throw new Error(`SENDER "${sender}" is not supported, only "mock" ships in this repo`);
  }
  const timeZone = env.TIMEZONE?.trim() || "UTC";
  assertTimeZone(timeZone);
  return {
    delayMs: nonNegativeNumber(env, "REVIEW_DELAY_HOURS", 2) * HOUR_MS,
    quietHours: {
      startMinute: parseClock(env.QUIET_HOURS_START?.trim() || "20:00"),
      endMinute: parseClock(env.QUIET_HOURS_END?.trim() || "09:00"),
    },
    timeZone,
    dedupeWindowMs: nonNegativeNumber(env, "DEDUPE_WINDOW_DAYS", 90) * DAY_MS,
    reviewLink: env.REVIEW_LINK?.trim() || "https://example.com/review",
  };
}
