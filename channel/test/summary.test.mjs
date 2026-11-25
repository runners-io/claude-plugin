// The event log's one-command check (scripts/event-log-summary.mjs), run as a user would run it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, RUNNERS_IO_TEST_GITHUB_TOKEN: TOKEN, RUNNERS_IO_TEST_FAKE_GITHUB: "1", ...env } }, (error, stdout, stderr) => {
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

// The channel writes into a subfolder of its own (eventlog.ts EVENT_LOG_SUBDIR); a log written before it did is
// directly in the directory. --dir is the directory the user set either way, and both are read.
test("the summary reads the channel's own subfolder of --dir, as well as day files directly in it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rio-summary-"));
  const own = join(dir, "runners-io-events");
  mkdirSync(own);
  const rec = (min, run_id) => ({ ...base, t: ago(min), type: "event", kind: "ci.workflow_failed", repo: "acme/widgets", pr: 7, run_id, outcome: "sent", latency_ms: 1_000 });
  writeFileSync(join(own, `${ago(30).slice(0, 10)}.jsonl`), `${JSON.stringify({ ...base, t: ago(31), type: "start" })}\n${JSON.stringify(rec(30, 1))}\n`);
  writeFileSync(join(dir, `${ago(20).slice(0, 10)}.jsonl`), `${JSON.stringify(rec(20, 2))}\n`);
  const r = await run(["--dir", dir, "--since", "24h", "--json"]);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.events["ci.workflow_failed"], { sent: 2, filtered: 0, error: 0 }, r.stderr);
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

// The switch is an environment variable, so anything that sets one can set it. Under it this machine gets only the
// tests' own token: never the user's GH_TOKEN, GITHUB_TOKEN or gh login.
test("under the tests' switch the user's real github.com login is never sent to this machine", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setPull("acme/widgets", 7, { head: { sha: "a".repeat(40), ref: "feat" }, state: "open" });
  const dir = writeLog([{ ...base, t: ago(30), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" }, beat(15)]);
  const args = ["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base];
  const r = await run(args, { RUNNERS_IO_TEST_GITHUB_TOKEN: "", GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, PATH: "/nonexistent" });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(gh.requests.length, 0, "no request reached the listener on this machine");
  // The control: with the tests' own token the same run does ask the fake, so the zero above is not vacuous.
  await run(args);
  assert.ok(gh.requests.length > 0, "the tests' own token reaches the fake GitHub");
});

test("with --github, a session that ended without a stop record watched until its last record, and is listed", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  gh.setPull("acme/widgets", 4, { head: { sha: A, ref: "x" }, state: "closed", closed_at: ago(39.6) });
  gh.setCommits("acme/widgets", 4, [A]);
  gh.setRuns("acme/widgets", A, []);
  // Closed longer than FINISHED_MAX_MS before now, so the live session's watch reached past its next look.
  gh.setPull("acme/widgets", 5, { head: { sha: A, ref: "y" }, state: "closed", closed_at: ago(10) });
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

// One check reported 43 MISSes, 41 of them false. Each rule below is one of their causes; PR 9 is
// the control, a close nothing reported, which must stay a MISS.
test("with --github, no MISS for an unsubscribe-all, a kind the subscription excluded, or an event overtaken within one poll", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const sha = (c) => c.repeat(40);
  // A: closed after the session's unsubscribe-all (repo null), which must close every window of that session.
  gh.setPull("acme/widgets", 1, { head: { sha: sha("1"), ref: "one" }, state: "closed", closed_at: ago(50) });
  // B: the subscription asked for failures only. The merge was logged as filtered; the approval was never computed.
  gh.setPull("acme/widgets", 2, { head: { sha: sha("2"), ref: "two" }, state: "closed", merged: true, merged_at: ago(50), closed_at: ago(50) });
  gh.setReviews("acme/widgets", 2, [{ id: 902, state: "APPROVED", submitted_at: ago(70) }]);
  gh.setPull("acme/widgets", 3, { head: { sha: sha("3"), ref: "three" } });
  gh.setRuns("acme/widgets", sha("3"), [{ id: 31, name: "CI", status: "completed", conclusion: "failure", created_at: ago(90), updated_at: ago(80) }]);
  // E: a failure on a commit replaced 20 s later, and a merge the session stopped watching 20 s after.
  const old4 = sha("4");
  const new4 = sha("5");
  gh.setPull("acme/widgets", 4, { head: { sha: new4, ref: "four" } });
  gh.setCommits("acme/widgets", 4, [old4, new4]);
  gh.setRuns("acme/widgets", old4, [{ id: 41, name: "CI", status: "completed", conclusion: "failure", created_at: ago(90), updated_at: ago(60) }]);
  gh.setRuns("acme/widgets", new4, [{ id: 42, name: "CI", status: "in_progress", created_at: ago(60 - 1 / 3), updated_at: ago(59) }]);
  gh.setPull("acme/widgets", 6, { head: { sha: sha("6"), ref: "six" }, state: "closed", merged: true, merged_at: ago(40), closed_at: ago(40) });
  // The control: watched for every kind, closed, nothing sent.
  gh.setPull("acme/widgets", 9, { head: { sha: sha("9"), ref: "nine" }, state: "closed", closed_at: ago(30) });
  const s2 = { session: "s2", project: "/w/repo" };
  const dir = writeLog([
    { ...s2, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 1, source: "tool", events: "all" },
    { ...s2, t: ago(80), type: "unsubscribe", repo: null, pr: null, source: "tool", reason: "tool", count: 1 },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 2, source: "tool", events: ["ci.workflow_failed"] },
    { ...base, t: ago(49), type: "event", kind: "pr.merged", repo: "acme/widgets", pr: 2, outcome: "filtered" },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 3, source: "tool", events: ["pr.merged"] },
    { ...base, t: ago(79), type: "event", kind: "ci.workflow_failed", repo: "acme/widgets", pr: 3, run_id: 31, outcome: "filtered" },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 4, source: "tool", events: "all" },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 6, source: "tool", events: "all" },
    { ...base, t: ago(40 - 1 / 3), type: "unsubscribe", repo: "acme/widgets", pr: 6, source: "tool", reason: "tool", count: 1 },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 9, source: "tool", events: "all" },
    beat(105),
    { ...s2, t: ago(100), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } },
    { ...s2, t: ago(5), type: "heartbeat", subscriptions: 0, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } },
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.github.misses.map((m) => `${m.kind}#${m.pr}`),
    ["pr.closed#9"],
    "only the control is a MISS",
  );
  assert.equal(out.github.overtaken, 2, "the replaced commit's failure and the merge watched 20 s longer");
});

