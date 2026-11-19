/**
 * A subscribed pull request as the channel last saw it, and what changed
 * between two looks. Pure: no I/O, so every rule here is a unit test.
 *
 * THE FIRST LOOK IS A BASELINE. `diff(null, s)` is empty: subscribing tells
 * Claude the current state in the tool's answer, and the channel then pushes
 * only what changes. A session never gets a burst of yesterday's results.
 *
 * RUNS ARE COMPARED FOR THE SAME HEAD SHA ONLY. A push resets them, so the
 * new commit's workflows are reported as they start and finish, and "all
 * done" is never declared over a mix of two commits.
 */
import type { RunInfo } from "./github.ts";

export const EVENT_KINDS = [
  "ci.workflow_started",
  "ci.workflow_succeeded",
  "ci.workflow_failed",
  "ci.workflow_cancelled",
  "ci.approval_waiting",
  "ci.run_all_done",
  "ci.job_failed",
  "ci.job_stuck_queued",
  "pr.conflict",
  "pr.conflict_resolved",
  "pr.merged",
  "pr.closed",
  "pr.head_moved",
  "pr.labels_changed",
  "pr.ready_for_review",
  "pr.converted_to_draft",
  "pr.body_edited",
  "ci.flaky",
  "base.red",
  "base.green",
  "pr.approved",
  "pr.changes_requested",
  "pr.review_thread_added",
  "pr.review_thread_resolved",
  "pr.ready_to_merge",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

export interface Snapshot {
  readonly repo: string;
  readonly pr: number;
  readonly state: "open" | "merged" | "closed";
  readonly headSha: string;
  readonly headRef: string;
  /** GitHub's `mergeable_state`: `dirty` is a conflict, `unknown` is "still computing". */
  readonly mergeableState: string;
  /**
   * GitHub's `mergeable_state` as it answered (clean, has_hooks, blocked, behind, dirty, unstable, draft or unknown),
   * for whether the PR may be ready to merge. `mergeableState` above folds it to a conflict or not.
   */
  readonly mergeStatus?: string;
  readonly prUrl: string;
  readonly runs: readonly RunInfo[];
  /** When the PR was merged or closed, GitHub's time. */
  readonly closedAt?: string;
  /** When the PR was opened (GitHub's time); read only to screen a PR the hook handed over. */
  readonly createdAt?: string;
  /** Who opened it: screens a PR the hook handed over, and decides a failure's wording (format.ts `notYours`). */
  readonly author?: string;
  /** The head branch's repository: another repository than `repo` is a fork, whose CI logs a stranger can write. */
  readonly headRepo?: string;
  /** When GitHub last changed the PR, for the latency of a label, draft or body change. */
  readonly updatedAt?: string;
  readonly baseRef?: string;
  readonly draft?: boolean;
  /** Label names. Absent when not read, which is never a change. */
  readonly labels?: readonly string[];
  /** A hash of the PR's body, never the body: the body is untrusted text and only its change is reported. */
  readonly bodyHash?: string | null;
  /** Run id -> the attempt that failed, for this head sha only (carried by `carry`), to tell a flaky re-run. */
  readonly failedAttempts?: Readonly<Record<number, number>>;
}

export interface Change {
  readonly kind: EventKind;
  readonly snapshot: Snapshot;
  /** The run the change is about, for the `ci.workflow_*` and approval kinds. */
  readonly run?: RunInfo;
  /**
   * For `ci.approval_waiting`: what it waits for. `deployment`: a job is held for an environment's required reviewers (the
   * run's status is waiting). `maintainer`: a fork's or a first-time contributor's run waits for a maintainer to approve
   * it (the run completed as action_required). One sentence for both told the user a deployment waited when none existed.
   */
  readonly approval?: "deployment" | "maintainer";
  /** Filled in by the poller for a failed run, from the run's jobs. */
  readonly failedJobs?: readonly string[];
  /** For `ci.run_all_done`: failure, cancelled or success, the worst of the runs. */
  readonly conclusion?: string;
  /** For `ci.run_all_done`: the names of the workflows that failed, in the order GitHub lists them. */
  readonly failedWorkflows?: readonly string[];
  /** For `ci.run_all_done`: the names of the workflows that were cancelled. */
  readonly cancelledWorkflows?: readonly string[];
  readonly labelsAdded?: readonly string[];
  readonly labelsRemoved?: readonly string[];
  /** For `base.red` and `base.green`: every watched PR on that base, the event being about the base, not one PR. */
  readonly prs?: readonly number[];
  /** For `base.red`: the base branch's failing workflows. */
  readonly failing?: readonly string[];
  /** For ci.job_failed and ci.job_stuck_queued (jobs.ts): the job; never an annotation's message. */
  readonly job?: {
    readonly id: number;
    readonly name: string;
    readonly labels: readonly string[];
    readonly url?: string;
    readonly queuedSeconds?: number;
    readonly annotations?: readonly { readonly path: string; readonly line: number | null; readonly level: string }[];
  };
  /** For the review kinds (reviews.ts): who, file:line, links and counts; never a review's or a comment's text. */
  readonly review?: {
    readonly login?: string;
    readonly authorType?: "bot" | "member" | "outside";
    readonly path?: string;
    readonly line?: number | null;
    readonly url?: string;
    readonly unresolved?: number;
    readonly mergeState?: string;
    readonly decision?: string;
  };
  /** For `ci.workflow_started`: how many workflows started on this head commit in the same read. */
  readonly workflows?: number;
  /** GitHub's (or a local log's) time for the change, when the snapshot's own times do not give it. */
  readonly at?: string;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
/**
 * A fork's run held until a maintainer approves it: there is no log to read, so it is an approval wait,
 * never a failure.
 */
const NEEDS_APPROVAL = "action_required";
const PASSED = new Set(["success", "neutral"]);
/** Conclusions that are neither a pass nor a failure and are not reported at all. */
const IGNORED = new Set(["skipped", "stale"]);

export type Outcome = "failed" | "succeeded" | "cancelled" | "needs_approval" | "ignored";

export function outcome(conclusion: string | null): Outcome {
  if (conclusion && FAILED.has(conclusion)) return "failed";
  if (conclusion && PASSED.has(conclusion)) return "succeeded";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === NEEDS_APPROVAL) return "needs_approval";
  if (conclusion && IGNORED.has(conclusion)) return "ignored";
  return "failed"; // an unknown conclusion on a completed run is not a pass
}

const done = (r: RunInfo) => r.status === "completed";
const allDone = (runs: readonly RunInfo[]) => runs.length > 0 && runs.every(done);

/** A run started over: a new attempt, or a completed run running again. */
function restarted(prev: RunInfo, next: RunInfo): boolean {
  return next.runAttempt !== prev.runAttempt || (done(prev) && !done(next));
}

export function diff(prev: Snapshot | null, next: Snapshot): Change[] {
  if (!prev) return [];
  if (next.state === "merged" && prev.state !== "merged") return [{ kind: "pr.merged", snapshot: next }];
  if (next.state === "closed" && prev.state !== "closed") return [{ kind: "pr.closed", snapshot: next }];
  if (next.state !== "open") return [];

  const changes: Change[] = [];
  const before = new Map(prev.headSha === next.headSha ? prev.runs.map((r) => [r.id, r] as const) : []);
  let anyRunChanged = false;

  for (const run of next.runs) {
    const old = before.get(run.id);
    const fresh = !old || restarted(old, run);
    if (done(run)) {
      if (!fresh && old && done(old)) continue;
      anyRunChanged = true;
      const o = outcome(run.conclusion);
      if (o === "ignored") continue;
      const kind =
        o === "failed"
          ? "ci.workflow_failed"
          : o === "succeeded"
            ? "ci.workflow_succeeded"
            : o === "needs_approval"
              ? "ci.approval_waiting"
              : "ci.workflow_cancelled";
      changes.push(kind === "ci.approval_waiting" ? { kind, snapshot: next, run, approval: "maintainer" } : { kind, snapshot: next, run });
      const failedAttempt = prev.headSha === next.headSha ? prev.failedAttempts?.[run.id] : undefined;
      if (o === "succeeded" && failedAttempt !== undefined && run.runAttempt > failedAttempt) {
        changes.push({ kind: "ci.flaky", snapshot: next, run });
      }
      continue;
    }
    if (run.status === "waiting") {
      if (fresh || old?.status !== "waiting") {
        anyRunChanged = true;
        changes.push({ kind: "ci.approval_waiting", snapshot: next, run, approval: "deployment" });
      }
      continue;
    }
    if (fresh) {
      anyRunChanged = true;
      changes.push({ kind: "ci.workflow_started", snapshot: next, run });
    }
  }

  if (anyRunChanged) {
    const all = allDoneChange(next);
    if (all) changes.push(all);
  }

  if (next.mergeableState !== "unknown" && next.mergeableState !== prev.mergeableState) {
    if (next.mergeableState === "dirty") changes.push({ kind: "pr.conflict", snapshot: next });
    else if (prev.mergeableState === "dirty") changes.push({ kind: "pr.conflict_resolved", snapshot: next });
  }

  if (prev.draft !== undefined && next.draft !== undefined && prev.draft !== next.draft) {
    changes.push({ kind: next.draft ? "pr.converted_to_draft" : "pr.ready_for_review", snapshot: next });
  }
  if (prev.labels && next.labels) {
    const was = new Set(prev.labels);
    const now = new Set(next.labels);
    const labelsAdded = [...now].filter((l) => !was.has(l)).sort();
    const labelsRemoved = [...was].filter((l) => !now.has(l)).sort();
    if (labelsAdded.length || labelsRemoved.length) changes.push({ kind: "pr.labels_changed", snapshot: next, labelsAdded, labelsRemoved });
  }
  if (prev.bodyHash != null && next.bodyHash != null && prev.bodyHash !== next.bodyHash) {
    changes.push({ kind: "pr.body_edited", snapshot: next });
  }
  return changes;
}

/**
 * The snapshot to keep for next time. GitHub answers `unknown` while it
 * recomputes mergeability after every push; keeping the last known value
 * through it stops a still-conflicted PR from being reported twice.
 */
export function carry(prev: Snapshot | null, next: Snapshot): Snapshot {
  const failedAttempts: Record<number, number> = { ...(prev && prev.headSha === next.headSha ? prev.failedAttempts : {}) };
  for (const r of next.runs) if (done(r) && outcome(r.conclusion) === "failed") failedAttempts[r.id] = r.runAttempt;
  const kept = { ...next, failedAttempts };
  if (prev && next.mergeableState === "unknown") return { ...kept, mergeableState: prev.mergeableState };
  return kept;
}

/**
 * The ci.run_all_done for a snapshot whose runs have all finished, or null while any has not. `workflows` is how many
 * were reported on, so the event can say "all 3 succeeded" or "1 of 3 did not". A workflow that starts later on the
 * same head is a new run: its finish is a change, and all done is said again. The poller holds it until the head has
 * had its window to register workflows (poller.ts), since every run listed so far being done is not all done.
 */
export function allDoneChange(next: Snapshot): Change | null {
  if (!allDone(next.runs)) return null;
  const reported = next.runs.filter((r) => outcome(r.conclusion) !== "ignored");
  const has = (o: Outcome) => reported.some((r) => outcome(r.conclusion) === o);
  const worst = has("failed") ? "failure" : has("needs_approval") ? NEEDS_APPROVAL : has("cancelled") ? "cancelled" : "success";
  const failedWorkflows = reported.filter((r) => outcome(r.conclusion) === "failed").map((r) => r.name);
  const cancelledWorkflows = reported.filter((r) => outcome(r.conclusion) === "cancelled").map((r) => r.name);
  return { kind: "ci.run_all_done", snapshot: next, conclusion: worst, failedWorkflows, cancelledWorkflows, workflows: reported.length };
}

export function needsAttention(s: Snapshot): boolean {
  return (
    s.mergeableState === "dirty" ||
    s.runs.some((r) => r.status === "waiting" || (done(r) && ["failed", "needs_approval"].includes(outcome(r.conclusion))))
  );
}
