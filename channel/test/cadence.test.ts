// How often each pull request is looked at: often while its CI runs, rarely once it has settled, so a quiet PR costs
// under 30 GitHub requests an hour and a busy one under 150.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FINISHED_MAX_MS, FINISHED_MS, PENDING_MS, PENDING_WINDOW_MS, RUNS_EVERY_MS, lookEveryMs, passSleepMs, phaseOf, ratePressure } from "../src/cadence.ts";
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

// The limit is the GitHub login's, shared with everything else it drives: other sessions, gh, scripts. Eleven
// sessions once made about 2,000 counted requests an hour, and their heartbeats read 1,001 left while every
// channel still polled at full speed, because the back-off began only at 20%. It now begins at 30%.
test("the rate limit: nothing changes above 30% left; below it every interval stretches in proportion; at 15% the non-essential reads pause", () => {
  assert.deepEqual(ratePressure(null, null), { stretch: 1, pause: false }, "not known yet");
  assert.deepEqual(ratePressure(4000, null), { stretch: 1, pause: false }, "no limit header: not guessed");
  assert.deepEqual(ratePressure(2500, 5000), { stretch: 1, pause: false });
  assert.deepEqual(ratePressure(1500, 5000), { stretch: 1, pause: false }, "exactly 30%");
  const seen = ratePressure(1001, 5000);
  assert.equal(seen.pause, false);
  assert.ok(seen.stretch > 1.49 && seen.stretch < 1.5, `1,001 left (the reading seen live) slows every read: ${seen.stretch}`);
  assert.deepEqual(ratePressure(1000, 5000), { stretch: 1.5, pause: false }, "20% left: half as slow again");
  assert.deepEqual(ratePressure(750, 5000), { stretch: 2, pause: true }, "15% left: twice as slow, and paused");
  assert.deepEqual(ratePressure(500, 5000), { stretch: 3, pause: true });
  assert.deepEqual(ratePressure(250, 5000), { stretch: 6, pause: true });
  assert.deepEqual(ratePressure(0, 5000), { stretch: 8, pause: true }, "capped");
  assert.deepEqual(ratePressure(60, 60), { stretch: 1, pause: false }, "an unauthenticated limit of 60 works the same");
  assert.deepEqual(ratePressure(5, 60), { stretch: 3.6, pause: true });
});

test("a pass never sleeps past GitHub's reset for a back-off, and never multiplies GitHub's own wait", () => {
  // As an event log once had it: a 20 s interval, the back-off at its most (x8), GitHub saying to wait 107.8 s for the
  // reset. The old rule slept (107.8 s x 8) = 862 s, a 14.4-minute gap with nothing written.
  assert.equal(passSleepMs({ pollMs: 20_000, factor: 8, retryMs: 107_756, msToReset: 107_756 }), 108_756);
  // A stretched interval stops at the reset: the reading is void then, and the next pass finds the limit refilled.
  assert.equal(passSleepMs({ pollMs: 20_000, factor: 8, retryMs: 0, msToReset: 30_000 }), 31_000);
  // ...but never below one plain interval.
  assert.equal(passSleepMs({ pollMs: 20_000, factor: 8, retryMs: 0, msToReset: 2_000 }), 20_000);
  // With no reset known, the stretch applies as before, and GitHub's wait is a floor, not a multiplicand.
  assert.equal(passSleepMs({ pollMs: 20_000, factor: 4, retryMs: 0, msToReset: null }), 80_000);
  assert.equal(passSleepMs({ pollMs: 20_000, factor: 4, retryMs: 120_000, msToReset: null }), 121_000);
  assert.equal(passSleepMs({ pollMs: 20_000, factor: 1, retryMs: 0, msToReset: 5_000 }), 20_000);
});
