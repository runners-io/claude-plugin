/**
 * Reviews, review threads and "ready to merge", from ONE GraphQL read of a pull request (github.ts `reviewState`).
 *
 * REST cannot give these cheaply: the review decision, each thread and whether it is resolved, and GitHub's own
 * "mergeable and passing" (mergeStateStatus, which counts every check, Actions or not, and the review rules) would
 * be several REST reads a look. One GraphQL query returns them all for 1 point of GraphQL's own hourly budget,
 * separate from the REST one the CI reads use. It is read about once a minute (poller.ts), not every pass.
 *
 * NO TEXT IS KEPT. A review's body and a comment's body are written by whoever can comment, which on a public
 * repository is anyone. Only kinds, logins, file:line, counts and links leave here; Claude reads the text with
 * `gh` itself, as data. Who wrote it is `bot` (an app such as a code-review bot, Dependabot or github-actions),
 * `member` (GitHub says owner, member or collaborator) or `outside`, so a session can weigh a bot's "LGTM" and a
 * stranger's request differently.
 */
import { type Change, type Snapshot, outcome } from "./state.ts";

export type AuthorType = "bot" | "member" | "outside";

export interface ReviewInfo {
  readonly id: string;
  /** APPROVED or CHANGES_REQUESTED: the latest such review of each reviewer (`latestOpinionatedReviews`). */
  readonly state: string;
  readonly login: string;
  readonly authorType: AuthorType;
  readonly at?: string;
  readonly url?: string;
}

export interface ThreadInfo {
  readonly id: string;
  readonly resolved: boolean;
  readonly path: string;
  readonly line: number | null;
  /** Who opened it: its first comment's author. */
  readonly login: string;
  readonly authorType: AuthorType;
  readonly url?: string;
  readonly at?: string;
}

export interface ReviewState {
  readonly headSha: string;
  /** GitHub's mergeStateStatus: CLEAN, HAS_HOOKS, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT or UNKNOWN. */
  readonly mergeState: string;
  readonly reviewDecision: string | null;
  readonly reviews: readonly ReviewInfo[];
  readonly threads: readonly ThreadInfo[];
  /** The head commit "ready to merge" was last sent for, carried by reviewChanges so it is sent once a commit. */
  readonly readySha?: string;
}

