// The event log's one-command check (scripts/event-log-summary.mjs), run as a user would run it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFakeGitHub } from "./fake-github.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "event-log-summary.mjs");
const TOKEN = "gho_fakeSummaryToken0123";
const fakes = [];
after(async () => {
  for (const f of fakes) await f.close();
});

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

function writeLog(records) {
  const dir = mkdtempSync(join(tmpdir(), "rio-summary-"));
  const byDay = new Map();
  for (const r of records) {
    const day = r.t.slice(0, 10);
    byDay.set(day, `${byDay.get(day) ?? ""}${JSON.stringify(r)}\n`);
  }
  for (const [day, text] of byDay) writeFileSync(join(dir, `${day}.jsonl`), text);
  return dir;
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, GH_TOKEN: TOKEN, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

const base = { session: "s1", project: "/w/repo" };
const beat = (min, extra = {}) => ({ ...base, t: ago(min), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, requests: { ok: 10, not_modified: 90, other: 0 }, ...extra });

test("the summary counts events by kind and outcome, gives median and worst latency, and finds errors and gaps", async () => {
  const dir = writeLog([
    { ...base, t: ago(120), type: "start", version: "0.2.0" },
    { ...base, t: ago(119), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    beat(115),
    { ...base, t: ago(110), type: "event", kind: "ci.workflow_failed", repo: "acme/widgets", pr: 7, run_id: 41, outcome: "sent", latency_ms: 10_000 },
    { ...base, t: ago(109), type: "event", kind: "ci.workflow_failed", repo: "acme/widgets", pr: 7, run_id: 42, outcome: "sent", latency_ms: 30_000 },
    { ...base, t: ago(108), type: "event", kind: "ci.workflow_failed", repo: "acme/widgets", pr: 7, run_id: 43, outcome: "sent", latency_ms: 20_000 },
    { ...base, t: ago(107), type: "event", kind: "ci.workflow_succeeded", repo: "acme/widgets", pr: 7, run_id: 44, outcome: "filtered", latency_ms: 1_000 },
    { ...base, t: ago(106), type: "event", kind: "pr.conflict", repo: "acme/widgets", pr: 7, outcome: "sent", latency_ms: null },
    { ...base, t: ago(105), type: "api_error", repo: "acme/widgets", pr: 7, result: "retry", reason: "GitHub timed out" },
    beat(100),
    // 60 quiet minutes: a gap
    beat(40),
    { ...base, t: ago(39), type: "stop", reason: "closed" },
    { ...base, session: "old", t: ago(60 * 30), type: "event", kind: "ci.workflow_failed", outcome: "sent", latency_ms: 999_999 },
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json"]);
  assert.equal(r.code, 1, `a gap and an error are findings\n${r.stderr}`);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.events["ci.workflow_failed"], { sent: 3, filtered: 0, error: 0 });
  assert.deepEqual(s.events["ci.workflow_succeeded"], { sent: 0, filtered: 1, error: 0 });
  assert.equal(s.latency["ci.workflow_failed"].median_ms, 20_000);
  assert.equal(s.latency["ci.workflow_failed"].worst_ms, 30_000, "the 30-hour-old record is outside the window");
  assert.equal(s.latency["ci.workflow_failed"].worst.run_id, 42);
  assert.equal(s.latency["pr.conflict"], undefined, "no GitHub time, no latency");
  assert.deepEqual(s.errors, { "retry: GitHub timed out": 1 });
  assert.equal(s.gaps.length, 1);
  assert.equal(s.gaps[0].session, "s1");
  assert.ok(s.gaps[0].minutes >= 59 && s.gaps[0].minutes <= 61, String(s.gaps[0].minutes));
  assert.equal(s.sessions.length, 1);
  assert.equal(s.api.min_rate_remaining, 4000);
  const text = await run(["--dir", dir, "--since", "24h"]);
  assert.match(text.stdout, /ci\.workflow_failed\s+sent 3/);
  assert.match(text.stdout, /median 20\.0 s, worst 30\.0 s/);
});

test("with --github, a failure or a close GitHub shows inside a watched window and no session got is a miss; a superseded commit's failure is not", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  gh.setPull("acme/widgets", 7, { head: { sha: B, ref: "feat" }, state: "closed", closed_at: ago(20) });
  gh.setCommits("acme/widgets", 7, [A, B]);
  gh.setRuns("acme/widgets", A, [
    { id: 41, name: "CI", status: "completed", conclusion: "failure", created_at: ago(100), updated_at: ago(95) },
    // A finished failing after B was pushed: superseded, the channel rightly says nothing.
    { id: 43, name: "Lint", status: "completed", conclusion: "failure", created_at: ago(100), updated_at: ago(60) },
  ]);
  gh.setRuns("acme/widgets", B, [{ id: 42, name: "CI", status: "completed", conclusion: "failure", created_at: ago(70), updated_at: ago(50) }]);
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    beat(105),
    { ...base, t: ago(94), type: "event", kind: "ci.workflow_failed", repo: "acme/widgets", pr: 7, run_id: 41, outcome: "sent", latency_ms: 60_000 },
    beat(75),
    beat(45),
    beat(15),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 1, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(
    s.github.misses.map((m) => `${m.kind}:${m.run_id ?? ""}`).sort(),
    ["ci.workflow_failed:42", "pr.closed:"],
  );
  assert.equal(s.github.checked_prs, 1);
  assert.equal(s.github.superseded, 1);
  assert.ok(!JSON.stringify(s).includes(TOKEN));
});

test("with --github, the new kinds are checked too: labels and draft from issue events, flaky re-runs and the base branch", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  gh.setPull("acme/widgets", 7, { head: { sha: A, ref: "feat" }, base: { ref: "main" } });
  gh.setCommits("acme/widgets", 7, [A]);
  gh.setRuns("acme/widgets", A, [
    { id: 51, name: "CI", status: "completed", conclusion: "success", run_attempt: 2, created_at: ago(90), updated_at: ago(40) },
    { id: 52, name: "Lint", status: "completed", conclusion: "success", run_attempt: 2, created_at: ago(90), updated_at: ago(39) },
  ]);
  gh.setAttempt(51, 1, { id: 51, run_attempt: 1, conclusion: "failure" });
  gh.setAttempt(52, 1, { id: 52, run_attempt: 1, conclusion: "cancelled" }); // a cancelled first try is not a flake
  gh.setIssueEvents("acme/widgets", 7, [
    { event: "labeled", created_at: ago(80), label: { name: "hold" } },
    { event: "ready_for_review", created_at: ago(70) },
    { event: "convert_to_draft", created_at: ago(200) }, // before the window
  ]);
  gh.setBaseRuns("acme/widgets", "main", [
    { id: 1, name: "CI", status: "completed", conclusion: "success", created_at: ago(150), updated_at: ago(140) },
    { id: 2, name: "CI", status: "completed", conclusion: "failure", created_at: ago(65), updated_at: ago(60) },
  ]);
  const extra = [];
  const expected = ["base.red:", "ci.flaky:51", "pr.labels_changed:"];
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    beat(105),
    { ...base, t: ago(69), type: "event", kind: "pr.ready_for_review", repo: "acme/widgets", pr: 7, outcome: "sent", latency_ms: 60_000 },
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base, ...extra]);
  assert.equal(r.code, 1, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(
    s.github.misses.map((m) => `${m.kind}:${m.run_id ?? m.train_state ?? ""}`).sort(),
    expected.sort(),
  );
  assert.match(s.github.not_checked, /pr.head_moved/);
  assert.match(s.github.not_checked, /pr.body_edited/);
});

test("a session started without the channel flag is counted as channel_inactive, and is not a finding", async () => {
  const dir = writeLog([
    { ...base, t: ago(30), type: "start", version: "0.2.0", launch: "off" },
    { ...base, t: ago(30), type: "channel_inactive", launch: "off" },
    { ...base, session: "s2", t: ago(20), type: "start", version: "0.2.0", launch: "on" },
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).channel_inactive, { sessions: 1, projects: ["/w/repo"] });
  const text = await run(["--dir", dir, "--since", "24h"]);
  assert.match(text.stdout, /sessions started without the channel flag \(channel_inactive\): 1/);
});

test("no log at all is 'could not evaluate' (exit 2), never an all-clear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rio-summary-empty-"));
  const r = await run(["--dir", dir, "--since", "24h"]);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /no records/);
});
