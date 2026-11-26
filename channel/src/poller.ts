/**
 * The loop: every `pollSeconds`, look at each subscribed pull request on
 * GitHub, push what changed, and keep the new state.
 *
 * - THE CURRENT BRANCH'S PR IS WATCHED WITHOUT BEING ASKED (autoSubscribe
 *   `pr`) WHEN THE SIGNED-IN LOGIN OPENED IT, and the watch follows a `git
 *   switch`. Somebody else's is said once and left alone. Claude
 *   adds others with the subscribe tool (tools.ts), which is how a PR opened
 *   from another worktree, or another person's, is watched.
 * - NO LOGIN IS SAID ONCE, not every poll, and the loop keeps looking: once
 *   the user installs gh or signs in, the channel starts by itself.
 * - RATE LIMITS: an unchanged resource costs nothing (ETags, github.ts); the
 *   interval stretches fourfold when fewer than 200 requests are left this
 *   hour, and a rate-limit answer is waited out. At JOB_READS_FLOOR left,
 *   no run's jobs or annotations are read at all until the reset.
 * - EACH PR HAS ITS OWN CADENCE (cadence.ts): every pass while its CI runs,
 *   up to five minutes once it has settled. The branch's PR is looked for only
 *   while none is watched, and a base branch is read every minute only while
 *   one of its PRs is busy.
 * - A REPOSITORY SCOPE (scopes.ts) IS A LIST, NOT A SECOND LOOP: once a minute the repository's open pull requests are
 *   read (one conditional request), and each one the scope covers is held as an ordinary subscription, source
 *   `scope`, within the session's cap. From there it is looked at, filtered and reported like any other.
 */
import type { Config } from "./config.ts";
import { JOB_READS_FLOOR, OWN_PUSH_FAST_MS, PENDING_WINDOW_MS, type Phase, REQUESTS_EVERY_MS, REVIEW_EVERY_MS, RUNS_EVERY_MS, SCOPE_EVERY_MS, SCOPE_LEAVE_MS, lookEveryMs, passSleepMs, phaseOf, ratePressure } from "./cadence.ts";
import { type JobsSeen, jobChanges } from "./jobs.ts";
import { type RequestsSeen, requestChanges, requestMessage } from "./requests.ts";
import { type ReviewState, reviewChanges } from "./reviews.ts";
import { type ChannelMessage, REPLY, clean, describe, safeLink, scopeMessage, setupMessage, toMessage } from "./format.ts";
import type { GitScope } from "./git.ts";
import { ForkParents, findBranchPull } from "./forks.ts";
import { type EventLog, NO_EVENT_LOG } from "./eventlog.ts";
import type { BaseRunInfo, ApiResult, GhProblem, GitHubClient } from "./github.ts";
import { log } from "./log.ts";
import { BASE_EVERY_MS, BASE_IDLE_MS, baseVerdict, latestPerWorkflow } from "./rules.mjs";
import { type Change, type EventKind, type Snapshot, allDoneChange, carry, diff, needsAttention } from "./state.ts";
import type { HookRequest } from "./hookrequests.ts";
import type { OpenPull, Scope, ScopeStore } from "./scopes.ts";
import { internalError } from "./faults.ts";
import { AUTO_EVENTS, type Entry, MAX_HOOK_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS, type Subscriptions, wants } from "./subscriptions.ts";

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
    const r = await gh.runsForSha(repo, p.headSha, { ref: p.headRef, repo: p.headRepo });
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
      ...(p.mergeStatus ? { mergeStatus: p.mergeStatus } : {}),
      prUrl: p.htmlUrl,
      runs,
      ...(p.closedAt ? { closedAt: p.closedAt } : {}),
      ...(p.createdAt ? { createdAt: p.createdAt } : {}),
      ...(p.author ? { author: p.author } : {}),
      ...(p.headRepo ? { headRepo: p.headRepo } : {}),
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
  /**
   * The clone's `refs/remotes/origin/<b>` for each branch (git.ts `readPushed`), in one local git read: a change is the
   * session's own push to that PR, from its folder or any git worktree of it. Asked only for open watched PRs in the
   * session's own repository; never a GitHub request.
   */
  readonly readPushed?: (branches: readonly string[]) => Promise<ReadonlyMap<string, string | null> | null>;
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
  /** This project's scopes (scopes.ts); none: no repository is watched as a whole. */
  readonly scopes?: ScopeStore;
  /** How often a scope's list of open pull requests is read (cadence.ts SCOPE_EVERY_MS); tests set 0. */
  readonly scopeEveryMs?: number;
  /** How long a held pull request that left the open list is kept to report its end (cadence.ts SCOPE_LEAVE_MS); tests set 0. */
  readonly scopeLeaveMs?: number;
  /**
   * Which repository the clone was forked from (forks.ts): the branch's pull request is looked for there first. One of
   * its own by default; main.ts hands the tools the same one, so GitHub is asked about a repository once.
   */
  readonly parents?: ForkParents;
  /** PRs the PostToolUse hook handed over since the last pass (hookrequests.ts takeRequests); none by default. */
  readonly takeHookRequests?: () => readonly HookRequest[];
  readonly limits?: Partial<typeof DEFAULT_LIMITS>;
  /**
   * How long a head is watched before ci.run_all_done or pr.ready_to_merge may be said for it (cadence.ts
   * PENDING_WINDOW_MS by default): a fast workflow can finish before a slow one has registered. Tests set 0.
   */
  readonly allDoneHoldMs?: number;
  /**
   * Test seam: handed, once, a reader of how many entries each long-lived list holds, so a test can hold every one
   * under a bound. Nothing else reads it.
   */
  readonly sizes?: (read: () => Record<string, number>) => void;
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
    content: `CI needs attention on the pull request for this branch. Tell the user what needs attention. ${REPLY}\n${describe(s)}`,
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

