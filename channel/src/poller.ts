/**
 * The loop: every `pollSeconds`, look at each subscribed pull request on
 * GitHub, push what changed, and keep the new state.
 *
 * - THE CURRENT BRANCH'S PR IS WATCHED WITHOUT BEING ASKED (autoSubscribe
 *   `pr`), and the watch follows a `git switch`. Claude adds others with the
 *   subscribe tool (tools.ts), which is how a PR opened from another worktree
 *   is watched.
 * - NO LOGIN IS SAID ONCE, not every poll, and the loop keeps looking: once
 *   the user installs gh or signs in, the channel starts by itself.
 * - RATE LIMITS: an unchanged resource costs nothing (ETags, github.ts); the
 *   interval stretches fourfold when fewer than 200 requests are left this
 *   hour, and a rate-limit answer is waited out.
 * - EACH PR HAS ITS OWN CADENCE (cadence.ts): every pass while its CI runs,
 *   up to five minutes once it has settled. The branch's PR is looked for only
 *   while none is watched, and a base branch is read every minute only while
 *   one of its PRs is busy.
 */
import type { Config } from "./config.ts";
import { type Phase, REQUESTS_EVERY_MS, REVIEW_EVERY_MS, RUNS_EVERY_MS, lookEveryMs, phaseOf, ratePressure } from "./cadence.ts";
import { type JobsSeen, jobChanges } from "./jobs.ts";
import { type RequestsSeen, requestChanges, requestMessage } from "./requests.ts";
import { type ReviewState, reviewChanges } from "./reviews.ts";
import { type ChannelMessage, clean, describe, safeLink, scopeMessage, setupMessage, toMessage } from "./format.ts";
import type { GitScope } from "./git.ts";
import { type EventLog, NO_EVENT_LOG } from "./eventlog.ts";
import type { BaseRunInfo, ApiResult, GhProblem, GitHubClient } from "./github.ts";
import { log } from "./log.ts";
import { baseVerdict, latestPerWorkflow } from "./rules.mjs";
import { type Change, type EventKind, type Snapshot, carry, diff, needsAttention } from "./state.ts";
import type { HookRequest } from "./hookrequests.ts";
import { type Entry, MAX_HOOK_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS, type Subscriptions, wants } from "./subscriptions.ts";

/**
 * The PR and its head's runs. `reuseRunsOf`: a snapshot whose runs stand in for a fresh read when the PR has not
 * changed since (same head, same updated time), so a settled PR costs one request a look, not two.
 */
export async function fetchSnapshot(gh: GitHubClient, repo: string, pr: number, reuseRunsOf: Snapshot | null = null): Promise<ApiResult<Snapshot>> {
  const pull = await gh.getPull(repo, pr);
  if (pull.kind !== "ok") return pull;
  const p = pull.value;
  const state = p.merged ? "merged" : p.state === "closed" ? "closed" : "open";
  let runs: Snapshot["runs"] = [];
  const unchanged = reuseRunsOf !== null && reuseRunsOf.headSha === p.headSha && reuseRunsOf.updatedAt === p.updatedAt && p.updatedAt !== undefined;
  if (state === "open" && p.headSha && unchanged) {
    runs = reuseRunsOf.runs;
  } else if (state === "open" && p.headSha) {
    const r = await gh.runsForSha(repo, p.headSha);
    if (r.kind !== "ok") return r;
    runs = r.value;
  }
  return {
    kind: "ok",
    value: {
      repo,
      pr,
      state,
      headSha: p.headSha,
      headRef: p.headRef,
      mergeableState: p.mergeableState,
      prUrl: p.htmlUrl,
      runs,
      ...(p.closedAt ? { closedAt: p.closedAt } : {}),
      ...(p.createdAt ? { createdAt: p.createdAt } : {}),
      ...(p.author ? { author: p.author } : {}),
      ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
      ...(p.baseRef ? { baseRef: p.baseRef } : {}),
      ...(p.draft !== undefined ? { draft: p.draft } : {}),
      ...(p.labels ? { labels: p.labels } : {}),
      ...(p.bodyHash ? { bodyHash: p.bodyHash } : {}),
    },
  };
}

