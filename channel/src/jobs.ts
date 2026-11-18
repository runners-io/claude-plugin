/**
 * Job events, from the REST jobs of a watched pull request's runs that have not finished (poller.ts):
 *
 *   ci.job_failed        a job failed while its run is still going: the early warning, minutes before
 *                        ci.workflow_failed, with its annotations' file:line (one more read, once per failed job).
 *   ci.job_stuck_queued  a job has waited STUCK_AFTER_MS for a runner: usually no runner has its labels.
 *
 * Each is sent once per job. The first read of a pull request's jobs is a baseline, so a session that starts
 * watching mid-run is not told what it already would have been told. A cancelled job is not a failure (a matrix
 * cancels its siblings), and a job waiting for an environment's approval is ci.approval_waiting, never stuck.
 *
 * NO ANNOTATION MESSAGE. An annotation's message and title are build output from whoever pushed the commit. Only
 * the path, the line and the level leave here; Claude reads the log itself.
 */
import type { RunInfo } from "./github.ts";
import type { Change, Snapshot } from "./state.ts";

export const STUCK_AFTER_MS = 5 * 60_000;
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export interface JobInfo {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly labels: readonly string[];
  readonly url: string;
}

export interface Annotation {
  readonly path: string;
  readonly line: number | null;
  readonly level: string;
}

/** What one read leaves for the next: the jobs already reported failed or stuck. */
export interface JobsSeen {
  readonly failed: ReadonlySet<number>;
  readonly stuck: ReadonlySet<number>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parseJobs(body: unknown): JobInfo[] {
  const list = Array.isArray(obj(body).jobs) ? (obj(body).jobs as unknown[]).map(obj) : [];
  return list
    .filter((j) => typeof j.id === "number")
    .map((j) => ({
      id: j.id as number,
      name: str(j.name) ?? "a job",
      status: str(j.status) ?? "queued",
      conclusion: str(j.conclusion),
      createdAt: str(j.created_at),
      startedAt: str(j.started_at),
      labels: Array.isArray(j.labels) ? (j.labels as unknown[]).filter((l): l is string => typeof l === "string") : [],
      url: str(j.html_url) ?? "",
    }));
}

export function parseAnnotations(body: unknown): Annotation[] {
  return (Array.isArray(body) ? body.map(obj) : []).map((a) => ({
    path: str(a.path) ?? "",
    line: typeof a.start_line === "number" ? a.start_line : null,
    level: str(a.annotation_level) ?? "notice",
  }));
}

/**
 * How long a job has waited for a runner. By its status alone: GitHub sets started_at on a job that is still
 * queued (equal to created_at, seen live), so started_at does not mean a runner took it.
 */
function queuedFor(j: JobInfo, now: number): number | null {
  if (j.status !== "queued") return null;
  const at = Date.parse(j.createdAt ?? "");
  return Number.isFinite(at) ? now - at : null;
}

/** The job events in one run's jobs, and what to keep. `prev` null: the pull request's first read, a baseline. */
export function jobChanges(prev: JobsSeen | null, run: RunInfo, jobs: readonly JobInfo[], snapshot: Snapshot, now: number): { changes: Change[]; keep: JobsSeen } {
  const failed = new Set(prev?.failed ?? []);
  const stuck = new Set(prev?.stuck ?? []);
  const changes: Change[] = [];
  for (const j of jobs) {
    const job = { id: j.id, name: j.name, labels: j.labels, url: j.url };
    if (j.conclusion && FAILED.has(j.conclusion) && !failed.has(j.id)) {
      failed.add(j.id);
      if (prev) changes.push({ kind: "ci.job_failed", snapshot, run, job, conclusion: j.conclusion });
    }
    const waited = queuedFor(j, now);
    if (waited !== null && waited >= STUCK_AFTER_MS && !stuck.has(j.id)) {
      stuck.add(j.id);
      if (prev) changes.push({ kind: "ci.job_stuck_queued", snapshot, run, job: { ...job, queuedSeconds: Math.floor(waited / 1000) } });
    }
  }
  return { changes, keep: { failed, stuck } };
}
