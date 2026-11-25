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
// A change the channel could not have seen is counted as overtaken, not missed. The channel reports what changed
// between two looks at a PR (state.ts diff), and once it sees a merge it reports only that. So a change is overtaken
// when the watch ended within one poll of it; and a label change is overtaken when it is part of an even run of
// changes to the same label, each undoing the last (an odd run still owes its last change), or the PR merged or closed, within FINISHED_MAX_MS (rules.mjs: the longest a finished PR goes between
// looks), with no event logged for the PR by a session watching it in between (which would show a look happened).
// Seen live: one day's event log had 10 false MISSes of that kind, `hold` added and taken off 14-24 s apart on four
// PRs, and taken off 79 and 111 s before a merge on two more, when only a watch that ended within a minute counted.
// Also overtaken: a merge or close that the watch ended less than FINISHED_MAX_MS after (a PR whose CI has finished is
// not looked at every poll); and a base branch's turn undone before the session's next possible read of the base
// (rules.mjs: BASE_EVERY_MS while the session logged a CI record dated inside the turn, BASE_IDLE_MS otherwise),
// each such pair listed. A change GitHub dates (whole seconds) at or before the second a watch began was in its first
// look, which is a baseline (state.ts: diff(null, s) is empty). Every window test compares times, not strings:
// "09:50:15Z" sorts after "09:50:15.145Z", because "Z" sorts after ".", and that made a baseline change a MISS.
//
// Exit 0: nothing found. Exit 1: a miss, a gap, an event that could not be sent, or a setup problem.
// Exit 2: could not evaluate (no records in the window, or GitHub could not be read); never an all-clear.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { BASE_EVERY_MS, BASE_IDLE_MS, FINISHED_MAX_MS, baseVerdict } from "../channel/src/rules.mjs";

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
// The check shares its GitHub login with every session and tool on it: below this many requests left it stops, as
// "could not evaluate", rather than spend the rest.
const githubFloor = Number(opt("--github-floor", "1500"));
let githubRequests = 0;

// A record's text (a session, a project, an event kind, an error's reason, a workflow name) is printed to a
// terminal. Whoever names a workflow or a branch chooses those characters, and an ESC or C1 sequence printed raw
// can clear the screen, rewrite earlier lines or set the window title. So every printed line goes through
// printable(), and the JSON form escapes what JSON.stringify leaves raw.
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*[\u0007\u009c]?/g;
// C0 (but the newline), DEL, C1, the line and paragraph separators, and the bidirectional overrides that reorder
// what a terminal shows.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

function printable(text) {
  return String(text).replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "");
}

/** JSON.stringify escapes C0 but not DEL, C1, the separators or the bidirectional overrides; those sit only inside strings. */
function printableJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A time, from GitHub (whole seconds) or a log record (milliseconds): never compare the two as strings. */
const ms = (t) => Date.parse(t);
/**
 * Whether a change at `t` came after the first look of a watch that began at `from`. GitHub dates in whole seconds, so
 * a change it dates at or before the second the watch began may have been in that look, the baseline.
 */
const afterStart = (t, from) => ms(t) >= Math.floor(ms(from) / 1000) * 1000 + 1000;
/** Inside a watch from `from` to `to`, by time. */
const within = (t, from, to) => afterStart(t, from) && ms(t) <= ms(to);

function couldNotEvaluate(why) {
  process.stderr.write(`could not evaluate: ${printable(why)}\n`);
  process.stdout.write(`could not evaluate: ${printable(why)}\n`);
  process.exit(2);
}

if (!dir) couldNotEvaluate("pass --dir, or set RUNNERS_IO_EVENT_LOG_DIR");
// The github.com login goes to api.github.com only. This machine is accepted under RUNNERS_IO_TEST_FAKE_GITHUB=1,
// for the tests' fake GitHub; any other address, a local port included, would be handed the user's token.
if (githubApi !== "https://api.github.com") {
  let host = "";
  try {
    const u = new URL(githubApi);
    host = u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
  } catch {}
  const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
  if (!(local && process.env.RUNNERS_IO_TEST_FAKE_GITHUB === "1"))
    couldNotEvaluate(`--github-api accepts only https://api.github.com, so your github.com login goes nowhere else: ${githubApi}`);
}
const rel = /^(\d+)([hd])$/.exec(sinceArg);
const since = rel ? Date.now() - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000) : Date.parse(sinceArg);
if (!Number.isFinite(since)) couldNotEvaluate(`--since ${sinceArg} is neither like 24h nor a time`);

