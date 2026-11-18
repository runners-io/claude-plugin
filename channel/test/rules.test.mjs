import assert from "node:assert/strict";
import { test } from "node:test";

import { baseVerdict, latestPerWorkflow } from "../src/rules.mjs";

test("the base branch is red when the latest completed run of any workflow failed; cancelled and skipped do not count", () => {
  const run = (name, conclusion, at, status = "completed") => ({ name, status, conclusion, created_at: at, updated_at: at });
  assert.deepEqual(baseVerdict([]), { red: false, failing: [], at: null });
  const green = baseVerdict([run("CI", "success", "2026-11-18T01:00:00Z"), run("CI", "failure", "2026-11-18T00:00:00Z")]);
  assert.equal(green.red, false, "the newer success wins over the older failure");
  assert.equal(green.at, "2026-11-18T01:00:00Z");
  const red = baseVerdict([
    run("CI", "failure", "2026-11-18T01:00:00Z"),
    run("Lint", "success", "2026-11-18T01:01:00Z"),
    run("Lint", "timed_out", "2026-11-18T00:59:00Z"),
    run("Deploy", "cancelled", "2026-11-18T01:02:00Z"),
    run("CI", null, "2026-11-18T01:05:00Z", "in_progress"),
  ]);
  assert.deepEqual(red, { red: true, failing: ["CI"], at: "2026-11-18T01:01:00Z" });
});

test("latestPerWorkflow keeps each workflow's newest completed, counted run, and nothing in progress or cancelled", () => {
  const run = (name, conclusion, at, status = "completed") => ({ name, status, conclusion, created_at: at, updated_at: at });
  const kept = latestPerWorkflow([
    run("CI", "failure", "2026-11-18T01:00:00Z"),
    run("CI", "success", "2026-11-18T00:00:00Z"),
    run("Lint", "success", "2026-11-18T01:01:00Z"),
    run("Deploy", "cancelled", "2026-11-18T01:02:00Z"),
    run("Mutants", null, "2026-11-18T01:05:00Z", "in_progress"),
  ]);
  assert.deepEqual(kept.map((r) => [r.name, r.conclusion]).sort(), [["CI", "failure"], ["Lint", "success"]]);
  assert.deepEqual(latestPerWorkflow([]), []);
});

// Seen live: `base.green` ("main is green again") at main d10fc8433e, while
// `reports · nightly export` had last FAILED on main at a17c9b506d and was skipped by its path filter
// on d10fc, so it had no run on the new head at all. A workflow with no run on the newest commit keeps its last
// result: the verdict is per workflow, never "the runs of the head commit".
test("a workflow skipped by its path filter on the new head keeps its last failure: the base stays red", () => {
  const run = (name, conclusion, at, sha) => ({ name, status: "completed", conclusion, created_at: at, updated_at: at, head_sha: sha });
  const v = baseVerdict([
    // The new head: every workflow its paths touched passed; the exporter's filter skipped it, so it has no run here.
    run("api · CI", "success", "2026-11-18T10:05:00Z", "d10fc8433e"),
    run("web · CI", "success", "2026-11-18T10:06:00Z", "d10fc8433e"),
    // Older heads.
    run("reports · nightly export", "failure", "2026-11-18T08:41:51Z", "a17c9b506d"),
    run("api · CI", "failure", "2026-11-18T08:40:00Z", "a17c9b506d"),
    run("reports · nightly export", "success", "2026-11-18T07:07:42Z", "a4fe6bb50c"),
  ]);
  assert.equal(v.red, true, "no run on the new head is not a pass");
  assert.deepEqual(v.failing, ["reports · nightly export"]);
});
