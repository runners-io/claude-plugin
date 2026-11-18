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
 */
import type { Snapshot } from "./state.ts";

export type Phase = "running" | "pending" | "finished";

export const PENDING_MS = 60_000;
export const FINISHED_MS = 120_000;
export const FINISHED_MAX_MS = 300_000;
/** A head with no runs is pending this long after it was first seen, then finished (a PR with no CI). */
export const PENDING_WINDOW_MS = 5 * 60_000;
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

/** Below this share of the hourly rate limit left, every interval stretches in proportion. */
export const RATE_SLOW = 0.2;
/** At or below this share, only the reads a running CI needs go on: a finished PR, the base and the search pause. */
export const RATE_PAUSE = 0.1;
const STRETCH_MAX = 8;

/**
 * How hard to back off, from the newest `x-ratelimit-remaining` and `x-ratelimit-limit` (any session's on this
 * machine). Above RATE_SLOW nothing changes; below it every interval is multiplied by RATE_SLOW / share left (a
 * third longer at 15%, twice at 10%, four times at 5%, at most eight); at RATE_PAUSE and below, `pause`. An
 * unknown limit is never guessed.
 */
export function ratePressure(remaining: number | null, limit: number | null): { stretch: number; pause: boolean } {
  if (remaining === null || limit === null || !(limit > 0)) return { stretch: 1, pause: false };
  const share = Math.max(0, remaining) / limit;
  if (share >= RATE_SLOW) return { stretch: 1, pause: false };
  const stretch = Math.min(STRETCH_MAX, RATE_SLOW / Math.max(share, RATE_SLOW / STRETCH_MAX));
  return { stretch: Math.round(stretch * 1e6) / 1e6, pause: share <= RATE_PAUSE };
}
