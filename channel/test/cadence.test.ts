// How often each pull request is looked at: often while its CI runs, rarely once it has settled, so a quiet PR costs
// under 30 GitHub requests an hour and a busy one under 150.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FINISHED_MAX_MS, FINISHED_MS, PENDING_MS, PENDING_WINDOW_MS, RUNS_EVERY_MS, lookEveryMs, phaseOf } from "../src/cadence.ts";
import type { RunInfo } from "../src/github.ts";
import type { Snapshot } from "../src/state.ts";

const run = (status: string, conclusion: string | null = null): RunInfo => ({ id: 1, name: "CI", status, conclusion, htmlUrl: "", runAttempt: 1 });
const snap = (runs: RunInfo[], extra: Partial<Snapshot> = {}): Snapshot => ({
  repo: "acme/widgets", pr: 7, state: "open", headSha: "a".repeat(40), headRef: "feat", mergeableState: "clean", prUrl: "", runs, ...extra,
});
const NOW = 1_700_000_000_000;

test("a run that is queued or in progress is RUNNING", () => {
  assert.equal(phaseOf(snap([run("completed", "success"), run("in_progress")]), NOW, NOW), "running");
  assert.equal(phaseOf(snap([run("queued")]), NOW, NOW), "running");
});

test("a run held for approval, a head with no runs yet, and a mergeability still being computed are PENDING", () => {
  assert.equal(phaseOf(snap([run("waiting")]), NOW, NOW), "pending");
  assert.equal(phaseOf(snap([run("requested")]), NOW, NOW), "pending");
  assert.equal(phaseOf(snap([]), NOW - 60_000, NOW), "pending", "pushed a minute ago, CI not started yet");
  assert.equal(phaseOf(snap([run("completed", "success")], { mergeableState: "unknown" }), NOW, NOW), "pending");
});

test("all runs done, or no runs long after the push, or a closed PR, is FINISHED", () => {
  assert.equal(phaseOf(snap([run("completed", "failure")]), NOW, NOW), "finished");
  assert.equal(phaseOf(snap([]), NOW - PENDING_WINDOW_MS - 1, NOW), "finished", "a PR with no CI at all");
  assert.equal(phaseOf(snap([run("in_progress")], { state: "merged" }), NOW, NOW), "finished");
});

test("running is every pass, pending a minute, finished two minutes stretching to five", () => {
  assert.equal(lookEveryMs("running", 20_000, 0), 20_000);
  assert.equal(lookEveryMs("pending", 20_000, 0), PENDING_MS);
  assert.equal(lookEveryMs("finished", 20_000, 0), FINISHED_MS);
  assert.equal(lookEveryMs("finished", 20_000, 1), FINISHED_MS * 1.5);
  assert.equal(lookEveryMs("finished", 20_000, 9), FINISHED_MAX_MS);
  assert.equal(lookEveryMs("running", 200_000, 0), 200_000, "a user's longer interval is never shortened");
  assert.equal(lookEveryMs("finished", 400_000, 0), 400_000);
  assert.equal(FINISHED_MS, 120_000);
  assert.equal(FINISHED_MAX_MS, 300_000);
  assert.equal(PENDING_MS, 60_000);
  assert.equal(RUNS_EVERY_MS, 600_000);
});
