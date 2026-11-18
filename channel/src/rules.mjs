// Rules shared by the channel (bundled) and the event-log summary script, which re-applies them to what GitHub
// says happened, to find an event the channel should have sent and did not.
// Plain JavaScript, so a script can run it on Node 20 without a build; types are in rules.d.mts.

// ---- The base branch: red when the latest completed run of any workflow on it failed.

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const COUNTED = new Set(["success", "neutral", "failure", "timed_out", "startup_failure"]);

/**
 * runs: GitHub's workflow runs on the base branch (push events), any order.
 * Answers which workflows are red now, and the GitHub time of the newest result that decided it.
 */
export function baseVerdict(runs) {
  const latest = new Map();
  const sorted = [...(runs ?? [])]
    .filter((r) => r && r.status === "completed" && COUNTED.has(r.conclusion))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const r of sorted) if (!latest.has(r.name)) latest.set(r.name, r);
  const failing = [...latest.values()].filter((r) => FAILED.has(r.conclusion)).map((r) => String(r.name)).sort();
  const times = [...latest.values()].map((r) => String(r.updated_at ?? r.created_at ?? "")).filter(Boolean).sort();
  return { red: failing.length > 0, failing, at: times.at(-1) ?? null };
}
