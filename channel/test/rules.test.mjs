import assert from "node:assert/strict";
import { test } from "node:test";

import { baseVerdict } from "../src/rules.mjs";

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
