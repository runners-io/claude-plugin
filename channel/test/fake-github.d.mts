export interface FakeGitHub {
  readonly base: string;
  readonly state: {
    token: string;
    rateLimited: null | { resetEpoch: number };
    secondaryLimited: boolean;
    scopes: string | null;
    failNext: { pattern: RegExp; status: number; count: number; headers?: Record<string, string>; body?: unknown }[];
    repos: Map<string, Record<string, unknown>>;
  };
  readonly requests: { path: string; status: number }[];
  setPull(repo: string, number: number, fields?: Record<string, unknown>): Record<string, unknown>;
  deletePull(repo: string, number: number): void;
  /** The PR numbers the `involves:@me` search answers for a repository. */
  setInvolved(repo: string, numbers: number[]): void;
  setRuns(repo: string, sha: string, runs: Record<string, unknown>[]): void;
  setCommits(repo: string, number: number, shas: string[]): void;
  setBaseRuns(repo: string, branch: string, runs: Record<string, unknown>[]): void;
  setIssueEvents(repo: string, number: number, events: Record<string, unknown>[]): void;
  setAttempt(runId: number, attempt: number, run: Record<string, unknown>): void;
  setReviews(repo: string, number: number, reviews: Record<string, unknown>[]): void;
  setReviewComments(repo: string, number: number, comments: Record<string, unknown>[]): void;
  setReviewRequests(nodes: Record<string, unknown>[], viewer?: string): void;
  setReviewPull(repo: string, number: number, node: Record<string, unknown>): void;
  setGraphqlRate(remaining: number, limit?: number): void;
  setRate(remaining: number, limit?: number, resetEpochSeconds?: number | null): void;
  setJobs(runId: number, jobs: ({ name: string; conclusion: string | null } & Record<string, unknown>)[]): void;
  setAnnotations(jobId: number, list: Record<string, unknown>[]): void;
  close(): Promise<void>;
}

export function startFakeGitHub(opts?: { token?: string }): Promise<FakeGitHub>;