test("with --github, a change a merge overtook, or a kind the session muted, is not a MISS; a change the session should have seen is", async () => {
  // Seen live: a `hold` label came off four PRs 11-37 s before auto-merge landed them. The channel's
  // diff() reports only pr.merged once a poll sees the PR merged, so the label change was overtaken. But the window
  // ran to the unsubscribe, logged when the session NOTICED the merge (one to two minutes later), so the checker
  // called each one "in" and a MISS. One session had also muted pr.labels_changed before it.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const sha = (c) => c.repeat(40);
  // M: hold removed 11 s before the merge; the session logged the merge and unsubscribed 70 s after GitHub merged it.
  gh.setPull("acme/widgets", 11, { head: { sha: sha("a"), ref: "m" }, state: "closed", merged: true, merged_at: ago(50), closed_at: ago(50) });
  gh.setIssueEvents("acme/widgets", 11, [{ event: "unlabeled", label: { name: "hold" }, created_at: ago(50 + 11 / 60) }]);
  // U: the session muted pr.labels_changed, then the label came off ten minutes before the merge.
  gh.setPull("acme/widgets", 12, { head: { sha: sha("b"), ref: "u" }, state: "closed", merged: true, merged_at: ago(40), closed_at: ago(40) });
  gh.setIssueEvents("acme/widgets", 12, [{ event: "unlabeled", label: { name: "hold" }, created_at: ago(50) }]);
  // The control: the label came off ten minutes before the merge, watched for every kind, nothing sent.
  gh.setPull("acme/widgets", 13, { head: { sha: sha("c"), ref: "c" }, state: "closed", merged: true, merged_at: ago(40), closed_at: ago(40) });
  gh.setIssueEvents("acme/widgets", 13, [{ event: "unlabeled", label: { name: "hold" }, created_at: ago(50) }]);
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 11, source: "tool", events: "all" },
    { ...base, t: ago(50 - 70 / 60), type: "event", kind: "pr.merged", repo: "acme/widgets", pr: 11, outcome: "sent" },
    { ...base, t: ago(50 - 70 / 60), type: "unsubscribe", repo: "acme/widgets", pr: 11, source: "tool", reason: "merged" },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 12, source: "tool", events: "all" },
    { ...base, t: ago(60), type: "mute", repo: "acme/widgets", pr: 12, kinds: ["pr.labels_changed"], workflow: null },
    { ...base, t: ago(39), type: "event", kind: "pr.merged", repo: "acme/widgets", pr: 12, outcome: "sent" },
    { ...base, t: ago(39), type: "unsubscribe", repo: "acme/widgets", pr: 12, source: "tool", reason: "merged" },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 13, source: "tool", events: "all" },
    { ...base, t: ago(39), type: "event", kind: "pr.merged", repo: "acme/widgets", pr: 13, outcome: "sent" },
    { ...base, t: ago(39), type: "unsubscribe", repo: "acme/widgets", pr: 13, source: "tool", reason: "merged" },
    beat(105),
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.github.misses.map((m) => `${m.kind}#${m.pr}`),
    ["pr.labels_changed#13"],
    "only the control is a MISS",
  );
  assert.equal(out.github.overtaken, 1, "the label change the merge overtook");
});

