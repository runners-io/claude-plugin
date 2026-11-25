// Rules shared by the channel (bundled) and the event-log summary script, which re-applies them to what GitHub
// says happened, to find an event the channel should have sent and did not.
// Plain JavaScript, so a script can run it on Node 20 without a build; types are in rules.d.mts.

// ---- How long a finished pull request can go between two looks (cadence.ts lookEveryMs), before rate pressure
// stretches it. The summary script uses it to tell a change no look could have seen.
export const FINISHED_MAX_MS = 300_000;

// ---- How often a watched base branch is read (poller.ts checkBases): every BASE_EVERY_MS while one of its PRs is busy,
// every BASE_IDLE_MS once all have settled. The summary script uses them to tell a base flip no read could have seen.
export const BASE_EVERY_MS = 60_000;
export const BASE_IDLE_MS = 600_000;

// ---- The base branch: red when the latest completed run of any workflow on it failed.

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const COUNTED = new Set(["success", "neutral", "failure", "timed_out", "startup_failure"]);

/**
 * runs: GitHub's workflow runs on the base branch (push events), any order.
 * Answers which workflows are red now, and the GitHub time of the newest result that decided it.
 */
/**
 * Each workflow's newest completed, counted run. The poller keeps this between reads of a base and merges
 * it into the next read, because the read is a window of the newest runs: on a busy main a slow workflow's failed run
 * scrolls out of it, and a workflow missing from the window must keep its last verdict, not vanish from it.
 */
export function latestPerWorkflow(runs) {
  const latest = new Map();
  const sorted = [...(runs ?? [])]
    .filter((r) => r && r.status === "completed" && COUNTED.has(r.conclusion))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const r of sorted) if (!latest.has(r.name)) latest.set(r.name, r);
  return [...latest.values()];
}

export function baseVerdict(runs) {
  const latest = new Map(latestPerWorkflow(runs).map((r) => [r.name, r]));
  const failing = [...latest.values()].filter((r) => FAILED.has(r.conclusion)).map((r) => String(r.name)).sort();
  const times = [...latest.values()].map((r) => String(r.updated_at ?? r.created_at ?? "")).filter(Boolean).sort();
  return { red: failing.length > 0, failing, at: times.at(-1) ?? null };
}