// ---- read
let files = [];
try {
  // Every day's file: the window's records come from those on or after its first day, and a subscription made before
  // the window (its choice of events) from any of them.
  // The channel writes into a subfolder of its own (channel/src/eventlog.ts EVENT_LOG_SUBDIR); a log written before it
  // did lies directly in the directory. Both are read.
  const days = (d) => readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => join(d, f));
  const own = join(dir, "runners-io-events");
  files = [...days(dir), ...(existsSync(own) ? days(own) : [])];
} catch (error) {
  couldNotEvaluate(`${dir} cannot be read: ${error.message}`);
}
const records = [];
// Subscribe and unsubscribe records from before the window, oldest first: what each watch the window inherits chose.
const before = [];
let unreadable = 0;
const firstDay = new Date(since).toISOString().slice(0, 10);
for (const f of files.sort((a, b) => basename(a).localeCompare(basename(b)))) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Date.parse(r.t) >= since) records.push(r);
      else if (r.type === "subscribe" || r.type === "unsubscribe") before.push(r);
    } catch {
      if (basename(f).slice(0, 10) >= firstDay) unreadable++;
    }
  }
}
before.sort((a, b) => a.t.localeCompare(b.t));
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
// A session that wrote nothing for longer than a heartbeat interval (5 min, plus slack) and has no stop record has
// ENDED: killed or crashed. It watched until its last record, not until now -- counting it as watching for
// ever turned every later event on its PRs into a false MISS. It is listed, so a crash is seen; it is not a finding
// on its own, because a session ended with a signal (a harness, a closed terminal) looks the same.
const ENDED_AFTER_MS = 6 * 60_000;
const endedWithoutStop = [...sessions.values()]
  .filter((s) => !s.stopped && Date.now() - Date.parse(s.last) > ENDED_AFTER_MS)
  .map((s) => ({ session: s.session, project: s.project, last: s.last }));
const ended = new Set(endedWithoutStop.map((e) => e.session));

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
  ended_without_stop: endedWithoutStop,
  api: { min_rate_remaining: minRate, requests_by_session: requests, requests_per_hour: perHour },
  github,
};
const findings = gaps.length + sendErrors.length + Object.keys(problems).length + (github?.misses.length ?? 0);

if (asJson) process.stdout.write(`${printableJson(summary)}\n`);
else process.stdout.write(text(summary));
process.exit(findings ? 1 : 0);

// ---------------------------------------------------------------------------

