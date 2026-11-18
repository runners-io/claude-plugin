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
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, GH_TOKEN: TOKEN, RUNNERS_IO_TEST_FAKE_GITHUB: "1", ...env } }, (error, stdout, stderr) => {
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

// A check once reported "MISS pr.closed" for a PR. The one session that watched it
// was a harness killed by SIGTERM: no stop record, last record 21 s before the close. A session that wrote nothing
// for longer than a heartbeat interval has ended; it watched until its last record, not until now, and is listed so
// that a crash is seen. One still writing heartbeats is still watching.
test("--github-api sends the github.com login nowhere but api.github.com, or this machine under the tests' switch", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const dir = mkdtempSync(join(tmpdir(), "rio-summary-api-"));
  for (const api of [gh.base, "https://example.com", "http://api.github.com"]) {
    const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", api], { RUNNERS_IO_TEST_FAKE_GITHUB: "" });
    assert.equal(r.code, 2, `${api}: ${r.stderr}`);
    assert.match(r.stderr, /--github-api/);
  }
  const off = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", "https://example.com"]);
  assert.equal(off.code, 2, "the switch admits this machine only, never another host");
  assert.equal(gh.requests.length, 0, "the fake GitHub on this machine was never asked");
});

test("with --github, a session that ended without a stop record watched until its last record, and is listed", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  gh.setPull("acme/widgets", 4, { head: { sha: A, ref: "x" }, state: "closed", closed_at: ago(39.6) });
  gh.setCommits("acme/widgets", 4, [A]);
  gh.setRuns("acme/widgets", A, []);
  gh.setPull("acme/widgets", 5, { head: { sha: A, ref: "y" }, state: "closed", closed_at: ago(3) });
  gh.setCommits("acme/widgets", 5, [A]);
  const killed = { session: "killed", project: "/w/a" };
  const killedLast = ago(40);
  const alive = { session: "alive", project: "/w/b" };
  const dir = writeLog([
    { ...killed, t: ago(45), type: "start" },
    { ...killed, t: ago(44.9), type: "subscribe", repo: "acme/widgets", pr: 4, source: "tool" },
    { ...killed, t: killedLast, type: "event", kind: "ci.run_all_done", repo: "acme/widgets", pr: 4, outcome: "sent", latency_ms: 1000 },
    { ...alive, t: ago(20), type: "start" },
    { ...alive, t: ago(19.9), type: "subscribe", repo: "acme/widgets", pr: 5, source: "tool" },
    { ...alive, t: ago(1), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } },
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(
    s.github.misses.map((m) => `${m.kind}:${m.pr}`),
    ["pr.closed:5"],
    "the killed session's PR is not a miss; the live session's still is",
  );
  assert.deepEqual(s.ended_without_stop.map((e) => e.session), ["killed"]);
  assert.equal(s.ended_without_stop[0].last, killedLast);
  const text = await run(["--dir", dir, "--since", "24h", "--github", "--github-api", gh.base]);
  assert.match(text.stdout, /ended without a stop record: 1\n {2}killed/);
});

// `--since 1h --github` once reported "0 PR(s), 0 miss(es)" while a session watched a pull request throughout: its
// subscribe record was before the window, and only a subscribe inside the window opened one. A heartbeat's `watching` list says the PR was watched; a subscription older than the window
// counts from the window's start.
test("with --github, a PR subscribed before the window is still checked: a heartbeat's watching list opens it", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  gh.setPull("acme/widgets", 7, { head: { sha: A, ref: "feat" }, state: "open" });
  gh.setCommits("acme/widgets", 7, [A]);
  gh.setRuns("acme/widgets", A, [{ id: 51, name: "CI", status: "completed", conclusion: "failure", created_at: ago(70), updated_at: ago(60) }]);
  const watching = { watching: ["acme/widgets#7"] };
  const dir = writeLog([
    { ...base, t: ago(300), type: "start" },
    { ...base, t: ago(299), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    beat(110, watching),
    beat(80, watching),
    beat(50, watching),
    beat(20, watching),
    beat(1, watching),
  ]);
  const r = await run(["--dir", dir, "--since", "2h", "--json", "--github", "--github-api", gh.base]);
  const s = JSON.parse(r.stdout);
  assert.equal(s.github.checked_prs, 1, "the PR the heartbeats name was watched throughout the window");
  assert.deepEqual(s.github.misses.map((m) => `${m.kind}:${m.run_id}`), ["ci.workflow_failed:51"]);
  assert.equal(r.code, 1, r.stderr);
});

test("with --github, heartbeats that say a PR is watched while the check covers none is 'could not evaluate' (exit 2)", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  // An older build's heartbeat carries the count but not the names: the check cannot know what was watched.
  const dir = writeLog([beat(90), beat(60), beat(30), beat(1)]);
  const r = await run(["--dir", dir, "--since", "2h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /watched|subscri/i);
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
    s.github.misses.map((m) => `${m.kind}:${m.run_id ?? m.state ?? ""}`).sort(),
    expected.sort(),
  );
  assert.match(s.github.not_checked, /pr.head_moved/);
  assert.match(s.github.not_checked, /pr.body_edited/);
});

