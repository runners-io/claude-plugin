import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunInfo } from "../src/github.ts";
import { type Snapshot, carry, diff, needsAttention } from "../src/state.ts";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

function run(id: number, status: string, conclusion: string | null = null, extra: Partial<RunInfo> = {}): RunInfo {
  return { id, name: `wf${id}`, status, conclusion, htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}`, runAttempt: 1, ...extra };
}

function snap(runs: RunInfo[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    repo: "acme/widgets",
    pr: 7,
    state: "open",
    headSha: SHA1,
    headRef: "feat",
    mergeableState: "clean",
    prUrl: "https://github.com/acme/widgets/pull/7",
    runs,
    ...extra,
  };
}

const kinds = (prev: Snapshot | null, next: Snapshot) => diff(prev, next).map((c) => `${c.kind}${c.run ? `:${c.run.id}` : ""}`);

test("the first snapshot is a baseline and says nothing", () => {
  assert.deepEqual(kinds(null, snap([run(1, "completed", "failure")], { mergeableState: "dirty" })), []);
});

test("a run appearing queued or moving to in_progress is ci.workflow_started once", () => {
  const a = snap([]);
  const b = snap([run(1, "queued")]);
  const c = snap([run(1, "in_progress")]);
  assert.deepEqual(kinds(a, b), ["ci.workflow_started:1"]);
  assert.deepEqual(kinds(b, c), []);
});

test("completed failure, timed_out and startup_failure are failed; success passed; cancelled cancelled", () => {
  const before = snap([run(1, "in_progress"), run(2, "in_progress"), run(3, "in_progress"), run(4, "in_progress"), run(5, "in_progress")]);
  const after = snap([
    run(1, "completed", "failure"),
    run(2, "completed", "timed_out"),
    run(3, "completed", "startup_failure"),
    run(4, "completed", "success"),
    run(5, "completed", "cancelled"),
  ]);
  assert.deepEqual(kinds(before, after), [
    "ci.workflow_failed:1",
    "ci.workflow_failed:2",
    "ci.workflow_failed:3",
    "ci.workflow_succeeded:4",
    "ci.workflow_cancelled:5",
    "ci.run_all_done",
  ]);
});

test("a skipped run is not reported, and does not hold up all-done", () => {
  const before = snap([run(1, "in_progress"), run(2, "queued")]);
  const after = snap([run(1, "completed", "success"), run(2, "completed", "skipped")]);
  assert.deepEqual(kinds(before, after), ["ci.workflow_succeeded:1", "ci.run_all_done"]);
});

test("waiting is approval_waiting, once", () => {
  const a = snap([run(1, "in_progress")]);
  const b = snap([run(1, "waiting")]);
  assert.deepEqual(kinds(a, b), ["ci.approval_waiting:1"]);
  assert.deepEqual(kinds(b, b), []);
  assert.deepEqual(kinds(snap([]), b), ["ci.approval_waiting:1"], "a run that appears already waiting is reported as waiting");
});

test("all completed for the head sha emits run_all_done once with the worst conclusion", () => {
  const a = snap([run(1, "completed", "success"), run(2, "in_progress")]);
  const b = snap([run(1, "completed", "success"), run(2, "completed", "failure")]);
  const done = diff(a, b).find((c) => c.kind === "ci.run_all_done");
  assert.equal(done?.conclusion, "failure");
  assert.deepEqual(kinds(b, b), [], "nothing new, no second all-done");
  const c = snap([run(1, "completed", "success"), run(2, "completed", "cancelled")]);
  assert.equal(diff(a, c).find((x) => x.kind === "ci.run_all_done")?.conclusion, "cancelled");
});

test("a new head sha resets the runs: the old sha's results are not compared and all-done waits for the new ones", () => {
  const old = snap([run(1, "completed", "failure")]);
  const pushed = snap([run(9, "queued")], { headSha: SHA2 });
  assert.deepEqual(kinds(old, pushed), ["ci.workflow_started:9"]);
  const pushedNoRunsYet = snap([], { headSha: SHA2 });
  assert.deepEqual(kinds(old, pushedNoRunsYet), [], "no runs yet for the new sha: no all-done");
});

test("a re-run reports again: started, then its new result", () => {
  const failed = snap([run(1, "completed", "failure")]);
  const rerun = snap([run(1, "queued", null, { runAttempt: 2 })]);
  const passed = snap([run(1, "completed", "success", { runAttempt: 2 })]);
  assert.deepEqual(kinds(failed, rerun), ["ci.workflow_started:1"]);
  assert.deepEqual(kinds(rerun, passed), ["ci.workflow_succeeded:1", "ci.run_all_done"]);
});

test("dirty is pr.conflict; leaving dirty is conflict_resolved", () => {
  assert.deepEqual(kinds(snap([]), snap([], { mergeableState: "dirty" })), ["pr.conflict"]);
  assert.deepEqual(kinds(snap([], { mergeableState: "dirty" }), snap([], { mergeableState: "clean" })), ["pr.conflict_resolved"]);
});

test("unknown mergeability says nothing, and carry keeps the last known state through it", () => {
  const dirty = snap([], { mergeableState: "dirty" });
  const computing = snap([], { mergeableState: "unknown" });
  assert.deepEqual(kinds(dirty, computing), []);
  const kept = carry(dirty, computing);
  assert.equal(kept.mergeableState, "dirty");
  assert.deepEqual(kinds(kept, snap([], { mergeableState: "dirty" })), [], "still dirty after GitHub recomputes: no second conflict");
  assert.deepEqual(kinds(snap([]), computing), []);
});

test("merged and closed each end with one event and nothing else", () => {
  const open = snap([run(1, "in_progress")]);
  assert.deepEqual(kinds(open, snap([run(1, "completed", "success")], { state: "merged" })), ["pr.merged"]);
  assert.deepEqual(kinds(open, snap([], { state: "closed" })), ["pr.closed"]);
});

test("needsAttention is a failed run, a run waiting for approval, or a conflict", () => {
  assert.equal(needsAttention(snap([run(1, "completed", "success"), run(2, "in_progress")])), false);
  assert.equal(needsAttention(snap([run(1, "completed", "failure")])), true);
  assert.equal(needsAttention(snap([run(1, "waiting")])), true);
  assert.equal(needsAttention(snap([], { mergeableState: "dirty" })), true);
});

test("action_required (a fork's run waiting for a maintainer) is approval_waiting, never a failure", () => {
  const a = snap([run(1, "queued")]);
  const b = snap([run(1, "completed", "action_required")]);
  assert.deepEqual(kinds(a, b), ["ci.approval_waiting:1", "ci.run_all_done"]);
  assert.equal(diff(a, b).find((c) => c.kind === "ci.run_all_done")?.conclusion, "action_required");
  assert.equal(needsAttention(b), true);
});

test("labels added and removed are one pr.labels_changed, naming each", () => {
  const a = snap([], { labels: ["ci", "hold"] });
  const b = snap([], { labels: ["ci", "catalogue-reviewed"] });
  const c = diff(a, b).find((x) => x.kind === "pr.labels_changed");
  assert.deepEqual(c?.labelsAdded, ["catalogue-reviewed"]);
  assert.deepEqual(c?.labelsRemoved, ["hold"]);
  assert.deepEqual(kinds(b, snap([], { labels: ["catalogue-reviewed", "ci"] })), [], "order does not matter");
  assert.deepEqual(kinds(snap([]), snap([], { labels: ["hold"] })), [], "a snapshot without labels read is not a change");
});

test("draft to ready is pr.ready_for_review; ready to draft is pr.converted_to_draft", () => {
  assert.deepEqual(kinds(snap([], { draft: true }), snap([], { draft: false })), ["pr.ready_for_review"]);
  assert.deepEqual(kinds(snap([], { draft: false }), snap([], { draft: true })), ["pr.converted_to_draft"]);
  assert.deepEqual(kinds(snap([], { draft: true }), snap([], { draft: true })), []);
});

test("a changed body is pr.body_edited, by its hash only; the body itself is never in the snapshot", () => {
  assert.deepEqual(kinds(snap([], { bodyHash: "aaa" }), snap([], { bodyHash: "bbb" })), ["pr.body_edited"]);
  assert.deepEqual(kinds(snap([], { bodyHash: "aaa" }), snap([], { bodyHash: "aaa" })), []);
  assert.deepEqual(kinds(snap([]), snap([], { bodyHash: "bbb" })), [], "no hash before: not a change");
});

test("a re-run of the same commit that passes after a failure is ci.flaky, after its own success", () => {
  const failed = carry(null, snap([run(1, "completed", "failure")]));
  const rerun = carry(failed, snap([run(1, "queued", null, { runAttempt: 2 })]));
  assert.equal(rerun.failedAttempts?.[1], 1, "the failed attempt is remembered through the re-run");
  assert.deepEqual(kinds(rerun, snap([run(1, "completed", "success", { runAttempt: 2 })])), ["ci.workflow_succeeded:1", "ci.flaky:1", "ci.run_all_done"]);
  const again = carry(rerun, snap([run(1, "completed", "failure", { runAttempt: 2 })]));
  assert.deepEqual(kinds(again, snap([run(1, "completed", "failure", { runAttempt: 2 })])), []);
  const pushed = carry(failed, snap([run(9, "queued")], { headSha: SHA2 }));
  assert.equal(pushed.failedAttempts?.[1], undefined, "a new commit forgets the old commit's failures");
});

test("a first pass with no failure before is not flaky", () => {
  const a = carry(null, snap([run(1, "in_progress")]));
  assert.deepEqual(kinds(a, snap([run(1, "completed", "success")])), ["ci.workflow_succeeded:1", "ci.run_all_done"]);
});
