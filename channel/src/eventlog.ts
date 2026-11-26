/**
 * An optional, durable record of what the channel saw and sent: one JSON line per
 * record, one file per UTC day, in the `runners-io-events` subfolder of
 * RUNNERS_IO_EVENT_LOG_DIR. It is off unless that variable names an absolute
 * directory, so a user who never asks for it gets no file on their disk.
 *
 * It exists to prove the channel over days rather than minutes: every event it
 * pushed or held back, how long after GitHub's own time it arrived, the API calls
 * it made, and every error. `scripts/event-log-summary.mjs` reads it, and with
 * --github compares it against GitHub to find an event that never arrived.
 *
 * - Nothing secret is written: every line goes through log.ts's redaction, and
 *   the records carry no token, no header and no response body.
 * - The directory, and the subfolder, must each be a real folder (not a symlink)
 *   owned by this user, as the shared cache's are (shared.ts); otherwise the log
 *   is off, said once on stderr.
 * - The directory is the user's and may hold anything, so the log creates, chmods
 *   and prunes only its own subfolder: 0700, each file 0600, opened with
 *   O_NOFOLLOW where the platform has it, so a day file that is a symlink is never
 *   written through.
 * - Files older than `keepDays` (default 14) are deleted when the log opens.
 * - Writing never throws: a full or unwritable disk costs the record, never the channel.
 */
import { machineError } from "./errors.ts";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
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
  /** The user the folders must belong to: this process's, unless a test says otherwise. */
  readonly uid?: number;
}

/** The subfolder of the user's directory that holds the log: the only folder the log creates, chmods or prunes. */
export const EVENT_LOG_SUBDIR = "runners-io-events";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
/** Append, create 0600, and never through a symlink where the platform can refuse one (not on Windows). */
const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);

/** Throws unless `dir` is a real folder (not a symlink) owned by `uid`. */
function mustBeMine(dir: string, uid: number | undefined): void {
  const s = lstatSync(dir);
  if (s.isSymbolicLink() || !s.isDirectory()) throw machineError(`${dir} is not a plain folder`);
  if (uid !== undefined && s.uid !== uid) throw machineError(`${dir} belongs to another user`);
}

export function openEventLog(dir: string, options: EventLogOptions): EventLog {
  const now = options.now ?? (() => new Date());
  const keepDays = options.keepDays ?? 14;
  const uid = options.uid ?? process.getuid?.();
  const own = join(dir, EVENT_LOG_SUBDIR);
  let ready = false;
  let failed = false;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mustBeMine(dir, uid); // before anything is created inside it
    try {
      mkdirSync(own, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    mustBeMine(own, uid);
    chmodSync(own, 0o700);
    const oldest = Date.parse(now().toISOString().slice(0, 10)) - (keepDays - 1) * DAY_MS;
    for (const name of readdirSync(own)) {
      const m = DAY_FILE.exec(name);
      if (m && Date.parse(m[1]) < oldest) unlinkSync(join(own, name));
    }
    ready = true;
  } catch (error) {
    log(`the event log in ${dir} cannot be used, so none is written: ${(error as Error).message}`);
  }

  return {
    write(type, fields = {}) {
      if (!ready) return;
      const at = now();
      const line = redact(JSON.stringify({ t: at.toISOString(), session: options.session, project: options.project, type, ...fields }));
      let fd: number | null = null;
      try {
        fd = openSync(join(own, `${at.toISOString().slice(0, 10)}.jsonl`), APPEND, 0o600);
        writeSync(fd, `${line}\n`);
        failed = false;
      } catch (error) {
        if (!failed) log(`the event log cannot be written: ${(error as Error).message}`);
        failed = true;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
  };
}