export interface PollerDeps {
  readonly config: Config;
  readonly gh: GitHubClient;
  readonly subs: Subscriptions;
  readonly readScope: () => Promise<GitScope>;
  readonly notify: (message: ChannelMessage) => Promise<void>;
  readonly signal: AbortSignal;
  /** Test seam. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The durable record (eventlog.ts); none by default. */
  readonly eventLog?: EventLog;
  /** How often the event log gets a heartbeat; five minutes by default. */
  readonly heartbeatMs?: number;
  /**
   * Whether a commit is the session's work tree's HEAD or behind it (git.ts `inOwnHistory`): a new head that
   * is not was pushed by someone else (a person, another session, another worktree) and is `pr.head_moved`.
   * Asked only for PRs in the session's own repository.
   */
  readonly inOwnHistory?: (sha: string) => Promise<boolean | null>;
  /** How often each watched base branch is read while one of its PRs is busy; a minute by default. */
  readonly baseEveryMs?: number;
  /** How often a base branch is read while all its PRs have settled; ten minutes by default. */
  readonly baseIdleMs?: number;
  /** Test seam: the clock the cadence runs on. */
  readonly now?: () => number;
  /** Test seam: how often a PR in a phase is looked at (cadence.ts); `() => 0` looks at every PR every pass. */
  readonly lookEveryMs?: (phase: Phase, pollMs: number, quietLooks: number) => number;
  /** How often a watched open PR's reviews are read (cadence.ts REVIEW_EVERY_MS); tests set 0. */
  readonly reviewEveryMs?: number;
  /** How often this login's review requests are searched, when on (cadence.ts REQUESTS_EVERY_MS); tests set 0. */
  readonly requestsEveryMs?: number;
  /** PRs the PostToolUse hook handed over since the last pass (hookrequests.ts takeRequests); none by default. */
  readonly takeHookRequests?: () => readonly HookRequest[];
  readonly limits?: Partial<typeof DEFAULT_LIMITS>;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function notVisible(e: Entry): ChannelMessage {
  return {
    content:
      `runners.io CI channel: GitHub no longer shows PR #${e.pr} in ${e.repo} to this GitHub login, so the channel stopped watching it. ` +
      "A private repository needs a gh login with the repo scope.",
    meta: { kind: "channel_pr_not_visible", repo: e.repo, pr: String(e.pr) },
  };
}

function currentState(s: Snapshot): ChannelMessage {
  return {
    content: `CI needs attention on the pull request for this branch:\n${describe(s)}`,
    meta: { kind: "ci.current_state", repo: s.repo, pr: String(s.pr) },
  };
}

/**
 * A PR that was visible is dropped only after this many "not found" answers in a row: one 403 or 404 can
 * be GitHub having a moment, and dropping on the first lost the watch for good.
 */
export const NOT_FOUND_LIMIT = 3;

/**
 * A PR the hook handed over is kept only if GitHub says it was opened at most this long before the hook
 * saw it. Any tool output that names a PR is handed over (a script's log, `gh pr view`), and only a PR just opened
 * is one this session made; an older one is dropped after its first look, without a word.
 */
export const HOOK_NEW_MS = 15 * 60_000;

/** The limits a session watches within (deps.limits overrides any of them, for tests). */
export const DEFAULT_LIMITS = {
  total: MAX_SUBSCRIPTIONS,
  hook: MAX_HOOK_SUBSCRIPTIONS,
  eventsPerPr: 20,
  eventWindowMs: 10 * 60_000,
};

/** Said once when a PR's events pass the budget; nothing more is pushed for it until the window moves on. */
function throttled(repo: string, pr: string, windowMs: number): ChannelMessage {
  return {
    content:
      `${repo} PR #${pr} changed more often than this session is told about in ${Math.round(windowMs / 60_000)} minutes, ` +
      "so further events for it are held back for now. Call ci_status for its current state.",
    meta: { kind: "channel_throttled", repo, pr },
  };
}

/** How long a base keeps a workflow's last run once it has left the window read. */
export const CARRY_BASE_RUN_MS = 24 * 60 * 60_000;

export async function runPoller(deps: PollerDeps): Promise<void> {
  const { config, gh, subs, signal } = deps;
  // The head commit each PR's ci.workflow_started was last sent for: a push starts many workflows, and one
  // event per workflow was eight in a burst for one push. The rest are logged as collapsed.
  const startedFor = new Map<string, string>();
  const sleep = deps.sleep ?? realSleep;
  const events = deps.eventLog ?? NO_EVENT_LOG;
  const heartbeatMs = deps.heartbeatMs ?? 300_000;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  // Per PR, when each event of the current window was sent: past limits.eventsPerPr, one channel_throttled and then
  // nothing for that PR until the window moves on. A PR whose CI changes faster than a person reads is noise, and
  // every event carries text from the repository.
  const sentAt = new Map<string, number[]>();
  let lastBeat = 0;
  const unsubscribe = (e: Entry, reason: string) => {
    subs.remove(e.repo, e.pr);
    events.write("unsubscribe", { repo: e.repo, pr: e.pr, source: e.source, reason });
  };
  const send = async (message: ChannelMessage, change: Change | null, wanted = true, reason?: string, extra: Record<string, unknown> = {}) => {
    let fields = { ...eventFields(message, change), ...extra };
    if (!wanted) return events.write("event", { ...fields, outcome: "filtered", ...(reason ? { reason } : {}) });
    const meta = message.meta as Record<string, unknown>;
    if (typeof meta.repo === "string" && typeof meta.pr === "string") {
      const key = `${meta.repo.toLowerCase()}#${meta.pr}`;
      const recent = (sentAt.get(key) ?? []).filter((t) => now() - t < limits.eventWindowMs);
      sentAt.set(key, recent);
      if (recent.length > limits.eventsPerPr) return events.write("event", { ...fields, outcome: "filtered", reason: "throttled" });
      recent.push(now());
      if (recent.length > limits.eventsPerPr) {
        events.write("event", { ...fields, outcome: "filtered", reason: "throttled" });
        message = throttled(meta.repo, meta.pr, limits.eventWindowMs);
        fields = { ...eventFields(message, null), ...extra };
      }
    }
    try {
      await deps.notify(message);
      events.write("event", { ...fields, outcome: "sent" });
    } catch (error) {
      events.write("event", { ...fields, outcome: "error", error: (error as Error).message });
      throw error;
    }
  };
  const baseEveryMs = deps.baseEveryMs ?? 60_000;
  const baseIdleMs = Math.max(baseEveryMs, deps.baseIdleMs ?? 600_000);
  const now = deps.now ?? Date.now;
  const lookEvery = deps.lookEveryMs ?? lookEveryMs;
  /** Per watched PR: when it is next looked at, and what the cadence needs to know. */
  /** The rate limit's back-off, from the newest reading any session on this machine got (cadence.ts). */
  const pressure = () => ratePressure(gh.rateRemaining, gh.rateLimit);
  let rateLevel: "normal" | "slowed" | "paused" = "normal";
  const looks = new Map<string, { next: number; quiet: number; phase: Phase; headSha: string; headSeenAt: number; runsReadAt: number }>();
  let findLabel = "";
  let findSince = 0;
  let foundAt = Number.NEGATIVE_INFINITY;
  /** Per base: its verdict, when it was read, and each workflow's newest completed run so far. */
  const bases = new Map<string, { red: boolean; readAt: number; runs: BaseRunInfo[] }>();
  let saidProblem: GhProblem["kind"] | null = null;
  let lastScope = "";
  let saidScope = false;
  const misses = new Map<string, number>();
  /** Per PR the hook handed over and not yet looked at: when the hook saw it (HOOK_NEW_MS). */
  const hookSeenAt = new Map<string, number>();

  const problem = async (p: GhProblem) => {
    if (saidProblem !== p.kind) {
      saidProblem = p.kind;
      log(`no usable GitHub login: ${p.kind}`);
      events.write("problem", { kind: p.kind });
      await send(setupMessage(p), null);
    }
  };

  const reviewEveryMs = deps.reviewEveryMs ?? REVIEW_EVERY_MS;
  /** Per watched PR: the last review reading (null until the first) and when to read again. */
  const reviews = new Map<string, { state: ReviewState | null; next: number }>();
  const REVIEW_KINDS: EventKind[] = ["pr.approved", "pr.changes_requested", "pr.review_thread_added", "pr.review_thread_resolved", "pr.ready_to_merge"];
  /**
   * Each watched open PR whose subscription wants a review kind: one GraphQL read about once a minute
   * (reviews.ts). GraphQL's budget is its own, so its own reading decides the back-off and the pause.
   */
  const checkReviews = async () => {
    for (const key of reviews.keys()) if (!subs.list().some((e) => e.key === key)) reviews.delete(key);
    const p = ratePressure(gh.graphqlRemaining, gh.graphqlLimit);
    if (p.pause) return;
    for (const entry of subs.list()) {
      if (signal.aborted) return;
      if (entry.last?.state !== "open" || !REVIEW_KINDS.some((k) => wants(entry, k))) continue;
      const seen = reviews.get(entry.key);
      if (seen && now() < seen.next) continue;
      const r = await gh.reviewState(entry.repo, entry.pr, reviewEveryMs);
      if (r.kind === "auth") {
        await problem(r.auth);
        return;
      }
      if (r.kind !== "ok") {
        if (r.kind === "retry") events.write("api_error", { repo: entry.repo, pr: entry.pr, result: "retry", reason: r.reason, api: "graphql" });
        reviews.set(entry.key, { state: seen?.state ?? null, next: now() + Math.max(reviewEveryMs, r.kind === "retry" ? (r.afterMs ?? 0) : 0) });
        continue;
      }
      const live = subs.get(entry.repo, entry.pr);
      if (!live?.last) continue;
      const { changes, keep } = reviewChanges(seen?.state ?? null, r.value, live.last);
      reviews.set(entry.key, { state: keep, next: now() + reviewEveryMs * p.stretch });
      for (const change of changes) await send(toMessage(change), change, wants(live, change.kind));
    }
  };

  /** Per watched PR: the jobs already reported failed or stuck (jobs.ts); absent until the PR's first look. */
  const jobsSeen = new Map<string, JobsSeen>();
  const JOB_KINDS: EventKind[] = ["ci.job_failed", "ci.job_stuck_queued"];
  /**
   * The jobs of each run on the head that has not finished, when the subscription wants a job kind: one GET per
   * such run per look, a 304 when nothing changed. The PR's first look is a baseline (jobs.ts).
   */
  const checkJobs = async (entry: Entry, snap: Snapshot) => {
    for (const key of jobsSeen.keys()) if (!subs.list().some((e) => e.key === key)) jobsSeen.delete(key);
    if (!JOB_KINDS.some((k) => wants(entry, k))) return;
    let seen = jobsSeen.get(entry.key) ?? null;
    for (const run of snap.runs) {
      if (run.status === "completed" || signal.aborted) continue;
      const r = await gh.runJobs(entry.repo, run.id);
      if (r.kind === "auth") return problem(r.auth);
      if (r.kind !== "ok") continue;
      const { changes, keep } = jobChanges(seen, run, r.value, snap, now());
      seen = keep;
      jobsSeen.set(entry.key, keep);
      for (const change of changes) {
        let full = change;
        if (change.kind === "ci.job_failed" && change.job && wants(entry, change.kind)) {
          const a = await gh.jobAnnotations(entry.repo, change.job.id);
          if (a.kind === "ok") full = { ...change, job: { ...change.job, annotations: a.value } };
        }
        await send(toMessage(full), full, wants(entry, change.kind));
      }
    }
    // No run left to read: the baseline is "nothing", so a later run's first failure is news. A read that failed
    // leaves the baseline for the next look.
    if (!jobsSeen.has(entry.key) && snap.runs.every((r) => r.status === "completed")) jobsSeen.set(entry.key, { failed: new Set(), stuck: new Set() });
  };

  const requestsEveryMs = deps.requestsEveryMs ?? REQUESTS_EVERY_MS;
  let requests: { seen: RequestsSeen | null; next: number } = { seen: null, next: 0 };
  /** This login's review requests (requests.ts), when on: one shared GraphQL search every few minutes. */
  const checkReviewRequests = async () => {
    if (!config.reviewRequests || now() < requests.next) return;
    const p = ratePressure(gh.graphqlRemaining, gh.graphqlLimit);
    if (p.pause) return;
    const r = await gh.reviewRequests(requestsEveryMs > 0 ? requestsEveryMs - 1_000 : 0);
    if (r.kind === "auth") return problem(r.auth);
    if (r.kind !== "ok") {
      if (r.kind === "retry") events.write("api_error", { result: "retry", reason: r.reason, api: "graphql", what: "review_requests" });
      requests = { ...requests, next: now() + Math.max(requestsEveryMs, r.kind === "retry" ? (r.afterMs ?? 0) : 0) };
      return;
    }
    const { fresh, keep } = requestChanges(requests.seen, r.value, now());
    requests = { seen: keep, next: now() + requestsEveryMs * p.stretch };
    for (const q of fresh) {
      const at = Date.parse(q.at);
      await send(requestMessage(q), null, true, undefined, {
        review_url: safeLink(q.url) || null,
        github_at: q.at || null,
        latency_ms: Number.isFinite(at) ? Math.max(0, Date.now() - at) : null,
      });
    }
  };

  const BASE_KINDS: EventKind[] = ["base.red", "base.green"];
  /** Each base branch a subscription wants news of, read at most every `baseEveryMs`; red <-> green is pushed. */
  const checkBases = async () => {
    if (pressure().pause) return; // a base is news, not the PR's own CI: it waits for the limit to refill
    const stretch = pressure().stretch;
    const targets = new Map<string, Entry[]>();
    for (const e of subs.list()) {
      const base = e.last?.state === "open" ? e.last.baseRef : undefined;
      if (!base || !BASE_KINDS.some((k) => wants(e, k))) continue;
      const key = `${e.repo.toLowerCase()}@${base}`;
      (targets.get(key) ?? targets.set(key, []).get(key))?.push(e);
    }
    for (const key of bases.keys()) if (!targets.has(key)) bases.delete(key);
    for (const [key, entries] of targets) {
      const known = bases.get(key);
      const busy = entries.some((e) => looks.get(e.key)?.phase !== "finished");
      if (known && now() - known.readAt < (busy ? baseEveryMs : baseIdleMs) * stretch) continue;
      const first = entries[0];
      const base = first.last?.baseRef as string;
      const r = await gh.baseRuns(first.repo, base, baseEveryMs);
      if (r.kind !== "ok") {
        if (r.kind === "retry") events.write("api_error", { repo: first.repo, base, result: "retry", reason: r.reason });
        continue;
      }
      // A workflow missing from this window keeps its last run, for a day: long enough for the slowest
      // workflow on a busy main, short enough that a workflow deleted while red does not hold the base red for ever.
      const carried = (known?.runs ?? []).filter((x) => now() - Date.parse(x.created_at ?? "") < CARRY_BASE_RUN_MS);
      const runs = latestPerWorkflow([...carried, ...r.value]);
      const v = baseVerdict(runs);
      bases.set(key, { red: v.red, readAt: now(), runs });
      if (!known || known.red === v.red) continue;
      // ONE event per base and transition, naming every watched PR on it: it is about the base, and one per PR
      // said "main is green again" once for each.
      const kind = v.red ? "base.red" : "base.green";
      const seen = entries.filter((e) => e.last !== null);
      const wanting = seen.filter((e) => wants(e, kind));
      const about = wanting[0] ?? seen[0];
      if (!about?.last) continue;
      const prs = [...new Set((wanting.length ? wanting : seen).map((e) => e.pr))].sort((a, b) => a - b);
      const change: Change = { kind, snapshot: about.last, failing: v.failing, prs, ...(v.at ? { at: v.at } : {}) };
      await send(toMessage(change), change, wanting.length > 0);
    }
  };

  while (!signal.aborted) {
    let waitMs = config.pollSeconds * 1000;
    const belowFloor = () => gh.rateRemaining !== null && gh.rateRemaining < config.rateFloor;
    // With other sessions on this machine (shared.ts), an answer younger than one interval is read from the
    // shared store instead of asking GitHub again, so N sessions cost what one does.
    gh.freshMs = waitMs * Math.max(belowFloor() ? 4 : 1, pressure().stretch);
    {
      const p = pressure();
      const level = p.pause ? "paused" : p.stretch > 1 ? "slowed" : "normal";
      if (level !== rateLevel) {
        if (rateLevel !== "normal" || level !== "normal") {
          log(`GitHub rate limit: ${gh.rateRemaining} of ${gh.rateLimit} left, reads ${level}`);
          // Why the level changed: below 30% left ("low"), a reading back above it ("recovered"), or the reading
          // went void at x-ratelimit-reset ("reset"), when remaining is null until the next answer.
          const reason = level !== "normal" ? "low" : gh.rateRemaining === null ? "reset" : "recovered";
          events.write("rate_backoff", { level, reason, remaining: gh.rateRemaining, limit: gh.rateLimit, stretch: p.stretch });
        }
        rateLevel = level;
      }
    }
    const auth = await gh.login();
    if (auth.kind !== "ok") {
      await problem(auth);
      await sleep(waitMs, signal);
      continue;
    }

    const scope = config.autoSubscribe === "pr" || deps.inOwnHistory ? await deps.readScope() : null;
    if (config.autoSubscribe === "pr" && scope) {
      const label = `${scope.repo ?? "(no GitHub remote)"}@${scope.branch ?? "(no branch)"}`;
      if (label !== lastScope) {
        log(`session folder is on ${label}`);
        lastScope = label;
      }
      let current: string | null = null;
      if (label !== findLabel) {
        findLabel = label;
        findSince = now();
        foundAt = Number.NEGATIVE_INFINITY;
      }
      // The branch's PR is looked for only while none is watched: every minute for five minutes after a branch
      // change, then every five. A watched one that merges or closes is unwatched below, and the looking resumes.
      const repo = scope.repo?.toLowerCase();
      const watched = subs.list().some((e) => e.source === "auto" && e.repo.toLowerCase() === repo && e.last?.state === "open" && e.last.headRef === scope.branch);
      const findEvery = now() - findSince < 5 * 60_000 ? lookEvery("pending", 0, 0) : lookEvery("finished", 0, 99);
      if (scope.repo && scope.branch && (watched || pressure().pause || now() - foundAt < findEvery * pressure().stretch)) {
        current = "keep";
      } else if (scope.repo && scope.branch) {
        foundAt = now();
        const found = await gh.findOpenPull(scope.repo, scope.branch);
        if (found.kind === "auth") {
          await problem(found.auth);
          await sleep(waitMs, signal);
          continue;
        }
        if (found.kind === "ok" && found.value !== null) {
          const isNew = !subs.get(scope.repo, found.value);
          current = subs.add({ repo: scope.repo, pr: found.value, source: "auto" }).key;
          if (isNew) events.write("subscribe", { repo: scope.repo, pr: found.value, source: "auto", events: "all" });
        } else if (found.kind !== "ok") {
          current = "keep"; // GitHub did not answer: leave the automatic subscription as it is
        }
      }
      if (current !== "keep") {
        for (const e of subs.list()) {
          if (e.source !== "auto" || e.key === current) continue;
          // No open PR for this branch any more, but this entry IS the branch's PR: it was just merged or
          // closed. Keep it for this pass so the merge is reported; the poll below ends it.
          const sameBranch = current === null && e.repo === scope.repo && e.last?.headRef === scope.branch;
          if (!sameBranch) unsubscribe(e, "branch_switch");
        }
      }
    }

    for (const req of deps.takeHookRequests?.() ?? []) {
      if (subs.get(req.repo, req.pr)) continue; // already watched, by Claude, the branch or an earlier hand-over
      // A PR URL in a tool's output is text anyone can write (a log, a README, a comment). The hook already keeps
      // only the session's own repository; checked again here, with the settings and the limits.
      const refuse = (reason: string) => events.write("hook_refused", { repo: req.repo, pr: req.pr, reason });
      if (config.autoSubscribe === "off") {
        refuse("auto_subscribe_off");
        continue;
      }
      if (!scope?.repo || scope.repo.toLowerCase() !== req.repo.toLowerCase()) {
        refuse("other_repo");
        continue;
      }
      const all = subs.list();
      if (all.length >= limits.total || all.filter((x) => x.source === "hook").length >= limits.hook) {
        refuse("cap");
        continue;
      }
      const e = subs.add({ repo: req.repo, pr: req.pr, source: "hook" });
      hookSeenAt.set(e.key, req.at);
      events.write("subscribe", { repo: req.repo, pr: req.pr, source: "hook", events: "all" });
    }
    for (const key of hookSeenAt.keys()) if (!subs.list().some((e) => e.key === key && e.source === "hook")) hookSeenAt.delete(key);
    for (const key of looks.keys()) if (!subs.list().some((e) => e.key === key)) looks.delete(key);
    for (const entry of subs.list()) {
      if (signal.aborted) break;
      const look = looks.get(entry.key);
      if (look && now() < look.next) continue;
      // Paused: a PR with nothing running waits for the limit to refill; one whose CI runs is still read.
      if (look && look.phase === "finished" && pressure().pause) continue;
      const reuse = look?.phase === "finished" && now() - look.runsReadAt < RUNS_EVERY_MS ? entry.last : null;
      const r = await fetchSnapshot(gh, entry.repo, entry.pr, reuse);
      if (r.kind === "auth") {
        await problem(r.auth);
        break;
      }
      if (r.kind === "retry") {
        log(`GitHub: ${r.reason}`);
        events.write("api_error", { repo: entry.repo, pr: entry.pr, result: "retry", reason: r.reason, after_ms: r.afterMs ?? null });
        if (r.afterMs) waitMs = Math.max(waitMs, r.afterMs);
        continue;
      }
      if (r.kind === "not_found") {
        const missed = (misses.get(entry.key) ?? 0) + 1;
        misses.set(entry.key, missed);
        events.write("api_error", { repo: entry.repo, pr: entry.pr, result: "not_found", misses: missed });
        if (missed < NOT_FOUND_LIMIT) continue;
        misses.delete(entry.key);
        if (subs.get(entry.repo, entry.pr)) {
          unsubscribe(entry, "not_visible");
          await send(notVisible(entry), null);
        }
        continue;
      }
      saidProblem = null;
      misses.delete(entry.key);
      const snap = r.value;
      const live = subs.get(entry.repo, entry.pr);
      if (!live) continue; // unsubscribed while GitHub was being asked
      if (live.source === "hook" && live.last === null) {
        const seenAt = hookSeenAt.get(live.key) ?? now();
        const opened = Date.parse(snap.createdAt ?? "");
        if (snap.state !== "open" || !Number.isFinite(opened) || seenAt - opened > HOOK_NEW_MS) {
          unsubscribe(live, "hook_not_new");
          continue;
        }
        // Only a PR the signed-in login opened. Not known (GitHub did not say) is not a yes.
        const me = await gh.viewerLogin();
        if (me.kind !== "ok" || !me.value || (snap.author ?? "").toLowerCase() !== me.value.toLowerCase()) {
          unsubscribe(live, "hook_not_mine");
          continue;
        }
      }
      const first = live.last === null;
      const changes = diff(live.last, snap);
      const prev = live.last;
      if (
        deps.inOwnHistory &&
        prev?.state === "open" &&
        snap.state === "open" &&
        snap.headSha &&
        snap.headSha !== prev.headSha &&
        scope?.repo?.toLowerCase() === entry.repo.toLowerCase() &&
        (await deps.inOwnHistory(snap.headSha)) === false
      ) {
        changes.unshift({ kind: "pr.head_moved", snapshot: snap, ...(snap.updatedAt ? { at: snap.updatedAt } : {}) });
      }
      const starts = changes.filter((c) => c.kind === "ci.workflow_started");
      const startKey = `${entry.repo.toLowerCase()}#${entry.pr}`;
      const startedAlready = startedFor.get(startKey) === snap.headSha;
      if (starts.length) startedFor.set(startKey, snap.headSha);
      for (let change of changes) {
        if (change.kind === "ci.workflow_started") {
          if (startedAlready || change !== starts[0]) {
            await send(toMessage(change), change, false, "collapsed");
            continue;
          }
          change = { ...change, workflows: starts.length };
        }
        if (!wants(live, change.kind)) {
          await send(toMessage(change), change, false);
          continue;
        }
        const full = await withFailedJobs(gh, change);
        await send(toMessage(full), full);
      }
      if (snap.state === "open") await checkJobs(live, snap);
      if (first && live.source === "auto" && needsAttention(snap)) await send(currentState(snap), null);
      {
        const t = now();
        const headSeenAt = look && look.headSha === snap.headSha ? look.headSeenAt : t;
        const phase = phaseOf(snap, headSeenAt, t);
        const quiet = changes.length === 0 && look?.phase === "finished" && phase === "finished" ? look.quiet + 1 : 0;
        const runsReadAt = look && reuse !== null && snap.runs === reuse.runs ? look.runsReadAt : t;
        looks.set(entry.key, { next: t + lookEvery(phase, config.pollSeconds * 1000, quiet) * pressure().stretch, quiet, phase, headSha: snap.headSha, headSeenAt, runsReadAt });
      }
      live.last = carry(live.last, snap);
      if (snap.state !== "open") unsubscribe(live, snap.state);
    }

    await checkBases();
    await checkReviews();
    await checkReviewRequests();

    if (!saidScope && gh.scopes !== null && !gh.scopes.includes("repo")) {
      saidScope = true;
      log("the gh login has no repo scope");
      events.write("problem", { kind: "no_repo_scope" });
      await send(scopeMessage(), null);
    }

    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now();
      events.write("heartbeat", {
        subscriptions: subs.list().length,
        watching: subs.list().map((e) => `${e.repo}#${e.pr}`),
        rate_remaining: gh.rateRemaining,
        rate_limit: gh.rateLimit,
        graphql_remaining: gh.graphqlRemaining,
        requests: { ...gh.requests },
      });
    }

    waitMs *= Math.max(belowFloor() ? 4 : 1, pressure().stretch); // the newest reading, this pass's answers included
    await sleep(waitMs, signal);
  }
}