// Seen live: one day's event log still had 10 label changes counted as MISSes that the channel could never have seen. A finished PR is looked at only every FINISHED_MS..FINISHED_MAX_MS (cadence.ts), and each look reports what
// changed since the last (state.ts diff): a label added and taken off between two looks changed nothing, and a label
// change followed by the merge before the next look is reported as pr.merged alone. The test above covered the second
// only when the watch ended within a minute of the change.
test("with --github, a label flipped back, or overtaken by the merge, before the next look is not a MISS; a look in between, a change long before the merge, or one never undone is", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const sha = (c) => c.repeat(40);
  const hold = { name: "hold" };
  // F: hold added and taken off 14 s later on an open PR, with nothing logged for the PR in between.
  gh.setPull("acme/widgets", 21, { head: { sha: sha("1"), ref: "f" } });
  gh.setIssueEvents("acme/widgets", 21, [
    { event: "labeled", label: hold, created_at: ago(50) },
    { event: "unlabeled", label: hold, created_at: ago(50 - 14 / 60) },
  ]);
  // M: hold taken off 111 s before the merge; the session noticed the merge 80 s after GitHub made it.
  gh.setPull("acme/widgets", 22, { head: { sha: sha("2"), ref: "m" }, state: "closed", merged: true, merged_at: ago(40), closed_at: ago(40) });
  gh.setIssueEvents("acme/widgets", 22, [{ event: "unlabeled", label: hold, created_at: ago(40 + 111 / 60) }]);
  // Control (a): the same flip, but the watching session logged an event for the PR between the two: it looked, so it
  // saw the label on. Both changes stay MISSes.
  gh.setPull("acme/widgets", 23, { head: { sha: sha("3"), ref: "a" } });
  gh.setIssueEvents("acme/widgets", 23, [
    { event: "labeled", label: hold, created_at: ago(50) },
    { event: "unlabeled", label: hold, created_at: ago(50 - 20 / 60) },
  ]);
  // Control (b): hold taken off six minutes before the merge: several looks happened in between.
  gh.setPull("acme/widgets", 24, { head: { sha: sha("4"), ref: "b" }, state: "closed", merged: true, merged_at: ago(40), closed_at: ago(40) });
  gh.setIssueEvents("acme/widgets", 24, [{ event: "unlabeled", label: hold, created_at: ago(46) }]);
  // Control (c): hold added to a PR that stays open, never undone.
  gh.setPull("acme/widgets", 25, { head: { sha: sha("5"), ref: "c" } });
  gh.setIssueEvents("acme/widgets", 25, [{ event: "labeled", label: hold, created_at: ago(50) }]);
  // Control (d): hold added and taken off six minutes apart: a look lay between them whatever the cadence.
  gh.setPull("acme/widgets", 26, { head: { sha: sha("6"), ref: "d" } });
  gh.setIssueEvents("acme/widgets", 26, [
    { event: "labeled", label: hold, created_at: ago(50) },
    { event: "unlabeled", label: hold, created_at: ago(44) },
  ]);
  // Control (e): two DIFFERENT labels 14 s apart are not a flip of either.
  gh.setPull("acme/widgets", 27, { head: { sha: sha("7"), ref: "e" } });
  gh.setIssueEvents("acme/widgets", 27, [
    { event: "labeled", label: hold, created_at: ago(50) },
    { event: "unlabeled", label: { name: "wip" }, created_at: ago(50 - 14 / 60) },
  ]);
  const sub = (pr) => ({ ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr, source: "tool", events: "all" });
  const dir = writeLog([
    ...[21, 22, 23, 24, 25, 26, 27].map(sub),
    { ...base, t: ago(50 - 10 / 60), type: "event", kind: "ci.workflow_succeeded", repo: "acme/widgets", pr: 23, run_id: 231, outcome: "filtered" },
    { ...base, t: ago(40 - 80 / 60), type: "event", kind: "pr.merged", repo: "acme/widgets", pr: 22, outcome: "sent" },
    { ...base, t: ago(40 - 80 / 60), type: "unsubscribe", repo: "acme/widgets", pr: 22, source: "tool", reason: "merged" },
    { ...base, t: ago(39), type: "event", kind: "pr.merged", repo: "acme/widgets", pr: 24, outcome: "sent" },
    { ...base, t: ago(39), type: "unsubscribe", repo: "acme/widgets", pr: 24, source: "tool", reason: "merged" },
    beat(105),
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.github.misses.map((m) => `${m.kind}#${m.pr}`).sort(),
    ["pr.labels_changed#23", "pr.labels_changed#23", "pr.labels_changed#24", "pr.labels_changed#25", "pr.labels_changed#26", "pr.labels_changed#26", "pr.labels_changed#27", "pr.labels_changed#27"],
    "only the controls are MISSes",
  );
  assert.equal(out.github.overtaken, 3, "both halves of the flip, and the label change the merge overtook");
});