function token() {
  // This machine is a GitHub only for the tests (the check above), and gets only the tests' own token: the switch is
  // an environment variable, so the user's real login must never follow it to a local port.
  if (githubApi !== "https://api.github.com") return process.env.RUNNERS_IO_TEST_GITHUB_TOKEN?.trim() ?? "";
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
  githubRequests++;
  const left = Number(res.headers.get("x-ratelimit-remaining"));
  if (res.headers.has("x-ratelimit-remaining") && Number.isFinite(left) && left < githubFloor) {
    couldNotEvaluate(`GitHub has ${left} requests left for this login, below the floor of ${githubFloor} (--github-floor): stopped after ${githubRequests} request(s), so the rest is left for everything else that shares it`);
  }
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function checkGitHub() {
  const auth = token();
  if (!auth) couldNotEvaluate("--github needs a GitHub login (gh auth login, or GH_TOKEN)");
  // When each PR was watched: from each subscribe to its unsubscribe (or now), across all sessions.
  const windows = new Map();
  const open = new Map();
  // A subscription older than the window has no subscribe record in it, and once opened no window, so the
  // check covered nothing and said "0 misses". A heartbeat's `watching` list names what its session watched; a PR it
  // names with no window open was subscribed before the window, and counts from the window's start. An unsubscribe
  // with nothing open closes such a window.
  const windowStart = new Date(since).toISOString();
  // A window is [from, to, events]: `events` is what the subscription asked for ("all", or a list of kinds). A kind it
  // excluded is not expected (one check counted 17 of them as MISSes).
  // The fourth element is the session that watched.
  const close = (key, from, to, events = "all", session = null) => (windows.get(key) ?? windows.set(key, []).get(key)).push([from, to, events, session]);
  const closed = new Set();
  // What each session's subscriptions chose, as of the window's start: a watch the window inherits (opened below by a
  // heartbeat's watching list, which names the PR but not the choice) keeps it.
  const chosen = new Map();
  for (const r of before) {
    if (r.type === "unsubscribe" && !r.repo) {
      for (const sk of [...chosen.keys()]) if (sk.startsWith(`${r.session}|`)) chosen.delete(sk);
    } else if (r.repo && r.pr) {
      const sk = `${r.session}|${r.repo}#${r.pr}`;
      if (r.type === "subscribe") chosen.set(sk, Array.isArray(r.events) ? r.events : "all");
      else chosen.delete(sk);
    }
  }
  let saidWatching = false;
  for (const r of records) {
    if (r.type === "heartbeat") {
      if (Number(r.subscriptions) > 0) saidWatching = true;
      for (const key of Array.isArray(r.watching) ? r.watching : []) {
        const sk = `${r.session}|${key}`;
        if (!open.has(sk) && !closed.has(sk)) open.set(sk, { from: windowStart, events: chosen.get(sk) ?? "all" });
      }
      continue;
    }
    if (r.type === "unsubscribe" && !r.repo) {
      // Unsubscribe-all names no PR: it closes every window its session has open.
      for (const [sk, w] of [...open]) {
        if (!sk.startsWith(`${r.session}|`)) continue;
        close(sk.slice(sk.indexOf("|") + 1), w.from, r.t, w.events, r.session);
        open.delete(sk);
        closed.add(sk);
      }
      continue;
    }
    if (!r.repo || !r.pr) continue;
    const key = `${r.repo}#${r.pr}`;
    const sk = `${r.session}|${key}`;
    if (r.type === "subscribe") {
      const events = Array.isArray(r.events) ? r.events : "all";
      const w = open.get(sk);
      if (w && JSON.stringify(w.events) !== JSON.stringify(events)) close(key, w.from, r.t, w.events, r.session); // a new choice from now on
      if (!w || JSON.stringify(w.events) !== JSON.stringify(events)) open.set(sk, { from: r.t, events });
    }
    if (r.type === "unsubscribe") {
      const w = open.get(sk);
      close(key, w?.from ?? (closed.has(sk) ? r.t : windowStart), r.t, w?.events ?? "all", r.session);
      open.delete(sk);
      closed.add(sk);
    }
  }
  const lastBySession = new Map([...sessions.values()].map((s) => [s.session, s.stopped || ended.has(s.session) ? s.last : new Date().toISOString()]));
  for (const [sk, w] of open) {
    const [session, key] = sk.split("|");
    close(key, w.from, lastBySession.get(session), w.events, session);
  }
  if (saidWatching && windows.size === 0) {
    // An older build's heartbeat carries how many PRs it watched but not which: "0 misses" here would be a check of
    // nothing, so it is not an all-clear.
    couldNotEvaluate("heartbeats say a PR was watched, but no subscribe record or watching list in the window names it");
  }
  // Whether a change at time t of this kind was the channel's to report. A window that wanted it and stayed open at
  // least one poll after t: "in". One that wanted it but closed (or reached now) within one poll of t: "overtaken",
  // as when a session stops watching seconds after a merge, before its next look. Otherwise "out".
  // A merge or close is the channel's only if the window stayed open FINISHED_MAX_MS after it: by then a PR's CI has
  // usually finished, and a finished PR is looked at every FINISHED_MS..FINISHED_MAX_MS (cadence.ts), not every poll.
  // Seen live: #6833 merged at 10:44:23Z, and its session's own tool unsubscribed 70 s later.
  const POLL_MS = 60_000;
  // What each session had muted, and when. A mute names a PR or (repo null) every PR, and kinds or (null)
  // every kind; one that names a workflow mutes that workflow only, which a kind-level check cannot tell apart, so it
  // is left out (the change stays expected). An unmute ends the mute it repeats, or every mute (all: true).
  const mutes = [];
  for (const r of [...before, ...records]) {
    if (r.type === "mute" && !r.workflow) {
      mutes.push({ session: r.session, key: r.repo && r.pr ? `${r.repo}#${r.pr}` : null, kinds: Array.isArray(r.kinds) ? r.kinds : null, from: r.t, to: null });
    } else if (r.type === "unmute") {
      const key = r.repo && r.pr ? `${r.repo}#${r.pr}` : null;
      const kinds = JSON.stringify(Array.isArray(r.kinds) ? [...r.kinds].sort() : null);
      for (const m of mutes) {
        if (m.session !== r.session || m.to) continue;
        if (r.all || (m.key === key && JSON.stringify(m.kinds ? [...m.kinds].sort() : null) === kinds)) m.to = r.t;
      }
    }
  }
  const muted = (session, key, kind, t) =>
    mutes.some((m) => m.session === session && (m.key === null || m.key === key) && (m.kinds === null || m.kinds.includes(kind)) && ms(t) >= ms(m.from) && (!m.to || ms(t) < ms(m.to)));
  // When GitHub merged or closed the PR. The channel reports only pr.merged (or pr.closed) once a poll sees
  // it, so any other change is the channel's only if a poll could see it while the PR was still open: for those
  // kinds the window ends at GitHub's time, not at the unsubscribe the session logged when it noticed (a minute or
  // two later, which made a label taken off 11 s before an auto-merge look like a MISS).
  const prEnds = new Map();
  const where = (key, t, kind) => {
    const closing = kind === "pr.merged" || kind === "pr.closed";
    const end = closing ? null : prEnds.get(key);
    const reach = closing ? FINISHED_MAX_MS : POLL_MS;
    const wanting = (windows.get(key) ?? [])
      .filter(([a, b, ev, session]) => within(t, a, b) && (ev === "all" || ev.includes(kind)) && !muted(session, key, kind, t))
      .map(([a, b, ev, session]) => [a, end && ms(end) < ms(b) ? end : b, ev, session]);
    if (wanting.some(([, b]) => ms(b) - ms(t) >= reach)) return "in";
    return wanting.length ? "overtaken" : "out";
  };
  const inside = (key, t, kind) => where(key, t, kind) !== "out";
  // Sent or filtered: either way the channel saw the change. Filtered means the subscription did not want it told.
  const seen = (r) => r.type === "event" && (r.outcome === "sent" || r.outcome === "filtered");
  const sent = new Set(records.filter(seen).map((r) => `${r.repo}#${r.pr}|${r.kind}|${r.run_id ?? ""}`));
  const sentKinds = new Set(records.filter(seen).map((r) => `${r.repo}#${r.pr}|${r.kind}`));
  let overtaken = 0;
  // Base turns undone before the next read could see them, once each per repository, base and time.
  const overtakenBaseFlips = new Map();

  // A base branch's push runs, back to before the earliest window, a page of 100 at a time: a workflow's last verdict
  // can be older than the newest 100 runs (a failure was once off the page 70 minutes later, and the check saw a
  // green that never was). At most 10 pages, and read ONCE per repository and branch, shared by every PR on it: read
  // per PR, one day's replay of 99 PRs spent the hourly limit of a login every other tool and session share.
  const earliest = [...windows.values()].flat().map(([a]) => a).sort((x, y) => ms(x) - ms(y))[0];
  const baseHistories = new Map();
  const baseHistory = (repo, ref) => {
    const k = `${repo}@${ref}`;
    if (!baseHistories.has(k)) {
      baseHistories.set(
        k,
        (async () => {
          const byId = new Map();
          for (let page = 1; page <= 10; page++) {
            const q = new URLSearchParams({ branch: ref, event: "push", per_page: "100", page: String(page) });
            const got = (await gh(`/repos/${repo}/actions/runs?${q}`, auth)).workflow_runs ?? [];
            for (const r of got) byId.set(r.id, r);
            const oldest = got.map((r) => r.created_at).filter(Boolean).sort()[0];
            if (got.length < 100 || (oldest && ms(oldest) < ms(earliest))) break;
          }
          return [...byId.values()];
        })(),
      );
    }
    return baseHistories.get(k);
  };

  const misses = [];
  let superseded = 0;
  try {
    for (const key of windows.keys()) {
      const [repo, pr] = key.split("#");
      const pull = await gh(`/repos/${repo}/pulls/${pr}`, auth);
      const closedAt = pull.merged_at ?? pull.closed_at;
      const closeKind = pull.merged_at ? "pr.merged" : "pr.closed";
      if (closedAt) prEnds.set(key, closedAt);
      if (closedAt && inside(key, closedAt, closeKind) && !sentKinds.has(`${key}|${closeKind}`)) {
        if (where(key, closedAt, closeKind) === "overtaken") overtaken++;
        else misses.push({ kind: closeKind, repo, pr: Number(pr), github_at: closedAt });
      }
      const commits = await gh(`/repos/${repo}/pulls/${pr}/commits?per_page=100`, auth);
      const shas = [...new Set([...commits.map((c) => c.sha), pull.head?.sha].filter(Boolean))];
      // The runs of the PR's own head branch, in its own head repository, a page of 100 at a time back to before its
      // first window (at most 5), kept for its commits. One read per commit cost thousands of requests for a day of PRs
      // that the merge queue updates, each update a commit.
      const runsBySha = new Map(shas.map((sha) => [sha, []]));
      const headRef = pull.head?.ref;
      const headRepo = (pull.head?.repo?.full_name ?? repo).toLowerCase();
      const firstWatch = (windows.get(key) ?? []).map(([a]) => a).sort((x, y) => ms(x) - ms(y))[0];
      for (let page = 1; headRef && page <= 5; page++) {
        const q = new URLSearchParams({ branch: headRef, per_page: "100", page: String(page) });
        const got = (await gh(`/repos/${repo}/actions/runs?${q}`, auth)).workflow_runs ?? [];
        for (const run of got) {
          if (runsBySha.has(run.head_sha) && (run.head_repository?.full_name ?? repo).toLowerCase() === headRepo) runsBySha.get(run.head_sha).push(run);
        }
        const oldest = got.map((x) => x.created_at).filter(Boolean).sort()[0];
        if (got.length < 100 || (oldest && ms(oldest) < ms(firstWatch))) break;
      }
      // A commit's push time is its first run's creation; the head at time T is the latest commit pushed by T.
      const pushed = shas
        .map((sha) => ({ sha, at: (runsBySha.get(sha) ?? []).map((r) => r.created_at).filter(Boolean).sort()[0] }))
        .filter((p) => p.at)
        .sort((a, b) => ms(a.at) - ms(b.at));
      const headAt = (t) => pushed.filter((p) => ms(p.at) <= ms(t)).at(-1)?.sha;
      for (const [sha, runs] of runsBySha) {
        for (const run of runs) {
          if (run.status !== "completed" || !["failure", "timed_out", "startup_failure"].includes(run.conclusion)) continue;
          if (!run.updated_at || !inside(key, run.updated_at, "ci.workflow_failed")) continue;
          if (headAt(run.updated_at) !== sha) {
            superseded++;
            continue;
          }
          if (!sent.has(`${key}|ci.workflow_failed|${run.id}`)) {
            // A newer commit pushed within one poll of the failure: the channel's next look found the head moved.
            const replaced = pushed.some((p) => ms(p.at) > ms(run.updated_at) && ms(p.at) - ms(run.updated_at) < POLL_MS);
            if (replaced || where(key, run.updated_at, "ci.workflow_failed") === "overtaken") {
              overtaken++;
              continue;
            }
            misses.push({ kind: "ci.workflow_failed", repo, pr: Number(pr), run_id: run.id, workflow: run.name, github_at: run.updated_at });
          }
        }
      }

      // Each other kind, against the history GitHub (or a local log) keeps.
      // `early`: how long before GitHub's (or the log line's) time a record may be. A train line is stamped when the
      // waiter writes it, which can be seconds after the state the channel read (10 s, once).
      const accounted = (kind, at, also = () => true, early = 5_000) =>
        records.some((r) => seen(r) && `${r.repo}#${r.pr}` === key && r.kind === kind && Date.parse(r.t) >= Date.parse(at) - early && also(r));
      const expect = (kind, at, extra = {}, also, early) => {
        const w = where(key, at, kind);
        if (w === "out" || accounted(kind, at, also, early)) return;
        if (w === "overtaken") overtaken++;
        else misses.push({ kind, repo, pr: Number(pr), github_at: at, ...extra });
      };

      // Labels and draft: GitHub's issue events (the first 100).
      const ISSUE_KINDS = { labeled: "pr.labels_changed", unlabeled: "pr.labels_changed", ready_for_review: "pr.ready_for_review", convert_to_draft: "pr.converted_to_draft" };
      const issueEvents = await gh(`/repos/${repo}/issues/${pr}/events?per_page=100`, auth);
      // A look at the PR between two times: an event a session watching it logged for it, sent or filtered.
      const lookedBetween = (a, b) => {
        const [from, to] = [Date.parse(a), Date.parse(b)];
        const watchers = new Set(
          (windows.get(key) ?? []).filter(([wa, wb]) => Date.parse(wa) <= to && Date.parse(wb) >= from).map(([, , , who]) => who),
        );
        return records.some((r) => seen(r) && `${r.repo}#${r.pr}` === key && watchers.has(r.session) && Date.parse(r.t) > from && Date.parse(r.t) < to);
      };
      // One label's changes, oldest first: a change undone before the next look changed nothing the channel could see.
      const labelChanges = issueEvents
        .filter((ev) => (ev.event === "labeled" || ev.event === "unlabeled") && ev.created_at && ev.label?.name)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      // A run of one label's changes, each the opposite of the one before, within FINISHED_MAX_MS of it, with no look
      // between: an even run leaves the label as it was, so none of it was visible; an odd run leaves it changed, so
      // the channel still owes the last change (add, take off, add again went from without the label to with it).
      const cancelled = new Set();
      const byLabel = new Map();
      for (const ev of labelChanges) byLabel.set(ev.label.name, [...(byLabel.get(ev.label.name) ?? []), ev]);
      for (const same of byLabel.values()) {
        let run = [];
        const end = () => {
          for (const ev of run.slice(0, run.length - (run.length % 2))) cancelled.add(ev);
          run = [];
        };
        for (const ev of same) {
          const prev = run.at(-1);
          const continues = prev && prev.event !== ev.event && Date.parse(ev.created_at) - Date.parse(prev.created_at) <= FINISHED_MAX_MS && !lookedBetween(prev.created_at, ev.created_at);
          if (!continues) end();
          run.push(ev);
        }
        end();
      }
      const unseenLabelChange = (ev) => {
        if (cancelled.has(ev)) return true;
        // The merge (or close) came before the next look: the channel reports only that.
        const t = Date.parse(ev.created_at);
        return Boolean(closedAt) && Date.parse(closedAt) >= t && Date.parse(closedAt) - t <= FINISHED_MAX_MS && !lookedBetween(ev.created_at, closedAt);
      };
      for (const ev of issueEvents) {
        const kind = ISSUE_KINDS[ev.event];
        if (!kind || !ev.created_at) continue;
        if (kind === "pr.labels_changed" && unseenLabelChange(ev)) {
          if (where(key, ev.created_at, kind) !== "out" && !accounted(kind, ev.created_at)) overtaken++;
          continue;
        }
        expect(kind, ev.created_at);
      }

      // Reviews: every review that approved or requested changes (REST keeps them all, the first 100).
      const REVIEW_KINDS = { APPROVED: "pr.approved", CHANGES_REQUESTED: "pr.changes_requested" };
      for (const rv of await gh(`/repos/${repo}/pulls/${pr}/reviews?per_page=100`, auth)) {
        const kind = REVIEW_KINDS[rv.state];
        if (kind && rv.submitted_at) expect(kind, rv.submitted_at, { review_id: rv.id }, (r) => String(r.review_url ?? "").endsWith(`#pullrequestreview-${rv.id}`));
      }
      // A new review thread is a review comment that replies to none (the first 100).
      for (const cm of await gh(`/repos/${repo}/pulls/${pr}/comments?per_page=100`, auth)) {
        if (!cm.in_reply_to_id && cm.created_at) {
          expect("pr.review_thread_added", cm.created_at, { comment_id: cm.id }, (r) => String(r.review_url ?? "").endsWith(`#discussion_r${cm.id}`));
        }
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
        const baseRuns = await baseHistory(repo, baseRef);
        const done = baseRuns.filter((r) => r.status === "completed" && r.updated_at).sort((a, b) => ms(a.updated_at) - ms(b.updated_at));
        const starts = (windows.get(key) ?? []).map(([a]) => a).sort((x, y) => ms(x) - ms(y));
        // A run GitHub dates at or before the watch's first second was in the first read, the baseline.
        let red = baseVerdict(done.filter((r) => !afterStart(r.updated_at, starts[0]))).red;
        const turns = [];
        for (const r of done) {
          if (!afterStart(r.updated_at, starts[0])) continue;
          const v = baseVerdict(done.filter((x) => ms(x.updated_at) <= ms(r.updated_at)));
          if (v.red === red) continue;
          red = v.red;
          turns.push({ kind: red ? "base.red" : "base.green", at: r.updated_at });
        }
        // A session reads a base branch once for all its PRs on it, and tells each turn once, on any one of them.
        const watchersAt = (t, kind) =>
          new Set((windows.get(key) ?? []).filter(([a, b, ev]) => within(t, a, b) && (ev === "all" || ev.includes(kind))).map(([, , , who]) => who));
        const told = (kind, at, watchers) =>
          records.some((x) => seen(x) && x.kind === kind && x.repo === repo && watchers.has(x.session) && (x.base ?? baseRef) === baseRef && ms(x.t) >= ms(at) - 5_000);
        // The session's next read of the base after a turn: BASE_EVERY_MS while one of its PRs is busy, BASE_IDLE_MS once
        // all have settled (poller.ts checkBases). Busy is judged from the log: a CI record dated inside the turn.
        const nextRead = (from, to, watchers) =>
          records.some(
            (x) => x.type === "event" && String(x.kind ?? "").startsWith("ci.") && watchers.has(x.session) && x.github_at && ms(x.github_at) >= ms(from) && ms(x.github_at) <= ms(to),
          )
            ? BASE_EVERY_MS
            : BASE_IDLE_MS;
        for (let i = 0; i < turns.length; i++) {
          const turn = turns[i];
          const undo = turns[i + 1];
          const watchers = watchersAt(turn.at, turn.kind);
          // A turn undone before the next read changed nothing a read could see: both halves are overtaken. Seen live:
          // main green at 09:42:42Z and red again at 09:44:55Z, with the one watching session idle (reads 600 s apart).
          if (undo && where(key, turn.at, turn.kind) !== "out" && !told(turn.kind, turn.at, watchers)) {
            const read = nextRead(turn.at, undo.at, watchers);
            const lasted = ms(undo.at) - ms(turn.at);
            if (lasted <= read) {
              for (const half of [turn, undo]) if (where(key, half.at, half.kind) !== "out" && !told(half.kind, half.at, watchersAt(half.at, half.kind))) overtaken++;
              overtakenBaseFlips.set(`${repo}@${baseRef}|${turn.at}`, {
                repo,
                base: baseRef,
                kind: turn.kind,
                at: turn.at,
                undone_at: undo.at,
                seconds: Math.round(lasted / 1000),
                next_read_s: read / 1000,
              });
              i++;
              continue;
            }
          }
          if (!told(turn.kind, turn.at, watchers)) expect(turn.kind, turn.at);
        }
      }

    }
  } catch (error) {
    couldNotEvaluate(`GitHub could not be read: ${error.message}`);
  }
  return {
    checked_prs: windows.size,
    requests: githubRequests,
    misses,
    superseded,
    overtaken,
    overtaken_base_flips: [...overtakenBaseFlips.values()].sort((a, b) => ms(a.at) - ms(b.at)),
    not_checked:
      "merge conflicts (GitHub keeps no history of them), pr.head_moved (whether this machine had the commit), pr.body_edited (REST keeps no edit history), pr.review_thread_resolved and pr.ready_to_merge (no history of either), ci.job_failed and ci.job_stuck_queued (a job's history does not say what the run was doing at the time) and review.requested (not tied to a watched pull request)",
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
  out.push(`ended without a stop record: ${s.ended_without_stop.length}`);
  for (const e of s.ended_without_stop) out.push(`  ${e.session} ${e.project}: last record ${e.last}`);
  for (const g of s.gaps) out.push(`  ${g.session} ${g.project}: ${g.from} .. ${g.to} (${g.minutes} min)`);
  if (s.github) {
    out.push(`GitHub check: ${s.github.checked_prs} PR(s), ${s.github.misses.length} miss(es), ${s.github.superseded} superseded failure(s) rightly not sent, ${s.github.overtaken ?? 0} overtaken before a look could see them, ${s.github.requests ?? "?"} GitHub request(s); not checked: ${s.github.not_checked}`);
    out.push(`base flips overtaken: ${s.github.overtaken_base_flips?.length ?? 0}`);
    for (const f of s.github.overtaken_base_flips ?? []) {
      out.push(`  ${f.repo}@${f.base} ${f.kind} ${f.at}, undone ${f.undone_at} (${f.seconds} s; next base read ${f.next_read_s} s)`);
    }
    for (const m of s.github.misses) {
      out.push(`  MISS ${m.kind} ${m.repo}#${m.pr}${m.run_id ? ` run ${m.run_id} "${m.workflow}"` : ""}${m.state ? ` ${m.state}` : ""} at ${m.github_at}`);
    }
  }
  return `${out.map(printable).join("\n")}\n`;
}
