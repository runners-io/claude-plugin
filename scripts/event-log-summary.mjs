#!/usr/bin/env node
// Summarise the channel's event log (RUNNERS_IO_EVENT_LOG_DIR, channel/src/eventlog.ts) in one command.
//
//   node scripts/event-log-summary.mjs --dir <dir> [--since 24h|<ISO time>] [--github] [--json]
//
// It prints, for the window:
//   - the channel processes (sessions) that wrote, and when each last spoke;
//   - events per kind, as sent / filtered (the subscription did not want it) / error;
//   - latency per kind, from GitHub's own time to the push: median and worst;
//   - API errors, setup problems, and the requests made (200s cost rate limit, 304s do not), per session per hour;
//   - gaps: a live process silent for more than --gap-minutes (default 12; it writes a heartbeat every 5).
// With --github it also asks GitHub, with the same gh login, what happened on every pull request the log
// says was watched, and lists as a MISS each failed workflow run and each close or merge that GitHub shows
// inside a watched window but that no session was sent. A run that failed on a commit the PR had already
// moved past is counted as superseded, not missed: the channel reports the head commit only. Merge
// conflicts are not checked this way, because GitHub keeps no history of mergeability.
//
// Exit 0: nothing found. Exit 1: a miss, a gap, an event that could not be sent, or a setup problem.
// Exit 2: could not evaluate (no records in the window, or GitHub could not be read); never an all-clear.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { baseVerdict } from "../channel/src/rules.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const dir = opt("--dir", process.env.RUNNERS_IO_EVENT_LOG_DIR);
const sinceArg = opt("--since", "24h");
const gapMinutes = Number(opt("--gap-minutes", "12"));
const asJson = flag("--json");
const githubApi = opt("--github-api", "https://api.github.com").replace(/\/+$/, "");

function couldNotEvaluate(why) {
  process.stderr.write(`could not evaluate: ${why}\n`);
  process.stdout.write(`could not evaluate: ${why}\n`);
  process.exit(2);
}

if (!dir) couldNotEvaluate("pass --dir, or set RUNNERS_IO_EVENT_LOG_DIR");
const rel = /^(\d+)([hd])$/.exec(sinceArg);
const since = rel ? Date.now() - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000) : Date.parse(sinceArg);
if (!Number.isFinite(since)) couldNotEvaluate(`--since ${sinceArg} is neither like 24h nor a time`);

// ---- read
let files = [];
try {
  files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= new Date(since).toISOString().slice(0, 10));
} catch (error) {
  couldNotEvaluate(`${dir} cannot be read: ${error.message}`);
}
const records = [];
let unreadable = 0;
for (const f of files.sort()) {
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Date.parse(r.t) >= since) records.push(r);
    } catch {
      unreadable++;
    }
  }
}
records.sort((a, b) => a.t.localeCompare(b.t));
if (!records.length) couldNotEvaluate(`no records in ${dir} since ${new Date(since).toISOString()}`);

// ---- sessions, gaps, API use
const sessions = new Map();
for (const r of records) {
  const s = sessions.get(r.session) ?? { session: r.session, project: r.project, first: r.t, last: r.t, stopped: false, records: [] };
  s.last = r.t;
  if (r.type === "stop") s.stopped = true;
  if (r.type === "start") s.stopped = false;
  s.records.push(r);
  sessions.set(r.session, s);
}
const gaps = [];
let minRate = null;
const requests = {};
const perHour = {};
for (const s of sessions.values()) {
  let prev = null;
  for (const r of s.records) {
    if (prev && prev.type !== "stop") {
      const minutes = (Date.parse(r.t) - Date.parse(prev.t)) / 60_000;
      if (minutes > gapMinutes) gaps.push({ session: s.session, project: s.project, from: prev.t, to: r.t, minutes: Math.round(minutes * 10) / 10 });
    }
    prev = r;
    if (r.type === "heartbeat") {
      if (typeof r.rate_remaining === "number") minRate = minRate === null ? r.rate_remaining : Math.min(minRate, r.rate_remaining);
      if (r.requests) requests[s.session] = r.requests;
    }
  }
  const rate = requestsPerHour(s.records.filter((r) => r.type === "heartbeat" && r.requests));
  if (rate) perHour[s.session] = rate;
}

/**
 * What one session asked GitHub per hour, from the running totals its heartbeats carry. The totals are the
 * process's own, so a channel restarted inside the session starts again from zero: a total lower than the one
 * before it is counted from zero, not as a negative. Answers read from the shared store are not requests.
 */