// Three changes of one label between two looks (added, taken off, added again) are not a flip: the PR went from
// without the label to with it, so the channel owes one pr.labels_changed. Pairing each change with either neighbour
// would count all three as overtaken and hide a real MISS; only an even run of changes cancels out.
test("with --github, a label changed an odd number of times between two looks still owes one pr.labels_changed", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const hold = { name: "hold" };
  gh.setPull("acme/widgets", 31, { head: { sha: "3".repeat(40), ref: "odd" } });
  gh.setIssueEvents("acme/widgets", 31, [
    { event: "labeled", label: hold, created_at: ago(50) },
    { event: "unlabeled", label: hold, created_at: ago(50 - 10 / 60) },
    { event: "labeled", label: hold, created_at: ago(50 - 20 / 60) },
  ]);
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 31, source: "tool", events: "all" },
    beat(105),
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.map((m) => `${m.kind}#${m.pr}`), ["pr.labels_changed#31"], "the net change is owed once");
  assert.equal(out.github.overtaken, 2, "the add and remove that cancelled out");
});

test("with --github, a real log's flip (#6660) and late merge (#6737) are overtaken, at their real times", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const repo = "acme/widgets";
  const hold = { name: "hold" };
  gh.setPull(repo, 6660, { head: { sha: "6".repeat(40), ref: "flip" } });
  gh.setIssueEvents(repo, 6660, [
    { event: "labeled", label: hold, created_at: "2026-11-19T22:08:13Z" },
    { event: "unlabeled", label: hold, created_at: "2026-11-19T22:08:27Z" },
  ]);
  gh.setPull(repo, 6737, { head: { sha: "7".repeat(40), ref: "late" }, state: "closed", merged: true, merged_at: "2026-11-20T01:17:21Z", closed_at: "2026-11-20T01:17:21Z" });
  gh.setIssueEvents(repo, 6737, [{ event: "unlabeled", label: hold, created_at: "2026-11-20T01:15:30Z" }]);
  const at = (t, r) => ({ ...base, t, ...r });
  const dir = writeLog([
    at("2026-11-19T21:30:00.000Z", { type: "subscribe", repo, pr: 6660, source: "auto" }),
    at("2026-11-19T21:30:00.000Z", { type: "subscribe", repo, pr: 6737, source: "auto" }),
    at("2026-11-19T22:05:00.000Z", { type: "heartbeat", subscriptions: 2, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } }),
    at("2026-11-20T01:19:02.000Z", { type: "event", kind: "pr.merged", repo, pr: 6737, outcome: "sent" }),
    at("2026-11-20T01:19:02.000Z", { type: "unsubscribe", repo, pr: 6737, source: "tool", reason: "merged" }),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "2026-11-19T21:00:00Z", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses, [], r.stderr);
  assert.equal(out.github.overtaken, 3, "the flip's two halves and the label change 111 s before the merge");
});