/**
 * The most messages one session is sent in an hour, across every PR it watches. The per-PR throttle bounds one busy PR;
 * this bounds twenty, or a run of review threads and comments from people outside the repository: every event puts
 * text from the repository into the session.
 */
export const SESSION_EVENTS_PER_HOUR = 120;

/** The limits a session watches within (deps.limits overrides any of them, for tests). */
export const DEFAULT_LIMITS = {
  total: MAX_SUBSCRIPTIONS,
  hook: MAX_HOOK_SUBSCRIPTIONS,
  eventsPerPr: 20,
  eventWindowMs: 10 * 60_000,
  /** Across every PR: at most this many messages a session is sent in `sessionWindowMs` (heldBack past it). */
  sessionEvents: SESSION_EVENTS_PER_HOUR,
  sessionWindowMs: 60 * 60_000,
};

/** Said once when a PR's events pass the budget; nothing more is pushed for it until the window moves on, but the exempt kinds. */
function throttled(repo: string, pr: string, windowMs: number): ChannelMessage {
  return {
    content:
      `${repo} PR #${pr} changed more often than this session is told about in ${Math.round(windowMs / 60_000)} minutes, ` +
      "so further events for it are held back for now; its all-done summary, a merge or close, and the first failure on a commit are still sent, " +
      "and its state is sent once the events are no longer held back. Call ci_status for its current state.",
    meta: { kind: "channel_throttled", repo, pr },
  };
}

/** Sent once when a throttled PR's window reopens: the state it reached while its events were held back. */
function resumed(s: Snapshot): ChannelMessage {
  return {
    content: `Events for this pull request are no longer held back. Its state now, which may include what was held back: ${REPLY}\n${describe(s)}`,
    meta: { kind: "channel_resumed", repo: s.repo, pr: String(s.pr) },
  };
}

/**
 * THE KINDS THE PER-PR THROTTLE NEVER HOLDS BACK: what the user is waiting for (ci.run_all_done), the end of the pull
 * request (pr.merged, pr.closed), and the first ci.workflow_failed on each head commit. A repository with many workflows
 * passed the budget on one bad push, and the all-done summary was dropped with the rest. Each is bounded by the PR's own
 * life (one merge or close, one first failure a push, one all done a commit or a late workflow's), so they cannot flood.
 * They still count towards the window, and towards the session's hourly budget, which holds everything back alike.
 */
export const THROTTLE_EXEMPT_KINDS = ["ci.run_all_done", "pr.merged", "pr.closed"] as const;

/** Said once an hour while the session's own budget is spent; nothing more is pushed until the hour moves on. */
function heldBack(windowMs: number): ChannelMessage {
  return {
    content:
      `This session has been told about as many CI and pull-request events as it is told about in ${Math.round(windowMs / 60_000)} minutes, ` +
      "so further events, on every watched pull request, are being held back for now. Call ci_status for a pull request's current state.",
    meta: { kind: "channel_held_back" },
  };
}

/** How many pull request numbers a scope's notice names before it says "and n more". */
const SCOPE_NAMED = 20;

const numbered = (prs: readonly number[]) =>
  prs.slice(0, SCOPE_NAMED).map((n) => `#${n}`).join(", ") + (prs.length > SCOPE_NAMED ? ` and ${prs.length - SCOPE_NAMED} more` : "");

/**
 * Said once when a scope covers more open pull requests than the session has places for, and again only after it has
 * fitted in between: which are watched, and how many are not. Numbers and the repository's name only.
 */
function scopeCapped(repo: string, held: readonly number[], leftOut: number, total: number): ChannelMessage {
  return {
    content:
      `The scope on ${repo} covers ${held.length + leftOut} open pull requests that nothing else here watches, but a session watches at most ${total} in all, ` +
      `so it holds the newest ${held.length} (${held.length ? numbered(held) : "none"}) and leaves out the ${leftOut} older. ` +
      `Nothing is pushed for those ${leftOut}: narrow the scope with involves: "mine" or "me", unsubscribe pull requests this session no longer needs, ` +
      "or call subscribe for one you need (it takes the place of the scope's oldest). list_subscriptions shows what is held; ci_status reads any pull request now. " +
      "Tell the user in one line that the scope is over the cap and how many pull requests are left out.",
    meta: { kind: "channel_scope_capped", repo, held: String(held.length), left_out: String(leftOut) },
  };
}

/**
 * Said once for a pull request found for the session's branch that somebody else opened: it is not watched
 * unless named. Another person's pull request carries their text (logs, branch and commit names) into the session, so
 * the opt-in is the user's: the notice names the call and says to make it only if the user asks. It holds the
 * repository's name and the number, nothing GitHub sent.
 */
function notYoursNotice(repo: string, pr: number): ChannelMessage {
  return {
    content:
      `The open pull request for this branch, ${repo} PR #${pr}, was not opened by the signed-in GitHub login, so the channel does not watch it: ` +
      "only your own pull requests are watched unless one is named. Tell the user in one line that it is not watched. " +
      `Watch it only if the user asks: call subscribe with repo: "${repo}" and pr: ${pr}.`,
    meta: { kind: "channel_pr_not_yours", repo, pr: String(pr) },
  };
}

/**
 * Said once for a scope saved before 0.3.16 with involves "all", which an omitted involves also saved (scopes.ts): it
 * now covers only the login's own pull requests, and the notice says how to cover everybody's again.
 */
function scopeNarrowed(repo: string): ChannelMessage {
  return {
    content:
      `The scope on ${repo} was saved by an earlier version of this plugin, when a scope covered every open pull request unless told otherwise. ` +
      "It now covers only the pull requests the signed-in GitHub login opened: other people's pull requests are watched only when asked for. " +
      "Tell the user in one line that the scope was narrowed. " +
      `Widen it only if the user asks: call subscribe with scope: "repo", repo: "${repo}" and involves: "all" (everybody's), or involves: "me" ` +
      "(those the login opened, is assigned to or is asked to review).",
    meta: { kind: "channel_scope_narrowed", repo },
  };
}