/** The query: one pull request's head, merge state, latest opinionated reviews and its first 100 threads. */
export const REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining limit resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid mergeStateStatus reviewDecision
      latestOpinionatedReviews(first: 50) { nodes { id state submittedAt url authorAssociation author { login __typename } } }
      reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 1) { nodes { url createdAt authorAssociation author { login __typename } } } } }
    }
  }
}`;

const READY = new Set(["CLEAN", "HAS_HOOKS"]);
const MEMBER = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nodes = (v: unknown): Json[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : []);

function author(node: Json): { login: string; authorType: AuthorType } {
  const a = obj(node.author);
  const login = str(a.login) || "ghost"; // a deleted account
  if (a.__typename === "Bot") return { login, authorType: "bot" };
  return { login, authorType: MEMBER.has(str(node.authorAssociation)) ? "member" : "outside" };
}

/** The GraphQL answer as a ReviewState, or null when it holds no pull request (gone, not visible, or errors). */
export function parseReviewState(body: unknown): ReviewState | null {
  const pr = obj(obj(obj(obj(body).data).repository).pullRequest);
  if (!str(pr.headRefOid)) return null;
  const reviews = nodes(pr.latestOpinionatedReviews)
    .filter((r) => str(r.id))
    .map((r): ReviewInfo => ({
      id: str(r.id),
      state: str(r.state),
      ...author(r),
      ...(str(r.submittedAt) ? { at: str(r.submittedAt) } : {}),
      ...(str(r.url) ? { url: str(r.url) } : {}),
    }));
  const threads = nodes(pr.reviewThreads)
    .filter((t) => str(t.id))
    .map((t): ThreadInfo => {
      const first = nodes(t.comments)[0] ?? {};
      return {
        id: str(t.id),
        resolved: t.isResolved === true,
        path: str(t.path),
        line: typeof t.line === "number" ? t.line : null,
        ...author(first),
        ...(str(first.url) ? { url: str(first.url) } : {}),
        ...(str(first.createdAt) ? { at: str(first.createdAt) } : {}),
      };
    });
  return {
    headSha: str(pr.headRefOid),
    mergeState: str(pr.mergeStateStatus) || "UNKNOWN",
    reviewDecision: str(pr.reviewDecision) || null,
    reviews,
    threads,
  };
}

/** GraphQL's own rate limit from the same answer: it is a separate budget from REST's. */
export function graphqlRate(body: unknown): { remaining: number; limit: number; reset: number } | null {
  const r = obj(obj(obj(body).data).rateLimit);
  const reset = Date.parse(str(r.resetAt));
  return typeof r.remaining === "number" && typeof r.limit === "number" && Number.isFinite(reset) ? { remaining: r.remaining, limit: r.limit, reset } : null;
}

/**
 * What changed between two readings, and the reading to keep for next time. The first reading (`prev` null) is a
 * baseline. A review is new when its id is: a reviewer's newer review has a new id. A thread is added when its id
 * is new, resolved when it was unresolved. Ready to merge is sent once per head commit.
 */
export function reviewChanges(prev: ReviewState | null, next: ReviewState, snapshot: Snapshot, settled = true): { changes: Change[]; keep: ReviewState } {
  const ready = READY.has(next.mergeState);
  // GitHub's CLEAN can come before CI has finished: a workflow not registered yet, or a check the rules do not
  // require. So ready to merge waits for the head to settle (`settled`, from the poller: its window to register
  // workflows has passed) and for every run on it to have finished, none failed. Until then it is not marked sent.
  const runsDone = snapshot.runs.every((r) => r.status === "completed" && outcome(r.conclusion) !== "failed");
  const fire = ready && settled && runsDone;
  // The first reading is a baseline: a PR already ready is not news. Its head is marked said only when ready to merge
  // would have fired on it now; CLEAN with a run still queued, marked, lost the ready to merge that run's finish makes.
  if (!prev) return { changes: [], keep: fire ? { ...next, readySha: next.headSha } : { ...next } };
  const readySha = fire ? next.headSha : prev.headSha === next.headSha ? prev.readySha : undefined;
  const keep: ReviewState = { ...next, ...(readySha ? { readySha } : {}) };
  const changes: Change[] = [];
  const unresolved = next.threads.filter((t) => !t.resolved).length;
  const seenReviews = new Set(prev.reviews.map((r) => r.id));
  for (const r of next.reviews) {
    if (seenReviews.has(r.id)) continue;
    const kind = r.state === "APPROVED" ? "pr.approved" : r.state === "CHANGES_REQUESTED" ? "pr.changes_requested" : null;
    if (!kind) continue;
    changes.push({ kind, snapshot, review: { login: r.login, authorType: r.authorType, url: r.url, decision: next.reviewDecision ?? undefined }, ...(r.at ? { at: r.at } : {}) });
  }
  const before = new Map(prev.threads.map((t) => [t.id, t]));
  for (const t of next.threads) {
    const old = before.get(t.id);
    const kind = !old ? "pr.review_thread_added" : !old.resolved && t.resolved ? "pr.review_thread_resolved" : null;
    if (!kind) continue;
    changes.push({
      kind,
      snapshot,
      review: { login: t.login, authorType: t.authorType, path: t.path, line: t.line, url: t.url, unresolved },
      ...(kind === "pr.review_thread_added" && t.at ? { at: t.at } : {}),
    });
  }
  if (fire && prev.readySha !== next.headSha) {
    changes.push({ kind: "pr.ready_to_merge", snapshot, review: { mergeState: next.mergeState, decision: next.reviewDecision ?? undefined, unresolved } });
  }
  return { changes, keep };
}
