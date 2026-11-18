/**
 * An optional, durable record of what the channel saw and sent: one JSON line per
 * record, one file per UTC day, in RUNNERS_IO_EVENT_LOG_DIR. It is off unless that
 * variable names an absolute directory, so a user who never asks for it gets no
 * file on their disk.
 *
 * It exists to prove the channel over days rather than minutes: every event it
 * pushed or held back, how long after GitHub's own time it arrived, the API calls
 * it made, and every error. `scripts/event-log-summary.mjs` reads it, and with
 * --github compares it against GitHub to find an event that never arrived.
 *
 * - Nothing secret is written: every line goes through log.ts's redaction, and
 *   the records carry no token, no header and no response body.
 * - The directory is 0700 and each file 0600.
 * - Files older than `keepDays` (default 14) are deleted when the log opens.
 * - Writing never throws: a full or unwritable disk costs the record, never the channel.
 */
import { appendFileSync, chmodSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { log, redact } from "./log.ts";

export interface EventLog {
  write(type: string, fields?: Record<string, unknown>): void;
}

export const NO_EVENT_LOG: EventLog = { write() {} };

export interface EventLogOptions {
  /** This channel process, so several sessions' records can be told apart. */
  readonly session: string;
  /** The session's project folder. */
  readonly project: string;
  readonly keepDays?: number;
  /** Test seam. */
  readonly now?: () => Date;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export function openEventLog(dir: string, options: EventLogOptions): EventLog {
  const now = options.now ?? (() => new Date());
  const keepDays = options.keepDays ?? 14;
  let ready = false;
  let failed = false;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const oldest = Date.parse(now().toISOString().slice(0, 10)) - (keepDays - 1) * DAY_MS;
    for (const name of readdirSync(dir)) {
      const m = DAY_FILE.exec(name);
      if (m && Date.parse(m[1]) < oldest) unlinkSync(join(dir, name));
    }
    ready = true;
  } catch (error) {
    log(`the event log in ${dir} cannot be opened: ${(error as Error).message}`);
  }

  return {
    write(type, fields = {}) {
      if (!ready) return;
      const at = now();
      const line = redact(JSON.stringify({ t: at.toISOString(), session: options.session, project: options.project, type, ...fields }));
      try {
        appendFileSync(join(dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 });
        failed = false;
      } catch (error) {
        if (!failed) log(`the event log cannot be written: ${(error as Error).message}`);
        failed = true;
      }
    },
  };
}
