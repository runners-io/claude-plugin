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
import { type Phase, RUNS_EVERY_MS, lookEveryMs, phaseOf } from "./cadence.ts";
import { type ChannelMessage, clean, describe, scopeMessage, setupMessage, toMessage } from "./format.ts";
import type { GitScope } from "./git.ts";
import { type EventLog, NO_EVENT_LOG } from "./eventlog.ts";
import type { ApiResult, GhProblem, GitHubClient } from "./github.ts";
import { log } from "./log.ts";
import { baseVerdict } from "./rules.mjs";
import { type Change, type EventKind, type Snapshot, carry, diff, needsAttention } from "./state.ts";
import { type Entry, type Subscriptions, wants } from "./subscriptions.ts";

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

export async function runPoller(deps: PollerDeps): Promise<void> {
  const { config, gh, subs, signal } = deps;
  // The head commit each PR's ci.workflow_started was last sent for: a push starts many workflows, and one
  // event per workflow was eight in a burst for one push. The rest are logged as collapsed.
  const startedFor = new Map<string, string>();
  const sleep = deps.sleep ?? realSleep;
  const events = deps.eventLog ?? NO_EVENT_LOG;
  const heartbeatMs = deps.heartbeatMs ?? 300_000;
  let lastBeat = 0;
  const unsubscribe = (e: Entry, reason: string) => {
    subs.remove(e.repo, e.pr);
    events.write("unsubscribe", { repo: e.repo, pr: e.pr, source: e.source, reason });
  };
  const send = async (message: ChannelMessage, change: Change | null, wanted = true, reason?: string) => {
    const fields = eventFields(message, change);
    if (!wanted) return events.write("event", { ...fields, outcome: "filtered", ...(reason ? { reason } : {}) });
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
  const looks = new Map<string, { next: number; quiet: number; phase: Phase; headSha: string; headSeenAt: number; runsReadAt: number }>();
  let findLabel = "";
  let findSince = 0;
  let foundAt = Number.NEGATIVE_INFINITY;
  const bases = new Map<string, { red: boolean; readAt: number }>();
  let saidProblem: GhProblem["kind"] | null = null;
  let lastScope = "";
  let saidScope = false;
  const misses = new Map<string, number>();

  const problem = async (p: GhProblem) => {
    if (saidProblem !== p.kind) {
      saidProblem = p.kind;
      log(`no usable GitHub login: ${p.kind}`);
      events.write("problem", { kind: p.kind });
      await send(setupMessage(p), null);
    }
  };

  const BASE_KINDS: EventKind[] = ["base.red", "base.green"];
  /** Each base branch a subscription wants news of, read at most every `baseEveryMs`; red <-> green is pushed. */
  const checkBases = async () => {
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
      if (known && now() - known.readAt < (busy ? baseEveryMs : baseIdleMs)) continue;
      const first = entries[0];
      const base = first.last?.baseRef as string;
      const r = await gh.baseRuns(first.repo, base, baseEveryMs);
      if (r.kind !== "ok") {
        if (r.kind === "retry") events.write("api_error", { repo: first.repo, base, result: "retry", reason: r.reason });
        continue;
      }
      const v = baseVerdict(r.value);
      bases.set(key, { red: v.red, readAt: now() });
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
    gh.freshMs = belowFloor() ? waitMs * 4 : waitMs;
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
      if (scope.repo && scope.branch && (watched || now() - foundAt < findEvery)) {
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

    for (const key of looks.keys()) if (!subs.list().some((e) => e.key === key)) looks.delete(key);
    for (const entry of subs.list()) {
      if (signal.aborted) break;
      const look = looks.get(entry.key);
      if (look && now() < look.next) continue;
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
      if (first && live.source === "auto" && needsAttention(snap)) await send(currentState(snap), null);
      {
        const t = now();
        const headSeenAt = look && look.headSha === snap.headSha ? look.headSeenAt : t;
        const phase = phaseOf(snap, headSeenAt, t);
        const quiet = changes.length === 0 && look?.phase === "finished" && phase === "finished" ? look.quiet + 1 : 0;
        const runsReadAt = look && reuse !== null && snap.runs === reuse.runs ? look.runsReadAt : t;
        looks.set(entry.key, { next: t + lookEvery(phase, config.pollSeconds * 1000, quiet), quiet, phase, headSha: snap.headSha, headSeenAt, runsReadAt });
      }
      live.last = carry(live.last, snap);
      if (snap.state !== "open") unsubscribe(live, snap.state);
    }

    await checkBases();

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
        requests: { ...gh.requests },
      });
    }

    if (belowFloor()) waitMs *= 4; // the newest reading, this pass's answers included
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
    workflow: change.run?.name ?? null,
    conclusion: change.run?.conclusion ?? change.conclusion ?? null,
    github_at: at ?? null,
    latency_ms: at ? Math.max(0, Date.now() - Date.parse(at)) : null,
    ...(change.labelsAdded
      ? { labels_added: change.labelsAdded.map((l) => clean(l, 40)), labels_removed: (change.labelsRemoved ?? []).map((l) => clean(l, 40)) }
      : {}),
    ...(change.failing ? { failing: change.failing, base: s.baseRef ?? null } : {}),
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
