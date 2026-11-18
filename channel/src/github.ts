/**
 * GitHub, read directly with the user's own GitHub login, so runners.io is
 * not involved: nothing is sent to it and it holds no credential.
 *
 * THE LOGIN is whatever the GitHub CLI holds (`gh auth token`), or GH_TOKEN /
 * GITHUB_TOKEN when the user has set one. The token is read through execFile
 * (no shell, fixed argv), kept in memory only, and never logged: log.ts masks
 * GitHub token shapes as well as bearer headers.
 *
 * ETAGS: every GET is sent with the previous answer's ETag. GitHub answers an
 * unchanged resource with 304, which does not count against the 5,000
 * requests an hour a user gets, so polling a quiet PR costs almost nothing.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import { log } from "./log.ts";
import type { LoginStore, SharedStore, Stored } from "./shared.ts";

export type GhAuth =
  | { readonly kind: "ok"; readonly token: string; readonly source: "env" | "gh" }
  | { readonly kind: "not_installed" }
  | { readonly kind: "signed_out" };

export type GhProblem = Exclude<GhAuth, { kind: "ok" }>;

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  /** `ENOENT` when gh is not on PATH. */
  readonly errorCode?: string;
}

export type Runner = (command: string, args: readonly string[]) => Promise<RunResult>;

const runCommand: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      const e = error as NodeJS.ErrnoException & { code?: number | string };
      resolve({ code: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", errorCode: typeof e.code === "string" ? e.code : undefined });
    });
  });

type Env = Record<string, string | undefined>;

/**
 * The GitHub host whose login is used for an API address: github.com for api.github.com (and for loopback, the
 * tests' fake GitHub), otherwise the address's own host (GitHub Enterprise Server). A token is only ever read
 * for the host it is sent to, so pointing RUNNERS_IO_GITHUB_API somewhere else can never carry a github.com
 * token there.
 */