test("with --github, the base replay reads far enough back to know a workflow's last verdict: a red that never cleared is not a new red", async () => {
  // Once, main's dependency audit failed, then more than 100 push runs finished. The newest 100 no longer
  // held it, so the check saw main green, then expected a base.red that the channel rightly never sent.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const A = "a".repeat(40);
  gh.setPull("acme/widgets", 7, { head: { sha: A, ref: "feat" }, base: { ref: "main" } });
  gh.setCommits("acme/widgets", 7, [A]);
  const runs = [{ id: 1, name: "Audit", status: "completed", conclusion: "failure", created_at: ago(100), updated_at: ago(99) }];
  for (let i = 0; i < 120; i++) {
    const at = 98 - i * 0.5;
    runs.push({ id: 100 + i, name: "CI", status: "completed", conclusion: "success", created_at: ago(at), updated_at: ago(at - 0.1) });
  }
  runs.push({ id: 999, name: "Lint", status: "completed", conclusion: "failure", created_at: ago(20), updated_at: ago(19) });
  gh.setBaseRuns("acme/widgets", "main", runs);
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    { ...base, t: ago(98), type: "event", kind: "base.red", repo: "acme/widgets", pr: 7, outcome: "sent", base: "main", failing: ["Audit"] },
    beat(105),
    beat(75),
    beat(45),
    beat(15),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.filter((m) => m.kind.startsWith("base.")), [], r.stderr);
});

test("with --github, a watch that began before the window keeps the events its subscription chose", async () => {
  // A session subscribed to failures only, the evening before; the check's window opened on its heartbeats' watching
  // list, which names the PR but not the choice, so every other kind was expected of it and counted as MISSes.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setPull("acme/widgets", 1, { head: { sha: "1".repeat(40), ref: "one" }, state: "closed", closed_at: ago(60) });
  // The control: subscribed before the window to every kind, closed, nothing sent. It must stay a MISS.
  gh.setPull("acme/widgets", 2, { head: { sha: "2".repeat(40), ref: "two" }, state: "closed", closed_at: ago(60) });
  const watching = ["acme/widgets#1", "acme/widgets#2"];
  const dir = writeLog([
    { ...base, t: ago(30 * 60), type: "subscribe", repo: "acme/widgets", pr: 1, source: "tool", events: ["ci.workflow_failed"] },
    { ...base, t: ago(30 * 60), type: "subscribe", repo: "acme/widgets", pr: 2, source: "tool", events: "all" },
    beat(105, { subscriptions: 2, watching }),
    beat(75, { subscriptions: 2, watching }),
    beat(45, { subscriptions: 2, watching }),
    beat(15, { subscriptions: 2, watching }),
    beat(1, { subscriptions: 2, watching }),
  ]);
  const r = await run(["--dir", dir, "--since", "2h", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.map((m) => `${m.kind}#${m.pr}`), ["pr.closed#2"], r.stderr);
});

test("with --github, a base turn is told once per session and base, on any one of its PRs: the others are not MISSes", async () => {
  // The channel reads a base branch once for all of a session's PRs on it, and sends base.red on one of them. A check
  // looked for it on every PR, and counted the session's other PRs on main as missed.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  for (const pr of [7, 8, 9]) {
    const sha = String(pr).repeat(40);
    gh.setPull("acme/widgets", pr, { head: { sha, ref: `feat-${pr}` }, base: { ref: "main" } });
    gh.setCommits("acme/widgets", pr, [sha]);
  }
  gh.setBaseRuns("acme/widgets", "main", [
    { id: 1, name: "CI", status: "completed", conclusion: "success", created_at: ago(150), updated_at: ago(140) },
    { id: 2, name: "CI", status: "completed", conclusion: "failure", created_at: ago(65), updated_at: ago(60) },
  ]);
  const s2 = { session: "s2", project: "/w/other" };
  const dir = writeLog([
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" },
    { ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 8, source: "tool" },
    // The control: another session watching PR 9 on the same base, told nothing. It must stay a MISS.
    { ...s2, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 9, source: "tool" },
    { ...base, t: ago(59), type: "event", kind: "base.red", repo: "acme/widgets", pr: 7, base: "main", failing: ["CI"], outcome: "sent" },
    beat(105),
    beat(75),
    beat(45),
    beat(15),
    beat(1),
    { ...s2, t: ago(100), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } },
    { ...s2, t: ago(50), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } },
    { ...s2, t: ago(2), type: "heartbeat", subscriptions: 1, rate_remaining: 4000, requests: { ok: 1, not_modified: 1, other: 0 } },
  ]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.map((m) => `${m.kind}#${m.pr}`), ["base.red#9"], r.stderr);
});