function requestsPerHour(beats) {
  if (beats.length < 2) return null;
  const total = (q) => (q.ok ?? 0) + (q.not_modified ?? 0) + (q.other ?? 0);
  let requests = 0;
  let counted = 0;
  for (let i = 1; i < beats.length; i++) {
    const a = beats[i - 1].requests;
    const b = beats[i].requests;
    const reset = total(b) < total(a) || (b.ok ?? 0) < (a.ok ?? 0);
    requests += reset ? total(b) : total(b) - total(a);
    counted += reset ? (b.ok ?? 0) : (b.ok ?? 0) - (a.ok ?? 0);
  }
  const hours = (Date.parse(beats.at(-1).t) - Date.parse(beats[0].t)) / 3_600_000;
  if (hours <= 0) return null;
  return { requests, counted, hours: Math.round(hours * 100) / 100, per_hour: Math.round((requests / hours) * 10) / 10 };
}

// ---- events, latency, errors
const events = {};
const latencies = {};
const errors = {};
const problems = {};
const sendErrors = [];
for (const r of records) {
  if (r.type === "event") {
    const e = (events[r.kind] ??= { sent: 0, filtered: 0, error: 0 });
    e[r.outcome] = (e[r.outcome] ?? 0) + 1;
    if (r.outcome === "error") sendErrors.push({ t: r.t, kind: r.kind, repo: r.repo, pr: r.pr, error: r.error });
    if (r.outcome === "sent" && typeof r.latency_ms === "number") (latencies[r.kind] ??= []).push(r);
  } else if (r.type === "api_error") {
    const key = r.result === "retry" ? `retry: ${r.reason}` : r.result;
    errors[key] = (errors[key] ?? 0) + 1;
  } else if (r.type === "problem") {
    problems[r.kind] = (problems[r.kind] ?? 0) + 1;
  }
}
const latency = {};
for (const [kind, list] of Object.entries(latencies)) {
  const sorted = [...list].sort((a, b) => a.latency_ms - b.latency_ms);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid].latency_ms : Math.round((sorted[mid - 1].latency_ms + sorted[mid].latency_ms) / 2);
  const w = sorted.at(-1);
  latency[kind] = { count: sorted.length, median_ms: median, worst_ms: w.latency_ms, worst: { t: w.t, repo: w.repo, pr: w.pr, run_id: w.run_id ?? null } };
}

// ---- GitHub cross-check
let github = null;
if (flag("--github")) github = await checkGitHub();

// ---- sessions launched without the channel flag (the channel logs channel_inactive and does not poll)
const inactive = records.filter((r) => r.type === "channel_inactive");
const channelInactive = { sessions: new Set(inactive.map((r) => r.session)).size, projects: [...new Set(inactive.map((r) => r.project))].sort() };

const summary = {
  window: { since: new Date(since).toISOString(), until: new Date().toISOString(), records: records.length, unreadable_lines: unreadable },
  sessions: [...sessions.values()].map(({ records: _, ...s }) => s),
  events,
  latency,
  channel_inactive: channelInactive,
  errors,
  problems,
  send_errors: sendErrors,
  gaps,
  api: { min_rate_remaining: minRate, requests_by_session: requests, requests_per_hour: perHour },
  github,
};
const findings = gaps.length + sendErrors.length + Object.keys(problems).length + (github?.misses.length ?? 0);

if (asJson) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
else process.stdout.write(text(summary));
process.exit(findings ? 1 : 0);

// ---------------------------------------------------------------------------