export function loginHost(apiBase: string): string {
  const host = new URL(apiBase).hostname;
  return host === "api.github.com" || LOOPBACK_HOSTS.has(host) ? "github.com" : host;
}
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The token for the API address's host, the way gh picks it: the host's environment variables, then gh's login. */
export async function readGhAuth(env: Env = process.env, run: Runner = runCommand, apiBase = "https://api.github.com"): Promise<GhAuth> {
  const host = loginHost(apiBase);
  const names = host === "github.com" ? (["GH_TOKEN", "GITHUB_TOKEN"] as const) : (["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const);
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { kind: "ok", token: value, source: "env" };
  }
  const result = await run("gh", ["auth", "token", "--hostname", host]);
  if (result.errorCode === "ENOENT") return { kind: "not_installed" };
  const token = result.stdout.trim();
  if (result.code !== 0 || !token) return { kind: "signed_out" };
  return { kind: "ok", token, source: "gh" };
}

export interface PullInfo {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly headSha: string;
  readonly headRef: string;
  /**
   * `dirty` is a merge conflict, `unknown` is "still computing", `clean` is neither. Read from GitHub's
   * `mergeable` boolean first: a draft PR's `mergeable_state` is `draft` whether or not it conflicts.
   */
  readonly mergeableState: string;
  readonly htmlUrl: string;
  /** When it was merged or closed, GitHub's time; for the event log's latency. */
  readonly closedAt?: string;
  readonly updatedAt?: string;
  readonly baseRef?: string;
  readonly draft?: boolean;
  readonly labels?: readonly string[];
  /** 16 hex characters of the body's SHA-256: the body itself is untrusted text and is never kept. */
  readonly bodyHash?: string;
}

/** A push run on a base branch, in GitHub's own field names (rules.mjs reads them, in the summary script too). */
export interface BaseRunInfo {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface RunInfo {
  readonly id: number;
  readonly name: string;
  /** queued, in_progress, waiting, requested, pending or completed. */
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  readonly runAttempt: number;
  /** GitHub's times, for the event log's latency: when this attempt started, and when the run last changed. */
  readonly startedAt?: string;
  readonly updatedAt?: string;
}

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "auth"; readonly auth: GhProblem }
  /** 404, or a 403 that is not a rate limit: the repository or PR does not exist, or this login cannot see it. */
  | { readonly kind: "not_found" }
  | { readonly kind: "retry"; readonly reason: string; readonly afterMs?: number };

/** The parts of GitHub's JSON the channel reads; everything is optional because none of it is trusted to be there. */
interface GhPullJson {
  number?: number;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  head?: { sha?: string; ref?: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
  html_url?: string;
  updated_at?: string;
  draft?: boolean;
  labels?: unknown;
  base?: { ref?: string };
  body?: string | null;
}

interface GhRunJson {
  id?: number;
  name?: string | null;
  display_title?: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string;
  run_attempt?: number;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
}

const FAILED_JOB = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);
/** A token is re-read from gh this often, so a `gh auth login` as another account is picked up. */
const TOKEN_TTL_MS = 5 * 60_000;

type Fetch = typeof fetch;

/** How long a session waits for another session's request to the same path before asking GitHub itself. */
const LEASE_WAIT_MS = 3000;

export interface ClientOptions {
  /** The machine-wide store several sessions share their reads through (shared.ts); none: ask GitHub every time. */
  readonly shared?: SharedStore | null;
  /** Test seam for the store's clock. */
  readonly now?: () => number;
}

export class GitHubClient {
  /**
   * How old a stored answer may be and still be used instead of asking GitHub, when a shared store is set. The
   * poller sets it to its own interval, so a path is asked at most once per interval on the whole machine.
   */
  freshMs = 0;
  /**
   * The token's OAuth scopes from the last answer's `x-oauth-scopes`, or null when GitHub sent none
   * (a fine-grained token, or before the first answer). A classic token without `repo` cannot see a
   * private repository's PRs, and GitHub says only "404".
   */
  scopes: string[] | null = null;
  /** Answers since start, for the event log's heartbeat: 200s, 304s (free) and anything else. */
  readonly requests = { ok: 0, not_modified: 0, other: 0, shared: 0 };
  private readonly cache = new Map<string, { etag: string; value: unknown }>();
  private readonly shared: SharedStore | null;
  private readonly now: () => number;
  private store: LoginStore | null = null;
  private ownRate: { remaining: number; at: number } | null = null;
  private auth: { value: GhAuth; at: number } | null = null;
  private readonly base: string;
  private readonly readAuth: () => Promise<GhAuth>;
  private readonly fetchImpl: Fetch;

  constructor(base: string, readAuth: () => Promise<GhAuth>, fetchImpl: Fetch = fetch, options: ClientOptions = {}) {
    this.base = base.replace(/\/+$/, "");
    this.readAuth = readAuth;
    this.fetchImpl = fetchImpl;
    this.shared = options.shared ?? null;
    this.now = options.now ?? Date.now;
  }

  /**
   * `x-ratelimit-remaining` from the newest answer any session on this machine got for this login (this one's
   * own without a shared store), or null before the first: the backoff is one for the whole machine.
   */
  get rateRemaining(): number | null {
    const other = this.store?.readRate() ?? null;
    const newest = other && (!this.ownRate || other.at >= this.ownRate.at) ? other : this.ownRate;
    return newest ? newest.remaining : null;
  }

  /** The login as it stands now: read again when older than five minutes, or when `fresh`. */
  async login(fresh = false): Promise<GhAuth> {
    if (fresh || !this.auth || this.auth.value.kind !== "ok" || Date.now() - this.auth.at > TOKEN_TTL_MS) {
      this.auth = { value: await this.readAuth(), at: Date.now() };
      const a = this.auth.value;
      this.store = a.kind === "ok" && this.shared ? this.shared.forLogin(this.base, a.token) : null;
    }
    return this.auth.value;
  }

  getPull(repo: string, pr: number): Promise<ApiResult<PullInfo>> {
    return this.get(`/repos/${repo}/pulls/${pr}`, this.freshMs, (j) => {
      const p = (j ?? {}) as GhPullJson;
      return {
        number: Number(p.number),
        state: p.state === "closed" ? "closed" : "open",
        merged: p.merged === true || Boolean(p.merged_at),
        headSha: String(p.head?.sha ?? ""),
        headRef: String(p.head?.ref ?? ""),
        mergeableState: mergeability(p),
        htmlUrl: String(p.html_url ?? ""),
        ...(typeof (p.merged_at ?? p.closed_at) === "string" ? { closedAt: String(p.merged_at ?? p.closed_at) } : {}),
        ...(typeof p.updated_at === "string" ? { updatedAt: p.updated_at } : {}),
        ...(typeof p.base?.ref === "string" ? { baseRef: p.base.ref } : {}),
        ...(typeof p.draft === "boolean" ? { draft: p.draft } : {}),
        ...(Array.isArray(p.labels) ? { labels: labelNames(p.labels) } : {}),
        bodyHash: createHash("sha256").update(typeof p.body === "string" ? p.body : "").digest("hex").slice(0, 16),
      };
    });
  }

  findOpenPull(repo: string, branch: string): Promise<ApiResult<number | null>> {
    const owner = repo.split("/")[0];
    const q = new URLSearchParams({ head: `${owner}:${branch}`, state: "open", per_page: "5" });
    return this.get(`/repos/${repo}/pulls?${q}`, this.freshMs, (j) => {
      const first = Array.isArray(j) ? (j[0] as { number?: unknown } | undefined) : undefined;
      return first && Number.isInteger(first.number) ? (first.number as number) : null;
    });
  }

  runsForSha(repo: string, sha: string): Promise<ApiResult<RunInfo[]>> {
    const q = new URLSearchParams({ head_sha: sha, per_page: "100" });
    return this.get(`/repos/${repo}/actions/runs?${q}`, this.freshMs, (j) => {
      const runs = ((j as { workflow_runs?: unknown }).workflow_runs ?? []) as GhRunJson[];
      return runs.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? r.display_title ?? "a workflow"),
        status: String(r.status ?? "queued"),
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        htmlUrl: String(r.html_url ?? ""),
        runAttempt: Number(r.run_attempt ?? 1),
        ...(typeof (r.run_started_at ?? r.created_at) === "string" ? { startedAt: String(r.run_started_at ?? r.created_at) } : {}),
        ...(typeof r.updated_at === "string" ? { updatedAt: r.updated_at } : {}),
      }));
    });
  }

  /** The latest push runs on a branch: the base branch's health (rules.mjs `baseVerdict`). */
  baseRuns(repo: string, branch: string, freshMs = this.freshMs): Promise<ApiResult<BaseRunInfo[]>> {
    const q = new URLSearchParams({ branch, event: "push", per_page: "30" });
    return this.get(`/repos/${repo}/actions/runs?${q}`, freshMs, (j) => {
      const runs = ((j as { workflow_runs?: unknown }).workflow_runs ?? []) as GhRunJson[];
      return runs.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? r.display_title ?? "a workflow"),
        status: String(r.status ?? "queued"),
        conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
        ...(typeof r.created_at === "string" ? { created_at: r.created_at } : {}),
        ...(typeof r.updated_at === "string" ? { updated_at: r.updated_at } : {}),
      }));
    });
  }

  failedJobs(repo: string, runId: number): Promise<ApiResult<string[]>> {
    return this.get(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, this.freshMs, (j) => {
      const jobs = ((j as { jobs?: unknown }).jobs ?? []) as { name?: unknown; conclusion?: unknown }[];
      return jobs.filter((x) => typeof x.conclusion === "string" && FAILED_JOB.has(x.conclusion)).map((x) => String(x.name));
    });
  }

  /**
   * One GET. With a shared store and a freshness window: a stored answer young enough is used as it is (no
   * request); otherwise this session takes the path's lease, or waits briefly for the session that holds it,
   * and asks GitHub with the newest ETag any session stored. Without a store: every call asks GitHub.
   */
  private async get<T>(path: string, freshMs: number, map: (json: unknown) => T): Promise<ApiResult<T>> {
    const auth = await this.login();
    if (auth.kind !== "ok") return { kind: "auth", auth };
    const store = freshMs > 0 ? this.store : null;
    if (!store) return this.ask(path, auth, map, null, null);
    const usable = (): Stored<T> | null => {
      const s = store.read<T>(path);
      return s && this.now() - s.at < freshMs ? s : null;
    };
    let hit = usable();
    let release = hit ? null : store.lease(path, this.now());
    const waitUntil = Date.now() + LEASE_WAIT_MS;
    while (!hit && !release && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 50));
      hit = usable();
      if (!hit) release = store.lease(path, this.now());
    }
    if (!hit && release) hit = usable(); // answered while this session was taking the lease
    if (hit) {
      release?.();
      this.requests.shared++;
      return { kind: "ok", value: hit.value };
    }
    try {
      return await this.ask(path, auth, map, store, store.read<T>(path));
    } finally {
      release?.();
    }
  }

  private async ask<T>(
    path: string,
    first: Extract<GhAuth, { kind: "ok" }>,
    map: (json: unknown) => T,
    store: LoginStore | null,
    stored: Stored<T> | null,
  ): Promise<ApiResult<T>> {
    let auth = first;
    // The newest ETag on this machine, with the value it stands for: another session's when it is newer.
    const own = this.cache.get(path) as { etag: string; value: T } | undefined;
    const known = stored ? { etag: stored.etag, value: stored.value } : own;
    let res = await this.request(path, auth.token, known?.etag);
    if ("kind" in res) return res;
    if (res.status === 401) {
      await res.body?.cancel();
      const fresh = await this.login(true);
      if (fresh.kind !== "ok") return { kind: "auth", auth: fresh };
      if (fresh.token === auth.token) return { kind: "auth", auth: { kind: "signed_out" } };
      auth = fresh;
      return this.ask(path, auth, map, this.store, null);
    }
    const now = this.now();
    if (res.status === 200) this.requests.ok++;
    else if (res.status === 304) this.requests.not_modified++;
    else this.requests.other++;
    const scopeHeader = res.headers.get("x-oauth-scopes");
    this.scopes = scopeHeader === null ? null : scopeHeader.split(",").map((x) => x.trim()).filter(Boolean);
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    if (res.headers.has("x-ratelimit-remaining") && Number.isFinite(remaining)) {
      this.ownRate = { remaining, at: now };
      store?.writeRate(remaining, now);
    }

    if (res.status === 304 && known) {
      await res.body?.cancel().catch(() => undefined);
      store?.write({ path, etag: known.etag, value: known.value, at: now });
      return { kind: "ok", value: known.value };
    }
    if (res.status === 403 || res.status === 429) {
      const wait = rateLimitWait(res.headers) ?? (await secondaryLimitWait(res));
      await res.body?.cancel().catch(() => undefined);
      if (wait !== undefined) return { kind: "retry", reason: `GitHub rate limit (HTTP ${res.status})`, afterMs: wait };
      return { kind: "not_found" };
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel();
      return { kind: "not_found" };
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return { kind: "retry", reason: `GitHub answered HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "retry", reason: "GitHub answered something that is not JSON" };
    }
    const value = map(body);
    const etag = res.headers.get("etag");
    if (etag) {
      this.cache.set(path, { etag, value });
      store?.write({ path, etag, value, at: now });
    }
    return { kind: "ok", value };
  }

  private async request(path: string, token: string, etag: string | undefined): Promise<Response | { kind: "retry"; reason: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "runners-io-claude-channel",
    };
    if (etag) headers["if-none-match"] = etag;
    try {
      return await this.fetchImpl(`${this.base}${path}`, { headers, signal: AbortSignal.timeout(20_000), redirect: "error" });
    } catch (error) {
      const e = error as Error;
      log(`GitHub request failed: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
      return { kind: "retry", reason: e.name === "TimeoutError" ? "GitHub timed out" : e.message };
    }
  }
}

