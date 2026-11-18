export interface FakeGitHub {
  readonly base: string;
  readonly state: {
    token: string;
    rateLimited: null | { resetEpoch: number };
    secondaryLimited: boolean;
    scopes: string | null;
    failNext: { pattern: RegExp; status: number; count: number }[];
  };
  readonly requests: { path: string; status: number }[];
  setPull(repo: string, number: number, fields?: Record<string, unknown>): Record<string, unknown>;
  deletePull(repo: string, number: number): void;
  setRuns(repo: string, sha: string, runs: Record<string, unknown>[]): void;
  setCommits(repo: string, number: number, shas: string[]): void;
  setBaseRuns(repo: string, branch: string, runs: Record<string, unknown>[]): void;
  setIssueEvents(repo: string, number: number, events: Record<string, unknown>[]): void;
  setAttempt(runId: number, attempt: number, run: Record<string, unknown>): void;
  setJobs(runId: number, jobs: { name: string; conclusion: string | null }[]): void;
  close(): Promise<void>;
}

export function startFakeGitHub(opts?: { token?: string }): Promise<FakeGitHub>;