/** The most pull requests found to be somebody else's that one session remembers: a session's branch rarely has more than a few. */
export const NOT_YOURS_KEPT = 50;

/** Said once when GitHub does not show a scoped repository to this login: the scope holds nothing until it does. */
function scopeNotVisible(repo: string): ChannelMessage {
  return {
    content:
      `runners.io CI channel: GitHub does not show ${repo} to this GitHub login, so the scope on it holds no pull requests. ` +
      'A private repository needs a gh login with the repo scope; end the scope with unsubscribe scope: "repo" if the name is wrong. Tell the user in one line.',
    meta: { kind: "channel_scope_not_visible", repo },
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
  // Per PR whose events the throttle has held back this window: whether its notice was sent. The window reopening sends
  // one state summary (resumed) and ends it.
  const throttledPrs = new Map<string, { noticed: boolean }>();
  // Per PR: the head commit whose first ci.workflow_failed was sent past the throttle (THROTTLE_EXEMPT_KINDS).
  const firstFailureFor = new Map<string, string>();
  // Across every PR: when each message of the session's current window was sent (at most limits.sessionEvents), and
  // when the one heldBack notice of a spent window was. Past the budget nothing is sent but that notice, once a window.
  let sessionSent: number[] = [];
  let heldBackAt = Number.NEGATIVE_INFINITY;
  let lastBeat = 0;
  const unsubscribe = (e: Entry, reason: string) => {
    subs.remove(e.repo, e.pr);
    events.write("unsubscribe", { repo: e.repo, pr: e.pr, source: e.source, reason });
    forgetEnded();
  };
  const send = async (message: ChannelMessage, change: Change | null, wanted = true, reason?: string, extra: Record<string, unknown> = {}) => {
    let fields = { ...eventFields(message, change), ...extra };
    if (!wanted) return events.write("event", { ...fields, outcome: "filtered", ...(reason ? { reason } : {}) });
    // This session's mutes (the mute tool, or an unsubscribed automatic watch): held back, and logged as such.
    if (change && subs.mutes.matching({ repo: change.snapshot.repo, pr: change.snapshot.pr, kind: change.kind, workflow: change.run ? clean(change.run.name) : "" })) {
      return events.write("event", { ...fields, outcome: "filtered", reason: "muted" });
    }
    sessionSent = sessionSent.filter((t) => now() - t < limits.sessionWindowMs);
    if (sessionSent.length >= limits.sessionEvents) {
      events.write("event", { ...fields, outcome: "filtered", reason: "budget" });
      if (now() - heldBackAt < limits.sessionWindowMs) return;
      heldBackAt = now();
      message = heldBack(limits.sessionWindowMs);
      fields = { ...eventFields(message, null), ...extra };
      return notifyAndLog(message, fields);
    }
    const meta = message.meta as Record<string, unknown>;
    if (typeof meta.repo === "string" && typeof meta.pr === "string") {
      const key = `${meta.repo.toLowerCase()}#${meta.pr}`;
      const recent = (sentAt.get(key) ?? []).filter((t) => now() - t < limits.eventWindowMs);
      sentAt.set(key, recent);
      const firstFailure = change?.kind === "ci.workflow_failed" && firstFailureFor.get(key) !== change.snapshot.headSha;
      const exempt = change !== null && ((THROTTLE_EXEMPT_KINDS as readonly string[]).includes(change.kind) || firstFailure);
      if (firstFailure && change) firstFailureFor.set(key, change.snapshot.headSha);
      if (!exempt && recent.length >= limits.eventsPerPr) {
        events.write("event", { ...fields, outcome: "filtered", reason: "throttled" });
        const held = throttledPrs.get(key);
        if (held?.noticed) return;
        throttledPrs.set(key, { noticed: true });
        message = throttled(meta.repo, meta.pr, limits.eventWindowMs);
        fields = { ...eventFields(message, null), ...extra };
      } else if (exempt && recent.length >= limits.eventsPerPr) {
        fields = { ...fields, throttle_exempt: true };
      }
      recent.push(now());
    }
    sessionSent.push(now());
    return notifyAndLog(message, fields);
  };
  async function notifyAndLog(message: ChannelMessage, fields: Record<string, unknown>): Promise<void> {
    try {
      await deps.notify(message);
      events.write("event", { ...fields, outcome: "sent" });
    } catch (error) {
      events.write("event", { ...fields, outcome: "error", error: (error as Error).message });
      throw error;
    }
  }
  const baseEveryMs = deps.baseEveryMs ?? BASE_EVERY_MS;
  const baseIdleMs = Math.max(baseEveryMs, deps.baseIdleMs ?? BASE_IDLE_MS);
  const now = deps.now ?? Date.now;
  const lookEvery = deps.lookEveryMs ?? lookEveryMs;
  /** Per watched PR: when it is next looked at, and what the cadence needs to know. */
  /** The rate limit's back-off, from the newest reading any session on this machine got (cadence.ts). */
  const pressure = () => ratePressure(gh.rateRemaining, gh.rateLimit);
  /**
   * At or below JOB_READS_FLOOR requests left (cadence.ts), no jobs and no annotations are read until GitHub's reset
   * voids the reading: they add detail to an event, and a running PR's own reads, still made while paused, need what
   * is left. A run's failure is still sent, without its failed jobs' names.
   */
  const atJobFloor = () => gh.rateRemaining !== null && gh.rateRemaining <= JOB_READS_FLOOR;
  let rateLevel: "normal" | "slowed" | "paused" = "normal";
  const looks = new Map<string, { next: number; quiet: number; phase: Phase; headSha: string; headSeenAt: number; runsReadAt: number }>();
  /**
   * Per watched PR in the folder's repository: the clone's `origin/<headRef>` at the last pass (git.ts `readPushed`,
   * and `pushed` for the folder's own branch), to tell the session's own push from any worktree of the clone.
   */
  const lastPushed = new Map<string, string | null>();
  /** Per watched PR: until when it is looked at every pass, after the session's own push to its branch. */
  const fastUntil = new Map<string, number>();
  const parents = deps.parents ?? new ForkParents(gh, now);
  let findLabel = "";
  let findSince = 0;
  let foundAt = Number.NEGATIVE_INFINITY;
  /** Per base: its verdict, when it was read, and each workflow's newest completed run so far. */
  const bases = new Map<string, { red: boolean; readAt: number; runs: BaseRunInfo[] }>();
  let saidProblem: GhProblem["kind"] | null = null;
  let lastScope = "";
  let saidScope = false;
  const misses = new Map<string, number>();
  const allDoneHoldMs = deps.allDoneHoldMs ?? PENDING_WINDOW_MS;
  /** Per PR: the head whose ci.run_all_done is held until the head has had its window (allDoneHoldMs). */
  const held = new Map<string, string>();
  /**
   * When a head's window to register workflows in began: the oldest run's creation on it (GitHub's time, near the
   * push), or this session's first sight of the head if that is earlier or no run says. Both are at or after the push,
   * so the earlier is the nearer. A session that subscribes mid-CI adds no wait of its own.
   */
  const holdFrom = (seenAt: number, snap: Snapshot): number => {
    let from = seenAt;
    for (const r of snap.runs) {
      const created = Date.parse(r.createdAt ?? "");
      if (Number.isFinite(created) && created < from) from = created;
    }
    return from;
  };
  /**
   * The pull requests found for the session's branch that somebody else opened: never watched automatically,
   * said once each (notYoursNotice), and not asked about again, since who opened a pull request does not change. At
   * most NOT_YOURS_KEPT, the oldest forgotten first; one forgotten is asked about, and said, once more.
   */
  const notYours = new Set<string>();
  /**
   * Whether the signed-in login opened a pull request found for the branch: "unknown" while GitHub does not say who is
   * signed in or does not show the pull request, which is not a yes and not a no. A pull request GitHub names no
   * author for is nobody's, so not the login's. One request for the login (kept for hours, github.ts) and one for the
   * pull request, which the watch's first look would have made anyway.
   */
  const openedByMe = async (repo: string, pr: number): Promise<"yes" | "no" | "unknown"> => {
    const login = await gh.viewerLogin();
    const me = login.kind === "ok" && login.value ? login.value.toLowerCase() : null;
    if (me === null) return "unknown";
    const pull = await gh.getPull(repo, pr);
    if (pull.kind !== "ok") return "unknown";
    return (pull.value.author ?? "").toLowerCase() === me ? "yes" : "no";
  };
  /** Per PR the hook handed over and not yet looked at: when the hook saw it (HOOK_NEW_MS). */
  const hookSeenAt = new Map<string, number>();

  const scopeEveryMs = deps.scopeEveryMs ?? SCOPE_EVERY_MS;
  const scopeLeaveMs = deps.scopeLeaveMs ?? SCOPE_LEAVE_MS;
  /** Per scoped repository: its open pull requests as last read (null before the first answer), and when to read again. */
  const discovered = new Map<string, { pulls: readonly OpenPull[] | null; full: boolean; next: number; saidCap: boolean; saidHidden: boolean }>();
  /** Per pull request a scope holds that left the open list: since when. Looked at every pass until its end is reported. */
  const leaving = new Map<string, number>();

  /**
   * THE SCOPES: for each repository scope, the repository's open pull requests (read at most every scopeEveryMs,
   * through the shared store, so several sessions of a project ask once), and from them the subscriptions the scope
   * holds. Three rules keep a scope from costing or saying more than the user chose:
   *
   * - IT NEVER UNDOES AN UNSUBSCRIBE. A pull request muted on its own (the mute tool, or the mute an unsubscribe
   *   leaves while a scope covers the repository) is not held. That mute ends when the pull request leaves the open
   *   list or the scope ends, so the list of mutes does not grow with every pull request ever unsubscribed.
   * - IT STAYS WITHIN THE SESSION'S CAP. Each held pull request is a watch like any other, with the same requests
   *   an hour, so a scope takes only the places nothing else has: the newest open pull requests first. What does
   *   not fit is counted, shown by list_subscriptions and said once (scopeCapped), never dropped without a word.
   * - A PULL REQUEST THAT LEAVES THE OPEN LIST IS LOOKED AT, NOT DROPPED: the look reports its merge or close once,
   *   like any watched pull request's, and that ends the subscription.
   *
   * The store is read again first: another session of the project may have set or ended a scope.
   */
  const checkScopes = async () => {
    const store = deps.scopes;
    if (!store) return;
    store.reload();
    for (const repo of store.takeNarrowed()) {
      events.write("scope_narrowed", { repo, from: "all", to: "mine" });
      await send(scopeNarrowed(repo), null);
    }
    const scopes = store.list();
    const scoped = new Set(scopes.map((s) => s.repo.toLowerCase()));
    for (const e of subs.list()) if (e.source === "scope" && !scoped.has(e.repo.toLowerCase())) unsubscribe(e, "scope_ended");
    for (const key of discovered.keys()) if (!scoped.has(key)) discovered.delete(key);
    for (const key of subs.scopeHoldings.keys()) if (!scoped.has(key)) subs.scopeHoldings.delete(key);
    subs.mutes.endScopeMutes((repo) => !scoped.has(repo.toLowerCase()));
    for (const scope of scopes) {
      if (signal.aborted) return;
      const key = scope.repo.toLowerCase();
      const p = pressure();
      let d = discovered.get(key) ?? { pulls: null, full: false, next: 0, saidCap: false, saidHidden: false };
      if (now() >= d.next && !p.pause) {
        const r = await gh.openPulls(scope.repo, scopeEveryMs > 0 ? scopeEveryMs - 1_000 : 0);
        if (r.kind === "auth") {
          await problem(r.auth);
          return;
        }
        if (r.kind === "ok") {
          d = { ...d, pulls: r.value.pulls, full: r.value.full, next: now() + scopeEveryMs * p.stretch, saidHidden: false };
        } else {
          events.write("api_error", { repo: scope.repo, result: r.kind, what: "scope", ...(r.kind === "retry" ? { reason: r.reason } : {}) });
          d = { ...d, next: now() + Math.max(scopeEveryMs, r.kind === "retry" ? (r.afterMs ?? 0) : 0) };
          if (r.kind === "not_found" && d.pulls === null) {
            subs.scopeHoldings.set(key, { held: [], leftOut: 0, more: false, problem: "GitHub does not show this repository to this GitHub login" });
            if (!d.saidHidden) {
              d = { ...d, saidHidden: true };
              discovered.set(key, d);
              await send(scopeNotVisible(scope.repo), null);
            }
          }
        }
        discovered.set(key, d);
      }
      if (d.pulls === null) continue;
      d = await holdScope(scope, key, { ...d, pulls: d.pulls });
      discovered.set(key, d);
    }
  };

  /** Makes the subscriptions a scope holds match its repository's open pull requests, as the rules above say. */
  const holdScope = async <D extends { pulls: readonly OpenPull[]; full: boolean; saidCap: boolean }>(scope: Scope, key: string, d: D): Promise<D> => {
    const mine = (e: Entry) => e.source === "scope" && e.repo.toLowerCase() === key;
    let me: string | null = null;
    if (scope.involves !== "all") {
      // Not known (GitHub did not say) is not a yes: nothing new is held, and what is held stays, until the login is known.
      const login = await gh.viewerLogin();
      me = login.kind === "ok" && login.value ? login.value.toLowerCase() : null;
      if (me === null) {
        const which = scope.involves === "mine" ? "you opened" : "involve you";
        subs.scopeHoldings.set(key, { held: subs.list().filter(mine).map((e) => e.pr), leftOut: 0, more: d.full, problem: `GitHub did not say which login is signed in, so the scope could not tell which pull requests ${which}` });
        return d;
      }
    }
    const open = new Set(d.pulls.map((p) => p.number));
    subs.mutes.endScopeMutes((repo, pr) => repo.toLowerCase() === key && !open.has(pr));
    // `mine`: the login opened it. `me`: the list names the login for it at all. `all`: asked for by name, everybody's.
    const inScope = (p: OpenPull) => scope.involves === "all" || (scope.involves === "mine" ? p.author === me : me !== null && p.involved.includes(me));
    const covered = d.pulls.filter((p) => inScope(p) && !subs.mutes.mutesPr(scope.repo, p.number));
    const coveredNumbers = new Set(covered.map((p) => p.number));
    for (const e of subs.list().filter(mine)) {
      if (coveredNumbers.has(e.pr)) {
        leaving.delete(e.key);
      } else if (!open.has(e.pr) && e.last !== null) {
        if (!leaving.has(e.key)) leaving.set(e.key, now());
        const look = looks.get(e.key);
        if (look) look.next = now();
      } else {
        unsubscribe(e, open.has(e.pr) ? (subs.mutes.mutesPr(e.repo, e.pr) ? "muted" : "scope_not_involved") : "scope_left");
      }
    }
    // The pull requests only the scope would watch: one Claude, the hook or the branch already watches keeps its own
    // subscription and takes no second place.
    const unowned = covered.filter((p) => {
      const e = subs.get(scope.repo, p.number);
      return !e || e.source === "scope";
    });
    const unownedNumbers = new Set(unowned.map((p) => p.number));
    const taken = subs.list().filter((e) => !(mine(e) && unownedNumbers.has(e.pr))).length;
    const hold = unowned.slice(0, Math.max(0, limits.total - taken));
    const holdNumbers = new Set(hold.map((p) => p.number));
    for (const e of subs.list().filter(mine)) if (unownedNumbers.has(e.pr) && !holdNumbers.has(e.pr)) unsubscribe(e, "scope_cap");
    for (const p of hold) {
      if (subs.get(scope.repo, p.number)) continue;
      subs.add({ repo: scope.repo, pr: p.number, source: "scope" });
      events.write("subscribe", { repo: scope.repo, pr: p.number, source: "scope", events: [...AUTO_EVENTS] });
    }
    const held = hold.map((p) => p.number);
    const leftOut = unowned.length - hold.length;
    // `hold` is cut from `unowned` to fit the room there is: it can be neither longer than it nor than the session's
    // limit, unless this code is wrong (faults.ts). The holdings are written as they were worked out either way.
    if (leftOut < 0) internalError("scope_holdings_negative");
    if (held.length > limits.total) internalError("scope_holdings_over_cap");
    subs.scopeHoldings.set(key, { held, leftOut, more: d.full, problem: null });
    if (leftOut === 0) return { ...d, saidCap: false };
    if (d.saidCap) return d;
    events.write("scope_capped", { repo: scope.repo, held: held.length, left_out: leftOut, total: limits.total });
    await send(scopeCapped(scope.repo, held, leftOut, limits.total), null);
    return { ...d, saidCap: true };
  };

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
      const look = looks.get(entry.key);
      const settled = look !== undefined && look.headSha === live.last.headSha && now() - holdFrom(look.headSeenAt, live.last) >= allDoneHoldMs && !held.has(entry.key);
      const { changes, keep } = reviewChanges(seen?.state ?? null, r.value, live.last, settled);
      reviews.set(entry.key, { state: keep, next: now() + reviewEveryMs * p.stretch });
      for (const change of changes) await send(await message(change), change, wants(live, change.kind));
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
    if (!JOB_KINDS.some((k) => wants(entry, k)) || atJobFloor()) return;
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
        await send(await message(full), full, wants(entry, change.kind));
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
      // A mute of one PR is not a mute of the base: said about, and naming, the PRs that want it and are not muted;
      // held back (by send) only when every one of them is.
      const heard = wanting.filter((e) => !subs.mutes.matching({ repo: e.repo, pr: e.pr, kind, workflow: "" }));
      const named = heard.length ? heard : wanting.length ? wanting : seen;
      const about = named[0];
      if (!about?.last) continue;
      const prs = [...new Set(named.map((e) => e.pr))].sort((a, b) => a - b);
      const change: Change = { kind, snapshot: about.last, failing: v.failing, prs, ...(v.at ? { at: v.at } : {}) };
      await send(await message(change), change, wanting.length > 0);
    }
  };

  /**
   * THE ONE PLACE A PR'S STATE IS DROPPED: every per-PR list loses each PR no longer watched, however its subscription
   * ended (merged, closed, gone, a branch switch, the tool's unsubscribe, the hook's screen). Run when the poller ends
   * a subscription, and at the start and end of every pass, which catches one the tool ended between passes. Without
   * it, a session that watched hundreds of PRs over days kept something of each.
   */
  function forgetEnded(): void {
    const watched = new Set(subs.list().map((e) => e.key));
    const perPr: Map<string, unknown>[] = [startedFor, sentAt, throttledPrs, firstFailureFor, misses, looks, reviews, jobsSeen, hookSeenAt, held, leaving];
    for (const map of perPr) for (const key of map.keys()) if (!watched.has(key)) map.delete(key);
    // A hook's hand-over time matters only while the hook's own subscription stands (Claude's subscribe outranks it).
    for (const key of hookSeenAt.keys()) if (!subs.list().some((e) => e.key === key && e.source === "hook")) hookSeenAt.delete(key);
  }

  deps.sizes?.(() => ({
    startedFor: startedFor.size,
    sentAt: sentAt.size,
    misses: misses.size,
    looks: looks.size,
    fastUntil: fastUntil.size,
    reviews: reviews.size,
    jobsSeen: jobsSeen.size,
    hookSeenAt: hookSeenAt.size,
    held: held.size,
    leaving: leaving.size,
    discovered: discovered.size,
    notYours: notYours.size,
    bases: bases.size,
    requestIds: requests.seen?.ids.size ?? 0,
    etagEntries: gh.etagEntries,
  }));

  while (!signal.aborted) {
    let waitMs = config.pollSeconds * 1000;
    let retryMs = 0; // GitHub's own wait, from a rate-limited answer: a floor for this pass's sleep, never stretched
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
    // No branch is no change: git answers none mid-rebase and nothing at all when it times out, and taking either for
    // a branch switch ended the branch's mutes, unwatched its pull request and dropped a held all done.
    if (config.autoSubscribe === "pr" && scope?.branch) {
      const label = `${scope.repo ?? "(no GitHub remote)"}@${scope.branch}`;
      if (label !== lastScope) {
        log(`session folder is on ${label}`);
        lastScope = label;
      }
      let current: string | null = null;
      if (label !== findLabel) {
        // A branch change ends the mute an unsubscribed automatic watch left: the new branch's PR is news again.
        if (findLabel) subs.mutes.endBranchMutes();
        findLabel = label;
        findSince = now();
        foundAt = Number.NEGATIVE_INFINITY;
      }
      // The branch's PR is looked for only while none is watched: every minute for five minutes after a branch
      // change, then every five. A watched one that merges or closes is unwatched below, and the looking resumes.
      // The branch's PR is one in the clone's own repository, or, in a fork, one on the repository it was forked from
      // whose head is the clone's own repository (forks.ts): both have this branch as their head.
      const repo = scope.repo?.toLowerCase();
      const branchPr = (e: Entry) => e.last?.headRef === scope.branch && (e.repo.toLowerCase() === repo || e.last.headRepo?.toLowerCase() === repo);
      const watched = subs.list().some((e) => e.source === "auto" && e.last?.state === "open" && branchPr(e));
      const findEvery = now() - findSince < 5 * 60_000 ? lookEvery("pending", 0, 0) : lookEvery("finished", 0, 99);
      if (scope.repo && scope.branch && (watched || pressure().pause || now() - foundAt < findEvery * pressure().stretch)) {
        current = "keep";
      } else if (scope.repo && scope.branch) {
        foundAt = now();
        // In a fork: on the repository it was forked from first, then here (forks.ts).
        const found = await findBranchPull(gh, { repo: scope.repo, branch: scope.branch, upstream: scope.upstream }, parents);
        if (found.kind === "auth") {
          await problem(found.auth);
          await sleep(waitMs, signal);
          continue;
        }
        if (found.kind === "ok" && found.value !== null && subs.mutes.mutesPr(found.value.repo, found.value.pr)) {
          current = null; // muted in this session (the mute tool, or unsubscribed): never added back
        } else if (found.kind === "ok" && found.value !== null) {
          // ONLY THE USER'S OWN: the branch can be a colleague's (`gh pr checkout`), and their pull request
          // carries their text into the session. One already watched because it was asked for (Claude's subscribe, the
          // hook's hand-over of a pull request this login just opened) or already taken as the branch's own stays as it
          // is; any other is watched only when the signed-in login opened it.
          const f = found.value;
          const key = `${f.repo.toLowerCase()}#${f.pr}`;
          const existing = subs.get(f.repo, f.pr);
          const settled = existing !== undefined && existing.source !== "scope";
          const mine = settled ? "yes" : notYours.has(key) ? "no" : await openedByMe(f.repo, f.pr);
          if (mine === "yes") {
            current = subs.add({ repo: f.repo, pr: f.pr, source: "auto" }).key;
            if (!existing) events.write("subscribe", { repo: f.repo, pr: f.pr, source: "auto", events: [...AUTO_EVENTS] });
          } else if (mine === "unknown") {
            current = "keep"; // not a yes and not a no: nothing changes, and it is decided again the next time the branch's PR is looked for
          } else {
            current = null;
            if (!notYours.has(key)) {
              notYours.add(key);
              for (const oldest of notYours) {
                if (notYours.size <= NOT_YOURS_KEPT) break;
                notYours.delete(oldest);
              }
              events.write("auto_skipped", { repo: f.repo, pr: f.pr, reason: "not_mine" });
              // One an explicit scope already holds is watched because the user asked for everybody's: nothing to say.
              if (!existing) await send(notYoursNotice(f.repo, f.pr), null);
            }
          }
        } else if (found.kind !== "ok") {
          current = "keep"; // GitHub did not answer: leave the automatic subscription as it is
        }
      }
      if (current !== "keep") {
        for (const e of subs.list()) {
          if (e.source !== "auto" || e.key === current) continue;
          // No open PR for this branch any more, but this entry IS the branch's PR: it was just merged or
          // closed. Keep it for this pass so the merge is reported; the poll below ends it.
          const sameBranch = current === null && branchPr(e);
          if (!sameBranch) unsubscribe(e, "branch_switch");
        }
      }
    }

    // THE SESSION'S OWN PUSH: `git push` moves origin/<branch> in the clone, from the session's folder or from any git
    // worktree of it (worktrees share refs/remotes). Each open watched PR in the folder's repository has its
    // origin/<headRef> read at every pass, all in one local git read and never a GitHub request; the PR whose ref
    // moved is then looked at this pass, and every pass for OWN_PUSH_FAST_MS, so the push is seen within a pass and
    // its CI's first result at the poll interval, not after a settled PR's five-minute wait. Only that PR: one PR's
    // push does not quicken the others. A `git fetch` that moves a ref counts too (it is cheap, and usually means
    // someone just pushed). The first reading of each PR's ref is a baseline; a ref that appears is a push.
    if (scope?.repo) {
      const repo = scope.repo.toLowerCase();
      const t = now();
      for (const [key, until] of fastUntil) if (until <= t) fastUntil.delete(key);
      // A fork's pull request on another repository has its head here too: `git push` to origin is a push to it.
      const open = subs.list().filter((e) => (e.repo.toLowerCase() === repo || e.last?.headRepo?.toLowerCase() === repo) && e.last?.state === "open" && e.last.headRef);
      const refs = deps.readPushed && open.length > 0 ? await deps.readPushed([...new Set(open.map((e) => e.last?.headRef ?? ""))]) : null;
      const reading = (headRef: string): string | null | undefined => {
        // The folder's own branch, as readScope read it this pass; any other branch, as readPushed did. undefined: no
        // reading this pass (git did not answer, or nothing reads it), which leaves the baseline as it was.
        if (scope.branch === headRef && scope.pushed !== undefined) return scope.pushed;
        return refs?.has(headRef) ? (refs.get(headRef) ?? null) : undefined;
      };
      const seen = new Set<string>();
      for (const e of open) {
        seen.add(e.key);
        const sha = reading(e.last?.headRef ?? "");
        if (sha === undefined) continue;
        const was = lastPushed.get(e.key);
        if (was !== undefined && sha && sha !== was) {
          fastUntil.set(e.key, t + OWN_PUSH_FAST_MS);
          const look = looks.get(e.key);
          if (look) look.next = t;
        }
        lastPushed.set(e.key, sha);
      }
      // A PR no longer watched, closed or in another repository loses its baseline: watched again, its first reading
      // is a baseline again.
      for (const key of lastPushed.keys()) if (!seen.has(key)) lastPushed.delete(key);
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
      // The session's own repository, or, when the clone is a fork, the repository it was forked from, as far as that
      // is already known (the upstream remote, or what GitHub answered when the branch's pull request was looked for).
      const sessionRepos = scope?.repo ? [scope.repo, parents.knownParent(scope)] : [];
      if (!sessionRepos.some((r) => r?.toLowerCase() === req.repo.toLowerCase())) {
        refuse("other_repo");
        continue;
      }
      const all = subs.list();
      // A scope only fills the places nobody asked for: at the cap, its oldest pull request makes room for the hook's.
      const room = all.length < limits.total ? null : subs.oldestScopeEntry();
      if ((all.length >= limits.total && !room) || all.filter((x) => x.source === "hook").length >= limits.hook) {
        refuse("cap");
        continue;
      }
      if (room) unsubscribe(room, "scope_cap");
      const e = subs.add({ repo: req.repo, pr: req.pr, source: "hook" });
      hookSeenAt.set(e.key, req.at);
      events.write("subscribe", { repo: req.repo, pr: req.pr, source: "hook", events: [...AUTO_EVENTS] });
    }
    await checkScopes();
    forgetEnded();
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
        if (r.afterMs) retryMs = Math.max(retryMs, r.afterMs);
        continue;
      }
      if (r.kind === "not_found") {
        const missed = (misses.get(entry.key) ?? 0) + 1;
        misses.set(entry.key, missed);
        events.write("api_error", { repo: entry.repo, pr: entry.pr, result: "not_found", misses: missed });
        if (missed < NOT_FOUND_LIMIT) continue;
        misses.delete(entry.key);
        const live = subs.get(entry.repo, entry.pr);
        if (!live) continue;
        // A URL the hook lifted from tool output that GitHub has never shown is not a PR this session lost: a test
        // fixture or a plan can name a PR number that does not exist, and every read of it handed the same URL over
        // again, each time ending in a "no longer shows" notice. Never watched, so dropped as the hook's other screens drop.
        if (live.source === "hook" && live.last === null) {
          unsubscribe(live, "hook_not_found");
          continue;
        }
        unsubscribe(live, "not_visible");
        await send(notVisible(live), null);
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
        // A PR whose head is the session's own repository: one in it, or a fork's on the repository it was forked from.
        scope?.repo &&
        (scope.repo.toLowerCase() === entry.repo.toLowerCase() || scope.repo.toLowerCase() === snap.headRepo?.toLowerCase()) &&
        (await deps.inOwnHistory(snap.headSha)) === false
      ) {
        changes.unshift({ kind: "pr.head_moved", snapshot: snap, ...(snap.updatedAt ? { at: snap.updatedAt } : {}) });
      }
      // ALL DONE IS NEVER EARLY: every run listed so far being done is not all done while the head is new, since a
      // slow workflow can register after a fast one has finished. Held until the head has been watched for
      // allDoneHoldMs, re-made from the snapshot then, and dropped if a run is unfinished meanwhile (its finish
      // makes a new one) or the head moves.
      const headSeenAt = look && look.headSha === snap.headSha ? look.headSeenAt : now();
      {
        const at = changes.findIndex((c) => c.kind === "ci.run_all_done");
        const early = now() - holdFrom(headSeenAt, snap) < allDoneHoldMs;
        if (at >= 0 && early) {
          changes.splice(at, 1);
          held.set(entry.key, snap.headSha);
        } else if (at >= 0) {
          held.delete(entry.key);
        } else if (held.has(entry.key)) {
          const unfinished = snap.state !== "open" || held.get(entry.key) !== snap.headSha || snap.runs.some((r) => r.status !== "completed");
          if (unfinished) held.delete(entry.key);
          else if (!early) {
            held.delete(entry.key);
            const all = allDoneChange(snap);
            if (all) changes.push(all);
          }
        }
      }
      const starts = changes.filter((c) => c.kind === "ci.workflow_started");
      const startKey = `${entry.repo.toLowerCase()}#${entry.pr}`;
      const startedAlready = startedFor.get(startKey) === snap.headSha;
      if (starts.length) startedFor.set(startKey, snap.headSha);
      for (let change of changes) {
        if (change.kind === "ci.workflow_started") {
          if (startedAlready || change !== starts[0]) {
            await send(await message(change), change, false, "collapsed");
            continue;
          }
          change = { ...change, workflows: starts.length };
        }
        if (!wants(live, change.kind)) {
          await send(await message(change), change, false);
          continue;
        }
        const full = atJobFloor() ? change : await withFailedJobs(gh, change);
        await send(await message(full), full);
      }
      if (snap.state === "open") await checkJobs(live, snap);
      if (first && live.source === "auto" && needsAttention(snap)) await send(currentState(snap), null);
      {
        const t = now();
        // A held all done keeps the PR pending: looked at every minute, its runs read fresh, until it is said.
        const phase = held.has(entry.key) ? "pending" : phaseOf(snap, headSeenAt, t);
        const quiet = changes.length === 0 && look?.phase === "finished" && phase === "finished" ? look.quiet + 1 : 0;
        const runsReadAt = look && reuse !== null && snap.runs === reuse.runs ? look.runsReadAt : t;
        const pollMs = config.pollSeconds * 1000;
        // After the session's own push, every pass for OWN_PUSH_FAST_MS, whatever the phase.
        const every = (fastUntil.get(entry.key) ?? 0) > t ? Math.min(pollMs, lookEvery(phase, pollMs, quiet)) : lookEvery(phase, pollMs, quiet);
        looks.set(entry.key, { next: t + every * pressure().stretch, quiet, phase, headSha: snap.headSha, headSeenAt, runsReadAt });
      }
      live.last = carry(live.last, snap);
      if (snap.state !== "open") unsubscribe(live, snap.state);
      // Gone from its scope's open list, and GitHub still calls it open after the wait: past the list's first page.
      else if (live.source === "scope" && leaving.has(live.key) && now() - (leaving.get(live.key) ?? 0) >= scopeLeaveMs) unsubscribe(live, "scope_left");
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

    // A throttled PR whose window has room again: one summary of the state it reached while held back.
    for (const key of [...throttledPrs.keys()]) {
      const recent = (sentAt.get(key) ?? []).filter((t) => now() - t < limits.eventWindowMs);
      if (recent.length >= limits.eventsPerPr) continue;
      throttledPrs.delete(key);
      const last = subs.list().find((e) => e.key === key)?.last;
      if (last && last.state === "open") await send(resumed(last), null);
    }

    forgetEnded();
    if (Date.now() - lastBeat >= heartbeatMs) beat();

    // The newest reading, this pass's answers included.
    const resetAt = gh.rateResetAt;
    let left = passSleepMs({
      pollMs: waitMs,
      factor: Math.max(belowFloor() ? 4 : 1, pressure().stretch),
      retryMs,
      msToReset: resetAt === null ? null : resetAt - Date.now(),
    });
    // A long wait (a spent limit) is slept in heartbeat-sized pieces, with a heartbeat after each: one sleep of a
    // quarter of an hour wrote nothing, and the session looked dead.
    while (left > 0 && !signal.aborted) {
      const piece = Math.min(left, Math.max(heartbeatMs, 1000));
      await sleep(piece, signal);
      left -= piece;
      if (left > 0 && !signal.aborted) beat(left);
    }
  }

  /**
   * The message for a change. A failure's wording depends on whose PR it is (format.ts `notYours`), so for the two
   * failure kinds the signed-in login is looked up; the client caches it for hours, so this costs a request a session.
   */
  async function message(change: Change): Promise<ChannelMessage> {
    if (change.kind !== "ci.workflow_failed" && change.kind !== "ci.job_failed") return toMessage(change);
    const me = await gh.viewerLogin();
    return toMessage(change, me.kind === "ok" ? me.value : null);
  }

  function beat(waitingMs?: number): void {
    lastBeat = Date.now();
    events.write("heartbeat", {
      subscriptions: subs.list().length,
      watching: subs.list().map((e) => `${e.repo}#${e.pr}`),
      rate_remaining: gh.rateRemaining,
      rate_limit: gh.rateLimit,
      graphql_remaining: gh.graphqlRemaining,
      requests: { ...gh.requests },
      ...(waitingMs !== undefined ? { waiting_ms: Math.round(waitingMs) } : {}),
    });
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