async function withFailedJobs(gh: GitHubClient, change: Change): Promise<Change> {
  if (change.kind !== "ci.workflow_failed" || !change.run) return change;
  const jobs = await gh.failedJobs(change.snapshot.repo, change.run.id);
  return jobs.kind === "ok" ? { ...change, failedJobs: jobs.value } : change;
}

/**
 * What the event log keeps about one pushed (or held back) message, with its latency: the time from
 * GitHub's own timestamp for the change to now. A merge-conflict change has no GitHub time, so its
 * latency is null.
 */
function eventFields(message: ChannelMessage, change: Change | null): Record<string, unknown> {
  const m = message.meta;
  const fields: Record<string, unknown> = { kind: m.kind, repo: m.repo ?? null, pr: m.pr ? Number(m.pr) : null };
  if (!change) return { ...fields, latency_ms: null };
  const s = change.snapshot;
  const at = githubTime(change);
  return {
    ...fields,
    sha: s.headSha,
    run_id: change.run?.id ?? null,
    // Workflow names are chosen by whoever pushed; cleaned as in the message, so the log holds no terminal escapes.
    workflow: change.run ? clean(change.run.name) : null,
    conclusion: change.run?.conclusion ?? change.conclusion ?? null,
    github_at: at ?? null,
    latency_ms: at ? Math.max(0, Date.now() - Date.parse(at)) : null,
    ...(change.labelsAdded
      ? { labels_added: change.labelsAdded.map((l) => clean(l, 40)), labels_removed: (change.labelsRemoved ?? []).map((l) => clean(l, 40)) }
      : {}),
    ...(change.failing ? { failing: change.failing.map((name) => clean(name)), base: s.baseRef ?? null } : {}),
    // A review's or a thread's link: its id is what the summary's GitHub check matches it by.
    ...(change.review?.url ? { review_url: safeLink(change.review.url) || null } : {}),
    ...(change.run ? { run_attempt: change.run.runAttempt } : {}),
  };
}

function githubTime(c: Change): string | undefined {
  if (c.at) return c.at;
  switch (c.kind) {
    case "ci.workflow_started":
      return c.run?.startedAt;
    case "ci.run_all_done":
      return c.snapshot.runs.map((r) => r.updatedAt ?? "").sort().at(-1) || undefined;
    case "pr.merged":
    case "pr.closed":
      return c.snapshot.closedAt;
    case "pr.conflict":
    case "pr.conflict_resolved":
      return undefined;
    case "pr.labels_changed":
    case "pr.ready_for_review":
    case "pr.converted_to_draft":
    case "pr.body_edited":
    case "pr.head_moved":
      return c.snapshot.updatedAt;
    default:
      return c.run?.updatedAt;
  }
}
