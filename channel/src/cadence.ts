/**
 * How often each watched pull request is looked at.
 *
 * A fixed 20 s for every PR cost a busy PR about 440 GitHub requests an hour (a measured session: 882 an hour for
 * two). Most of an hour, a PR has nothing running: its CI finished, or it waits for a review. So:
 *
 * - RUNNING (a run is queued or in progress): every pass, the poll interval (20 s by default);
 * - PENDING (a run held for approval, a head pushed in the last five minutes with no runs yet, or a mergeability
 *   GitHub is still computing): every minute;
 * - FINISHED (everything has finished, a PR with no CI, or a closed one): two minutes, half as long again after each
 *   look that finds nothing new, up to five. Anything new puts it back to the start.
 *
 * A finished PR's runs are re-read only when the PR itself changed, or every RUNS_EVERY_MS (for a re-run, which
 * does not change the PR). A user's own longer interval is never shortened.
 *
 * The session's own push (OWN_PUSH_FAST_MS) puts its pull request on every pass at once, for five minutes.
 */
import { FINISHED_MAX_MS } from "./rules.mjs";
import type { Snapshot } from "./state.ts";

export type Phase = "running" | "pending" | "finished";

export const PENDING_MS = 60_000;
export const FINISHED_MS = 120_000;
// The longest a finished PR goes unlooked at (before rate pressure stretches it) lives in rules.mjs, because the
// event-log check (scripts/event-log-summary.mjs) reads it too, on Node 20, which cannot import this file.
export { FINISHED_MAX_MS };
/** A head with no runs is pending this long after it was first seen, then finished (a PR with no CI). */
export const PENDING_WINDOW_MS = 5 * 60_000;
/**
 * After the session's own push (git.ts `pushed` moved), the pull request for that branch is looked at at once and then
 * every pass for this long, whatever its phase. Without it a push to a settled pull request waited up to
 * FINISHED_MAX_MS to be seen, and only then did the fast beat start. Five minutes of looks at the poll interval is
 * 15 conditional requests, most answered 304, once per push.
 */
export const OWN_PUSH_FAST_MS = 5 * 60_000;
/** A finished PR's runs are re-read at least this often, for a re-run. */
export const RUNS_EVERY_MS = 10 * 60_000;

const RUNNING = new Set(["queued", "in_progress"]);

export function phaseOf(s: Snapshot, headSeenAt: number, now: number): Phase {
  if (s.state !== "open") return "finished";
  if (s.runs.some((r) => RUNNING.has(r.status))) return "running";
  if (s.runs.some((r) => r.status !== "completed")) return "pending";
  if (s.mergeableState === "unknown") return "pending";
  if (s.runs.length === 0 && now - headSeenAt < PENDING_WINDOW_MS) return "pending";
  return "finished";
}

/** `quietLooks`: how many looks in a row at a finished PR found nothing new. */
export function lookEveryMs(phase: Phase, pollMs: number, quietLooks: number): number {
  if (phase === "running") return pollMs;
  if (phase === "pending") return Math.max(pollMs, PENDING_MS);
  return Math.max(pollMs, Math.min(FINISHED_MAX_MS, FINISHED_MS * 1.5 ** quietLooks));
}

/**
 * A watched open PR's reviews, threads and merge state are read this often (one GraphQL point each, from its own
 * budget): about 60 points an hour a PR. A review is not urgent to the second; CI failures stay on the REST beat.
 */
export const REVIEW_EVERY_MS = 60_000;

/**
 * With review requests on (requests.ts), this login's review requests are searched this often: one GraphQL point
 * each, about 20 an hour for the whole machine (the answer is shared).
 */
export const REQUESTS_EVERY_MS = 180_000;

/**
 * Below this share of the hourly rate limit left, every interval stretches in proportion. The limit belongs to the
 * GitHub login, which other sessions, gh and scripts share: at 20% several sessions were still polling at full
 * speed while the login ran out, so the channel now gives way from 30%.
 */
export const RATE_SLOW = 0.3;
/** At or below this share, only the reads a running CI needs go on: a finished PR, the base and the search pause. */
export const RATE_PAUSE = 0.15;
const STRETCH_MAX = 8;
/**
 * At or below this many REST requests left, the reads that only add detail stop entirely until GitHub's reset: a
 * running PR's jobs and a failed job's annotations (poller.ts). Paused still reads a PR whose CI runs; this keeps the
 * last requests for that, and for the user's own gh and tools on the same login.
 */
export const JOB_READS_FLOOR = 200;

/**
 * How hard to back off, from the newest `x-ratelimit-remaining` and `x-ratelimit-limit` (any session's on this
 * machine). Above RATE_SLOW nothing changes; below it every interval is multiplied by RATE_SLOW / share left (half
 * as long again at 20%, twice at 15%, three times at 10%, at most eight); at RATE_PAUSE and below, `pause`. An
 * unknown limit is never guessed.
 */
export function ratePressure(remaining: number | null, limit: number | null): { stretch: number; pause: boolean } {
  if (remaining === null || limit === null || !(limit > 0)) return { stretch: 1, pause: false };
  const share = Math.max(0, remaining) / limit;
  if (share >= RATE_SLOW) return { stretch: 1, pause: false };
  const stretch = Math.min(STRETCH_MAX, RATE_SLOW / Math.max(share, RATE_SLOW / STRETCH_MAX));
  return { stretch: Math.round(stretch * 1e6) / 1e6, pause: share <= RATE_PAUSE };
}

/**
 * How long one pass of the poller sleeps. The interval stretches by `factor` (the rate back-off), but never past
 * GitHub's reset plus a second, when the reading is void and the limit refilled, and never below one plain interval.
 * GitHub's own wait (a 403's retry-after or reset) is a floor, never multiplied: a 107.8 s wait for the reset, times
 * the back-off's 8, was once slept as 14.4 minutes.
 */
export function passSleepMs(p: { pollMs: number; factor: number; retryMs: number; msToReset: number | null }): number {
  let stretched = p.pollMs * p.factor;
  if (p.factor > 1 && p.msToReset !== null && p.msToReset >= 0) stretched = Math.min(stretched, Math.max(p.pollMs, p.msToReset + 1000));
  return Math.max(stretched, p.retryMs > 0 ? p.retryMs + 1000 : 0);
}