test("with --github, a PR's runs are read per head branch, not once per commit, and the requests made are counted", async () => {
  // A PR the merge queue updates collects a commit each time; one read per commit made a day's check cost thousands.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const shas = ["a", "b", "c", "d", "e"].map((c) => c.repeat(40));
  gh.setPull("acme/widgets", 7, { head: { sha: shas[4], ref: "feat" } });
  gh.setCommits("acme/widgets", 7, shas);
  shas.forEach((sha, i) =>
    gh.setRuns("acme/widgets", sha, [
      { id: 40 + i, name: "CI", status: "completed", conclusion: i === 4 ? "failure" : "success", created_at: ago(100 - i * 10), updated_at: ago(98 - i * 10) },
    ]),
  );
  const dir = writeLog([{ ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" }, beat(105), beat(75), beat(45), beat(15), beat(1)]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.map((m) => `${m.kind}:${m.run_id}`), ["ci.workflow_failed:44"], "the head's failure is still found");
  const runReads = gh.requests.filter((q) => /\/actions\/runs\?/.test(q.path));
  assert.equal(runReads.length, 1, runReads.map((q) => q.path).join(", "));
  assert.equal(out.github.requests, gh.requests.length);
});

test("with --github, the check stops below the login's floor of requests left: 'could not evaluate' (exit 2), never a drain", async () => {
  // The check shares its login with every session and tool; a check that spends the last of it stalls all of them.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setRate(1400, 5000);
  gh.setPull("acme/widgets", 7, { head: { sha: "a".repeat(40), ref: "feat" } });
  gh.setCommits("acme/widgets", 7, ["a".repeat(40)]);
  const dir = writeLog([{ ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr: 7, source: "auto" }, beat(105), beat(1)]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /1400 .*left.*1500/);
  assert.equal(gh.requests.length, 1, "it stopped at the first answer");
});

test("with --github, a base branch's history is read once for every PR on it, not once per PR", async () => {
  // A replay of one day's log read main's history up to ten pages deep for each of 99 PRs, and spent the shared
  // login's hourly limit, which every other tool on it also uses. The count of reads is the regression test.
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const runs = [];
  for (let i = 0; i < 150; i++) {
    const at = 100 - i * 0.5;
    runs.push({ id: 100 + i, name: "CI", status: "completed", conclusion: "success", created_at: ago(at), updated_at: ago(at - 0.1) });
  }
  gh.setBaseRuns("acme/widgets", "main", runs);
  const records = [];
  for (const pr of [7, 8, 9]) {
    const sha = String(pr).repeat(40);
    gh.setPull("acme/widgets", pr, { head: { sha, ref: `feat-${pr}` }, base: { ref: "main" } });
    gh.setCommits("acme/widgets", pr, [sha]);
    records.push({ ...base, t: ago(110), type: "subscribe", repo: "acme/widgets", pr, source: "auto" });
  }
  const dir = writeLog([...records, beat(105), beat(75), beat(45), beat(15), beat(1)]);
  const r = await run(["--dir", dir, "--since", "24h", "--json", "--github", "--github-api", gh.base]);
  assert.notEqual(r.code, 2, r.stderr); // it evaluated
  const baseReads = gh.requests.filter((q) => q.path.includes("/actions/runs?") && q.path.includes("event=push"));
  assert.equal(baseReads.length, 2, `two pages of main's history, read once for all three PRs: ${baseReads.map((q) => q.path).join(", ")}`);
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

// Three more false MISSes from one day's check, each a change no look could have seen.

// #6848's failure is dated 09:50:15Z by GitHub; the hook subscribed at 09:50:15.145Z. The first look after a subscribe
// is a baseline (state.ts: diff(null, s) is empty), so that failure was in it. As strings, "...15Z" >= "...15.145Z",
// because "Z" sorts after ".". A change GitHub dates (whole seconds) at or before the subscribe's second is baseline.
test("with --github, a failure GitHub dates in the subscribe's own second is baseline; one 2 s after is a MISS", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const repo = "acme/widgets";
  for (const [pr, failedAt] of [
    [6848, "2026-11-20T09:50:15Z"],
    [6849, "2026-11-20T09:50:17Z"], // the control
  ]) {
    const sha = String(pr % 10).repeat(40);
    gh.setPull(repo, pr, { head: { sha, ref: `f${pr}` } });
    gh.setCommits(repo, pr, [sha]);
    gh.setRuns(repo, sha, [{ id: pr * 10, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-11-20T09:40:00Z", updated_at: failedAt }]);
  }
  const at = (t, r) => ({ ...base, t, ...r });
  const dir = writeLog([
    at("2026-11-20T09:50:15.145Z", { type: "subscribe", repo, pr: 6848, source: "hook" }),
    at("2026-11-20T09:50:15.145Z", { type: "subscribe", repo, pr: 6849, source: "hook" }),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "2026-11-20T09:00:00Z", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.map((m) => `${m.kind}#${m.pr}`), ["ci.workflow_failed#6849"], r.stderr);
});

// #6833 merged at 10:44:23Z; the watching session's own tool unsubscribed at 10:45:33Z, 70 s later. Its CI had finished,
// so the PR was looked at every FINISHED_MS..FINISHED_MAX_MS (cadence.ts), not every poll.
test("with --github, a merge the watch ended within FINISHED_MAX_MS of is overtaken; one watched longer is a MISS", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const repo = "acme/widgets";
  const merged = "2026-11-20T10:44:23Z";
  for (const pr of [6833, 6834]) gh.setPull(repo, pr, { head: { sha: String(pr % 10).repeat(40), ref: `f${pr}` }, state: "closed", merged: true, merged_at: merged, closed_at: merged });
  const at = (t, r) => ({ ...base, t, ...r });
  const dir = writeLog([
    at("2026-11-20T10:00:00.000Z", { type: "subscribe", repo, pr: 6833, source: "tool" }),
    at("2026-11-20T10:00:00.000Z", { type: "subscribe", repo, pr: 6834, source: "tool" }),
    at("2026-11-20T10:45:33.000Z", { type: "unsubscribe", repo, pr: 6833, source: "tool", reason: "tool" }),
    // The control: watched 301 s after the merge, longer than any finished PR goes between looks.
    at("2026-11-20T10:49:24.000Z", { type: "unsubscribe", repo, pr: 6834, source: "tool", reason: "tool" }),
    beat(1),
  ]);
  const r = await run(["--dir", dir, "--since", "2026-11-20T09:00:00Z", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.github.misses.map((m) => `${m.kind}#${m.pr}`), ["pr.merged#6834"], r.stderr);
  assert.equal(out.github.overtaken, 1, "#6833's merge, 70 s before the watch ended");
});

// main went green at 09:42:42Z (a re-run's second attempt passed) and red again at 09:44:55Z (web · CI failed): green
// for 133 s. The one watching session had no CI running, so it read the base every baseIdleMs (poller.ts), and two
// reads saw red and red. A base change undone before the session's next possible read is overtaken: baseEveryMs after
// it when the session logged a CI record dated inside the flip, baseIdleMs otherwise.
test("with --github, a base flip undone before the session's next base read is overtaken and listed; a longer one is a MISS", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const repo = "acme/widgets";
  const red0 = { id: 1, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-11-20T08:40:00Z", updated_at: "2026-11-20T08:50:00Z" };
  const flip = (id, green, red) => [
    red0,
    { id: id, name: "CI", status: "completed", conclusion: "success", run_attempt: 2, created_at: "2026-11-20T08:55:00Z", updated_at: green },
    { id: id + 1, name: "web · CI", status: "completed", conclusion: "failure", created_at: "2026-11-20T08:45:00Z", updated_at: red },
  ];
  // The flip the check reported: 133 s, nothing running. Overtaken.
  gh.setBaseRuns(repo, "main", flip(10, "2026-11-20T09:42:42Z", "2026-11-20T09:44:55Z"));
  // Controls: 601 s with nothing running, and 90 s with a CI record inside. Both MISSes, each half.
  gh.setBaseRuns(repo, "long", flip(20, "2026-11-20T10:00:00Z", "2026-11-20T10:10:01Z"));
  gh.setBaseRuns(repo, "busy", flip(30, "2026-11-20T10:20:00Z", "2026-11-20T10:21:30Z"));
  // 40 s with a CI record inside: within baseEveryMs, overtaken.
  gh.setBaseRuns(repo, "quick", flip(40, "2026-11-20T10:30:00Z", "2026-11-20T10:30:40Z"));
  const prs = { 7001: "main", 7002: "long", 7003: "busy", 7004: "quick" };
  for (const [pr, ref] of Object.entries(prs)) {
    const sha = String(pr % 10).repeat(40);
    gh.setPull(repo, Number(pr), { head: { sha, ref: `f${pr}` }, base: { ref } });
    gh.setCommits(repo, Number(pr), [sha]);
  }
  const at = (t, r) => ({ ...base, t, ...r });
  const ci = (t, github_at) => at(t, { type: "event", kind: "ci.workflow_succeeded", repo, pr: 7003, run_id: 99, outcome: "filtered", github_at });
  const dir = writeLog([
    ...Object.keys(prs).map((pr) => at("2026-11-20T09:00:00.000Z", { type: "subscribe", repo, pr: Number(pr), source: "tool" })),
    ci("2026-11-20T10:20:40.000Z", "2026-11-20T10:20:30Z"),
    ci("2026-11-20T10:30:20.000Z", "2026-11-20T10:30:10Z"),
    beat(1, { subscriptions: 4 }),
  ]);
  const r = await run(["--dir", dir, "--since", "2026-11-20T08:00:00Z", "--json", "--github", "--github-api", gh.base]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.github.misses.map((m) => `${m.kind}@${m.github_at}`).sort(),
    ["base.green@2026-11-20T10:00:00Z", "base.green@2026-11-20T10:20:00Z", "base.red@2026-11-20T10:10:01Z", "base.red@2026-11-20T10:21:30Z"],
    r.stderr,
  );
  assert.equal(out.github.overtaken, 4, "both halves of the main and quick flips");
  assert.deepEqual(
    out.github.overtaken_base_flips.map((f) => `${f.base} ${f.kind} ${f.at} undone ${f.undone_at} (${f.seconds} s, next read ${f.next_read_s} s)`),
    [
      "main base.green 2026-11-20T09:42:42Z undone 2026-11-20T09:44:55Z (133 s, next read 600 s)",
      "quick base.green 2026-11-20T10:30:00Z undone 2026-11-20T10:30:40Z (40 s, next read 60 s)",
    ],
  );
  const text = await run(["--dir", dir, "--since", "2026-11-20T08:00:00Z", "--github", "--github-api", gh.base]);
  assert.match(text.stdout, /base flips overtaken: 2/);
  assert.match(text.stdout, /acme\/widgets@main base\.green 2026-11-20T09:42:42Z, undone 2026-11-20T09:44:55Z \(133 s; next base read 600 s\)/);
});