/** How long a rate-limited answer says to wait, or undefined when the 403 is not a rate limit. */
function rateLimitWait(headers: Headers): number | undefined {
  const retryAfter = Number(headers.get("retry-after"));
  if (headers.has("retry-after") && Number.isFinite(retryAfter)) return Math.min(retryAfter, 3600) * 1000;
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(1000, Math.min(reset * 1000 - Date.now(), 3_600_000));
    return 60_000;
  }
  return undefined;
}

/**
 * GitHub's secondary rate limits can answer 403 with neither `retry-after` nor `x-ratelimit-remaining: 0`,
 * only a message; GitHub's advice is then to wait at least a minute. Without this, every subscription was
 * dropped as "not visible" in one pass.
 */
async function secondaryLimitWait(res: Response): Promise<number | undefined> {
  try {
    const body = (await res.clone().json()) as { message?: unknown };
    return typeof body.message === "string" && /rate limit/i.test(body.message) ? 60_000 : undefined;
  } catch {
    return undefined;
  }
}

function labelNames(labels: unknown[]): string[] {
  return labels
    .map((l) => (l && typeof (l as { name?: unknown }).name === "string" ? String((l as { name: string }).name) : ""))
    .filter(Boolean)
    .sort();
}

/** `dirty`, `clean` or `unknown`, from `mergeable` (true, false or null) and then `mergeable_state`. */
function mergeability(p: GhPullJson): string {
  if (p.mergeable === false) return "dirty";
  if (p.mergeable === true) return "clean";
  return p.mergeable_state === "dirty" ? "dirty" : "unknown";
}