test("with --github, reviews and new review threads are checked against GitHub's REST history", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  gh.setPull("acme/widgets", 7, { head: { sha: A, ref: "feat" }, base: { ref: "main" } });
  gh.setCommits("acme/widgets", 7, [A]);
  gh.setReviews("acme/widgets", 7, [
    { id: 1, state: "APPROVED", submitted_at: ago(50) }, // no session got it: a miss
    { id: 2, state: "CHANGES_REQUESTED", submitted_at: ago(40) }, // sent
    { id: 3, state: "COMMENTED", submitted_at: ago(30) }, // not an event
    { id: 4, state: "APPROVED", submitted_at: ago(200) }, // before the window
  ]);
  gh.setReviewComments("acme/widgets", 7, [
    { id: 10, created_at: ago(55) }, // a new thread no session got: a miss
    { id: 11, created_at: ago(54), in_reply_to_id: 10 }, // a reply, not a thread
    { id: 12, created_at: ago(35) }, // a new thread, sent
  ]);
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    beat(105),
    // each matched by the id in its link: the sent thread (12) does not account for the unsent one (10)
    { ...base, t: ago(39), type: "event", kind: "pr.changes_requested", repo: "acme/widgets", pr: 7, outcome: "sent", latency_ms: 30_000, review_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-2" },
    { ...base, t: ago(34), type: "event", kind: "pr.review_thread_added", repo: "acme/widgets", pr: 7, outcome: "sent", latency_ms: 30_000, review_url: "https://github.com/acme/widgets/pull/7#discussion_r12" },
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 1, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.github.misses.map((m) => m.kind).sort(), ["pr.approved", "pr.review_thread_added"]);
  assert.match(s.github.not_checked, /pr.review_thread_resolved/);
  assert.match(s.github.not_checked, /pr.ready_to_merge/);
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

test("requests per hour, per session: what each session asked GitHub between its heartbeats, a restart's reset included", async () => {
  const req = (ok, nm, other = 0, shared = 0) => ({ requests: { ok, not_modified: nm, other, shared } });
  const dir = writeLog([
    { ...base, t: ago(130), type: "start", version: "0.2.0" },
    beat(120, req(2, 8)),
    beat(60, req(10, 40)), // +8 counted, +32 free in the first hour
    // the channel restarted inside the same session: its counters began again at zero
    beat(30, req(1, 4)),
    beat(0.5, req(3, 12, 1, 50)), // +5 +20 +1 since the restart; 50 served from the shared store cost nothing
    { session: "quiet", project: "/w/other", t: ago(90), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, ...req(0, 1) },
    { session: "quiet", project: "/w/other", t: ago(30), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, ...req(0, 10) },
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json"]);
  const s = JSON.parse(r.stdout);
  const per = s.api.requests_per_hour;
  // s1: 8+32 + 1+4 (the restart's first reading) + 2+8+1 = 56 requests over 119.5 minutes
  assert.equal(per.s1.requests, 56);
  assert.equal(per.s1.counted, 8 + 1 + 2);
  assert.equal(per.s1.hours, 1.99);
  assert.equal(per.s1.per_hour, 28.1);
  assert.equal(per.quiet.per_hour, 9);
  const text = (await run(["--dir", dir, "--since", "24h"])).stdout;
  assert.match(text, /s1: 28\.1 requests\/hour \(56 in 1\.99 h; 11 counted against the rate limit\)/);
});

test("what the summary prints from a record carries no control characters: a record's text could drive the terminal", async () => {
  // A record's session, project, kind and reasons are text a log line can hold; printed raw, an ESC or a C1
  // byte could clear the screen, rewrite earlier lines or set the window title.
  const session = "s\u001b]0;owned\u0007\u001b[2Jx";
  const project = "/w/\u009b31mrepo\r‮";
  const evil = { session, project };
  const dir = writeLog([
    { ...evil, t: ago(30), type: "start", version: "0.2.0" },
    { ...evil, t: ago(29), type: "event", kind: "ci.x\u001b[1A\u0085", repo: "acme/widgets", pr: 7, outcome: "sent", latency_ms: 1_000 },
    { ...evil, t: ago(28), type: "api_error", repo: "acme/widgets", pr: 7, result: "retry", reason: "boom\u001b[31m\u009d" },
    { ...evil, t: ago(27), type: "problem", kind: "p\u0007" },
    { ...evil, t: ago(26), type: "heartbeat", rate_remaining: 4000, requests: { ok: 1, not_modified: 0, other: 0 } },
    { ...evil, t: ago(25), type: "stop", reason: "closed" },
  ]);
  const text = await run(["--dir", dir, "--since", "24h"]);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(text.stdout), false, JSON.stringify(text.stdout));
  // The control: the records were read and printed, so the check above looked at their text.
  assert.match(text.stdout, /\/w\//);
  assert.match(text.stdout, /ci\.x/);
  assert.match(text.stdout, /boom/);

  const json = await run(["--dir", dir, "--since", "24h", "--json"]);
  assert.equal(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(json.stdout.replaceAll("\n", "")), false, JSON.stringify(json.stdout));
  // Escaped, not lost: the JSON still reads back as exactly what the record held.
  const s = JSON.parse(json.stdout);
  assert.equal(s.sessions[0].session, session);
  assert.equal(s.sessions[0].project, project);
});