function token() {
  if (process.env.GH_TOKEN?.trim()) return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try {
    return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

async function gh(path, auth) {
  const res = await fetch(`${githubApi}${path}`, {
    headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "user-agent": "runners-io-event-log-summary" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function checkGitHub() {
  const auth = token();
  if (!auth) couldNotEvaluate("--github needs a GitHub login (gh auth login, or GH_TOKEN)");
  // When each PR was watched: from each subscribe to its unsubscribe (or now), across all sessions.
  const windows = new Map();
  const open = new Map();
  for (const r of records) {
    if (!r.repo || !r.pr) continue;
    const key = `${r.repo}#${r.pr}`;
    const sk = `${r.session}|${key}`;
    if (r.type === "subscribe" && !open.has(sk)) open.set(sk, r.t);
    if (r.type === "unsubscribe" && open.has(sk)) {
      (windows.get(key) ?? windows.set(key, []).get(key)).push([open.get(sk), r.t]);
      open.delete(sk);
    }
  }
  const lastBySession = new Map([...sessions.values()].map((s) => [s.session, s.stopped ? s.last : new Date().toISOString()]));
  for (const [sk, from] of open) {
    const [session, key] = sk.split("|");
    (windows.get(key) ?? windows.set(key, []).get(key)).push([from, lastBySession.get(session)]);
  }
  const inside = (key, t) => (windows.get(key) ?? []).some(([a, b]) => t >= a && t <= b);
  const sent = new Set(records.filter((r) => r.type === "event" && r.outcome === "sent").map((r) => `${r.repo}#${r.pr}|${r.kind}|${r.run_id ?? ""}`));
  const sentKinds = new Set(records.filter((r) => r.type === "event" && r.outcome === "sent").map((r) => `${r.repo}#${r.pr}|${r.kind}`));

  const misses = [];
  let superseded = 0;
  try {
    for (const key of windows.keys()) {
      const [repo, pr] = key.split("#");
      const pull = await gh(`/repos/${repo}/pulls/${pr}`, auth);
      const closedAt = pull.merged_at ?? pull.closed_at;
      const closeKind = pull.merged_at ? "pr.merged" : "pr.closed";
      if (closedAt && inside(key, closedAt) && !sentKinds.has(`${key}|${closeKind}`)) {
        misses.push({ kind: closeKind, repo, pr: Number(pr), github_at: closedAt });
      }
      const commits = await gh(`/repos/${repo}/pulls/${pr}/commits?per_page=100`, auth);
      const shas = [...new Set([...commits.map((c) => c.sha), pull.head?.sha].filter(Boolean))];
      const runsBySha = new Map();
      for (const sha of shas) {
        const r = await gh(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, auth);
        runsBySha.set(sha, r.workflow_runs ?? []);
      }
      // A commit's push time is its first run's creation; the head at time T is the latest commit pushed by T.
      const pushed = shas
        .map((sha) => ({ sha, at: (runsBySha.get(sha) ?? []).map((r) => r.created_at).filter(Boolean).sort()[0] }))
        .filter((p) => p.at)
        .sort((a, b) => a.at.localeCompare(b.at));
      const headAt = (t) => pushed.filter((p) => p.at <= t).at(-1)?.sha;
      for (const [sha, runs] of runsBySha) {
        for (const run of runs) {
          if (run.status !== "completed" || !["failure", "timed_out", "startup_failure"].includes(run.conclusion)) continue;
          if (!run.updated_at || !inside(key, run.updated_at)) continue;
          if (headAt(run.updated_at) !== sha) {
            superseded++;
            continue;
          }
          if (!sent.has(`${key}|ci.workflow_failed|${run.id}`)) {
            misses.push({ kind: "ci.workflow_failed", repo, pr: Number(pr), run_id: run.id, workflow: run.name, github_at: run.updated_at });
          }
        }
      }

      // Each other kind, against the history GitHub (or a local log) keeps.
      const accounted = (kind, at, also = () => true) =>
        records.some(
          (r) =>
            r.type === "event" &&
            (r.outcome === "sent" || r.outcome === "filtered") &&
            `${r.repo}#${r.pr}` === key &&
            r.kind === kind &&
            Date.parse(r.t) >= Date.parse(at) - 5_000 &&
            also(r),
        );
      const expect = (kind, at, extra = {}, also) => {
        if (inside(key, at) && !accounted(kind, at, also)) misses.push({ kind, repo, pr: Number(pr), github_at: at, ...extra });
      };

      // Labels and draft: GitHub's issue events (the first 100).
      const ISSUE_KINDS = { labeled: "pr.labels_changed", unlabeled: "pr.labels_changed", ready_for_review: "pr.ready_for_review", convert_to_draft: "pr.converted_to_draft" };
      for (const ev of await gh(`/repos/${repo}/issues/${pr}/events?per_page=100`, auth)) {
        const kind = ISSUE_KINDS[ev.event];
        if (kind && ev.created_at) expect(kind, ev.created_at);
      }

      // Flaky: a re-run on the head commit that passed after its previous attempt failed.
      for (const [sha, runs] of runsBySha) {
        for (const run of runs) {
          if (run.status !== "completed" || !["success", "neutral"].includes(run.conclusion) || !(run.run_attempt > 1)) continue;
          if (!run.updated_at || !inside(key, run.updated_at) || headAt(run.updated_at) !== sha) continue;
          const before = await gh(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt - 1}`, auth);
          if (!["failure", "timed_out", "startup_failure"].includes(before.conclusion)) continue;
          expect("ci.flaky", run.updated_at, { run_id: run.id, workflow: run.name }, (r) => r.run_id === run.id);
        }
      }

      // The base branch: replay its push runs in the order they finished; each red <-> green is an event.
      const baseRef = pull.base?.ref;
      if (baseRef && !closedAt) {
        const q = new URLSearchParams({ branch: baseRef, event: "push", per_page: "100" });
        const baseRuns = (await gh(`/repos/${repo}/actions/runs?${q}`, auth)).workflow_runs ?? [];
        const done = baseRuns.filter((r) => r.status === "completed" && r.updated_at).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        const starts = (windows.get(key) ?? []).map(([a]) => a).sort();
        let red = baseVerdict(done.filter((r) => r.updated_at <= starts[0])).red;
        for (const r of done) {
          if (r.updated_at <= starts[0]) continue;
          const v = baseVerdict(done.filter((x) => x.updated_at <= r.updated_at));
          if (v.red === red) continue;
          red = v.red;
          expect(red ? "base.red" : "base.green", r.updated_at);
        }
      }

    }
  } catch (error) {
    couldNotEvaluate(`GitHub could not be read: ${error.message}`);
  }
  return {
    checked_prs: windows.size,
    misses,
    superseded,
    not_checked:
      "merge conflicts (GitHub keeps no history of them), pr.head_moved (whether this machine had the commit) and pr.body_edited (REST keeps no edit history)",
  };
}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function text(s) {
  const out = [];
  out.push(`runners.io channel event log, ${s.window.since} to ${s.window.until}: ${s.window.records} records`);
  out.push(`sessions: ${s.sessions.length}`);
  for (const x of s.sessions) out.push(`  ${x.session}  ${x.project}  ${x.first} .. ${x.last}${x.stopped ? " (stopped)" : ""}`);
  out.push("events:");
  for (const [kind, e] of Object.entries(s.events).sort()) {
    const l = s.latency[kind];
    out.push(`  ${kind.padEnd(24)} sent ${e.sent}, filtered ${e.filtered}, error ${e.error}${l ? `; median ${secs(l.median_ms)}, worst ${secs(l.worst_ms)}` : ""}`);
  }
  out.push(`API: lowest rate limit left ${s.api.min_rate_remaining ?? "unknown"}`);
  for (const [session, r] of Object.entries(s.api.requests_by_session)) out.push(`  ${session}: ${r.ok} counted, ${r.not_modified} free (304), ${r.other} other`);
  out.push("GitHub requests per hour, per session (a quiet PR should stay under 30, a busy one under 150):");
  for (const [session, r] of Object.entries(s.api.requests_per_hour)) {
    out.push(`  ${session}: ${r.per_hour} requests/hour (${r.requests} in ${r.hours} h; ${r.counted} counted against the rate limit)${r.per_hour > 150 ? "  OVER 150" : ""}`);
  }
  out.push(`API errors: ${Object.keys(s.errors).length ? Object.entries(s.errors).map(([k, v]) => `${k} x${v}`).join("; ") : "none"}`);
  out.push(`setup problems: ${Object.keys(s.problems).length ? Object.entries(s.problems).map(([k, v]) => `${k} x${v}`).join("; ") : "none"}`);
  out.push(`events that could not be sent: ${s.send_errors.length}`);
  out.push(`sessions started without the channel flag (channel_inactive): ${s.channel_inactive.sessions}`);
  out.push(`gaps over ${gapMinutes} min: ${s.gaps.length}`);
  for (const g of s.gaps) out.push(`  ${g.session} ${g.project}: ${g.from} .. ${g.to} (${g.minutes} min)`);
  if (s.github) {
    out.push(`GitHub check: ${s.github.checked_prs} PR(s), ${s.github.misses.length} miss(es), ${s.github.superseded} superseded failure(s) rightly not sent; not checked: ${s.github.not_checked}`);
    for (const m of s.github.misses) {
      out.push(`  MISS ${m.kind} ${m.repo}#${m.pr}${m.run_id ? ` run ${m.run_id} "${m.workflow}"` : ""}${m.state ? ` ${m.state}` : ""} at ${m.github_at}`);
    }
  }
  return `${out.join("\n")}\n`;
}
