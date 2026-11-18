// A session can run for days and watch hundreds of pull requests one after another. Every list the channel keeps
// must stay under a fixed bound however many it has seen: a long run drives thousands of changes across hundreds of
// pull requests (subscribed by the branch, by the tool and by the hook; merged, closed, gone and unsubscribed) and
// holds each list's size, read after every pass, under its bound.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import type { EventLog } from "../src/eventlog.ts";
import type { GitScope } from "../src/git.ts";
import { ETAG_CACHE_MAX, GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { runPoller } from "../src/poller.ts";
import { REQUEST_IDS_MAX } from "../src/requests.ts";
import { MAX_SUBSCRIPTIONS, Subscriptions } from "../src/subscriptions.ts";
import { makeTools } from "../src/tools.ts";

setQuiet(true);

const REPO = "acme/widgets";
const TOKEN = "gho_fakeToken123";
type Json = Record<string, unknown>;

/** GitHub, in process: the few paths the channel reads, with ETags, so thousands of passes take seconds. */
class World {
  clock = Date.parse("2026-01-01T00:00:00Z");
  readonly pulls = new Map<number, Json>();
  readonly runs = new Map<string, Json[]>();
  readonly jobs = new Map<number, Json[]>();
  requestNodes: Json[] = [];
  readonly paths = new Set<string>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (init?.method === "POST") return this.graphql(JSON.parse(String(init.body)) as { query: string });
    this.paths.add(url.pathname + url.search);
    return this.answer(this.route(url), new Headers(init?.headers).get("if-none-match"));
  };

  private route(url: URL): Json | Json[] | null {
    const p = url.pathname;
    if (p === "/user") return { login: "octocat" };
    let m = /^\/repos\/acme\/widgets\/pulls\/(\d+)$/.exec(p);
    if (m) return this.pulls.get(Number(m[1])) ?? null;
    if (p === "/repos/acme/widgets/pulls") {
      const branch = (url.searchParams.get("head") ?? "").split(":")[1];
      return [...this.pulls.values()].filter((x) => x.state === "open" && (x.head as Json).ref === branch);
    }
    if (p === "/repos/acme/widgets/actions/runs") {
      const sha = url.searchParams.get("head_sha");
      return { workflow_runs: sha ? (this.runs.get(sha) ?? []) : [] };
    }
    m = /^\/repos\/acme\/widgets\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    if (m) return { jobs: this.jobs.get(Number(m[1])) ?? [] };
    if (/\/check-runs\/\d+\/annotations$/.test(p)) return [];
    return null;
  }

  private answer(body: Json | Json[] | null, ifNoneMatch: string | null): Response {
    const headers: Record<string, string> = { "content-type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-oauth-scopes": "repo" };
    if (body === null) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers });
    const text = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { ...headers, etag } });
    return new Response(text, { status: 200, headers: { ...headers, etag } });
  }

  private graphql(body: { query: string }): Response {
    const rateLimit = { cost: 1, remaining: 4990, limit: 5000, resetAt: new Date(Date.now() + 3_600_000).toISOString() };
    const data = body.query.includes("search(")
      ? { rateLimit, viewer: { login: "octocat" }, search: { nodes: this.requestNodes } }
      : { rateLimit, repository: { pullRequest: null } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }
}

type Mode = "auto" | "tool" | "hook";
type End = "merged" | "closed" | "unsubscribe" | "gone";
interface Life {
  readonly pr: number;
  readonly mode: Mode;
  readonly end: End;
  head: number;
  stage: number;
  done: boolean;
}

test("thousands of changes across hundreds of pull requests leave every list under its bound", async (t) => {
  const world = new World();
  const iso = () => new Date(world.clock).toISOString();
  const scope: { current: GitScope } = { current: { repo: REPO, branch: "main" } };
  const config: Config = {
    githubApi: "https://api.github.com",
    projectDir: "/nowhere",
    autoSubscribe: "pr",
    pollSeconds: 20,
    eventLogDir: null,
    rateFloor: 200,
    reviewRequests: true,
  };
  const gh = new GitHubClient("https://api.github.com", async () => ({ kind: "ok", token: TOKEN, source: "gh" }), world.fetch);
  const subs = new Subscriptions();
  const counts = { events: 0, sent: 0, unsubscribe: new Map<string, number>(), subscribe: new Map<string, number>() };
  const eventLog: EventLog = {
    write(type, fields = {}) {
      if (type === "event") {
        counts.events++;
        if (fields.outcome === "sent") counts.sent++;
      }
      if (type === "unsubscribe") counts.unsubscribe.set(String(fields.reason), (counts.unsubscribe.get(String(fields.reason)) ?? 0) + 1);
      if (type === "subscribe") counts.subscribe.set(String(fields.source), (counts.subscribe.get(String(fields.source)) ?? 0) + 1);
    },
  };
  const tools = makeTools({ subs, gh, readScope: async () => scope.current, eventLog });
  const hookQueue: { repo: string; pr: number; at: number }[] = [];

  // Lockstep: the poller parks in its sleep after every pass, and the test lets it run exactly one more.
  let wake: (() => void) | null = null;
  let parked: (() => void) | null = null;
  let firstPark = new Promise<void>((r) => (parked = r));
  const stop = new AbortController();
  let readSizes: () => Record<string, number> = () => ({});
  const done = runPoller({
    config,
    gh,
    subs,
    readScope: async () => scope.current,
    notify: async () => {},
    signal: stop.signal,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        wake = resolve;
        parked?.();
      }),
    eventLog,
    now: () => world.clock,
    lookEveryMs: () => 0,
    baseEveryMs: 0,
    baseIdleMs: 0,
    reviewEveryMs: 0,
    requestsEveryMs: 0,
    takeHookRequests: () => hookQueue.splice(0),
    sizes: (read) => {
      readSizes = read;
    },
  });
  const pass = async () => {
    const next = new Promise<void>((r) => (parked = r));
    const w = wake;
    wake = null;
    w?.();
    await next;
  };

  const max: Record<string, number> = {};
  const lives: Life[] = [];
  let nextPr = 1;
  let nextRun = 1;
  let nextRequest = 1;
  const MODES: Mode[] = ["auto", "tool", "hook"];
  const ENDS: End[] = ["merged", "closed", "unsubscribe", "gone"];
  const shaOf = (pr: number, head: number) => createHash("sha1").update(`${pr}/${head}`).digest("hex");
  const setRuns = (life: Life, status: string) => {
    const sha = shaOf(life.pr, life.head);
    const runs = (world.runs.get(sha) ?? ["CI", "Lint", "Build"].map((name) => ({ id: nextRun++, name }))).map((r, i) => ({
      id: r.id,
      name: r.name,
      status,
      conclusion: status === "completed" ? (i === 1 && life.head % 2 === 0 ? "failure" : "success") : null,
      run_attempt: 1,
      html_url: `https://github.com/${REPO}/actions/runs/${r.id}`,
      head_sha: sha,
      head_branch: `b${life.pr}`,
      head_repository: { full_name: REPO },
      created_at: iso(),
      updated_at: iso(),
    }));
    world.runs.set(sha, runs);
    for (const r of runs) world.jobs.set(r.id as number, [{ id: (r.id as number) * 10, name: "job", status, conclusion: r.conclusion, created_at: iso(), started_at: iso(), labels: ["ubuntu-latest"] }]);
  };
  const setPull = (life: Life, fields: Json = {}) => {
    world.pulls.set(life.pr, {
      number: life.pr,
      state: "open",
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
      html_url: `https://github.com/${REPO}/pull/${life.pr}`,
      head: { sha: shaOf(life.pr, life.head), ref: `b${life.pr}`, repo: { full_name: REPO } },
      base: { ref: "main" },
      user: { login: "octocat" },
      created_at: iso(),
      updated_at: iso(),
      labels: [],
      body: `head ${life.head}`,
      ...fields,
    });
  };

  const spawn = async () => {
    const life: Life = { pr: nextPr, mode: MODES[nextPr % 3], end: ENDS[Math.floor(nextPr / 3) % 4], head: 1, stage: 0, done: false };
    nextPr++;
    lives.push(life);
    setPull(life);
    setRuns(life, "queued");
    if (life.mode === "auto") scope.current = { repo: REPO, branch: `b${life.pr}` };
    if (life.mode === "tool") await tools.call("subscribe", { repo: REPO, pr: life.pr });
    if (life.mode === "hook") hookQueue.push({ repo: REPO, pr: life.pr, at: world.clock });
  };

  const advance = async (life: Life) => {
    life.stage++;
    if (life.stage === 1) setRuns(life, "in_progress");
    else if (life.stage === 2) setRuns(life, "completed");
    else if (life.head < 3) {
      life.head++;
      life.stage = 0;
      setPull(life);
      setRuns(life, "queued");
    } else {
      life.done = true;
      if (life.end === "merged") setPull(life, { state: "closed", merged: true, merged_at: iso() });
      else if (life.end === "closed") setPull(life, { state: "closed", closed_at: iso() });
      else if (life.end === "gone") world.pulls.delete(life.pr);
      else await tools.call("unsubscribe", { repo: REPO, pr: life.pr });
    }
  };

  try {
    await firstPark;
    const PASSES = 600;
    for (let i = 0; i < PASSES; i++) {
      world.clock += 30_000;
      for (const life of lives.filter((l) => !l.done)) await advance(life);
      while (lives.filter((l) => !l.done).length < 12) await spawn();
      // One new review request a pass, on a PR this session does not watch; the search shows the newest 30.
      const id = nextRequest++;
      world.requestNodes = [
        {
          number: 100_000 + id,
          url: `https://github.com/${REPO}/pull/${100_000 + id}`,
          repository: { nameWithOwner: REPO },
          timelineItems: {
            nodes: [{ id: `RR${id}`, createdAt: iso(), actor: { login: "someone", __typename: "User" }, requestedReviewer: { __typename: "User", login: "octocat" } }],
          },
        },
        ...world.requestNodes,
      ].slice(0, 30);
      await pass();
      for (const [name, n] of Object.entries(readSizes())) max[name] = Math.max(max[name] ?? 0, n);
    }
  } finally {
    stop.abort();
    (wake as (() => void) | null)?.();
    await done;
  }

  // The controls: the run was long and wide enough that an unbounded list would have passed every bound below.
  assert.ok(counts.events >= 3000, `only ${counts.events} changes`);
  assert.ok(nextPr - 1 >= 200, `only ${nextPr - 1} pull requests`);
  assert.ok(world.paths.size > 2 * ETAG_CACHE_MAX, `only ${world.paths.size} paths read`);
  assert.ok(nextRequest - 1 > 2 * REQUEST_IDS_MAX, `only ${nextRequest - 1} review requests`);
  for (const source of ["auto", "tool", "hook"]) assert.ok((counts.subscribe.get(source) ?? 0) >= 20, `subscribed by ${source}: ${counts.subscribe.get(source)}`);
  for (const reason of ["merged", "closed", "tool", "branch_switch", "not_visible"]) {
    assert.ok((counts.unsubscribe.get(reason) ?? 0) >= 5, `unsubscribed for ${reason}: ${counts.unsubscribe.get(reason)}`);
  }
  for (const name of ["startedFor", "sentAt", "looks", "reviews", "jobsSeen", "etagEntries", "requestIds"]) {
    assert.ok((max[name] ?? 0) >= 5, `${name} was never filled (${max[name]}), so its bound proves nothing`);
  }

  t.diagnostic(`largest sizes seen: ${JSON.stringify(max)}; ${counts.events} changes, ${nextPr - 1} pull requests, ${world.paths.size} paths`);
  // The bounds, every one checked before any is reported.
  const bound = (name: string) => (name === "etagEntries" ? ETAG_CACHE_MAX : name === "requestIds" ? REQUEST_IDS_MAX : MAX_SUBSCRIPTIONS);
  const over = Object.entries(max).filter(([name, n]) => n > bound(name)).map(([name, n]) => `${name} held ${n}, over its bound of ${bound(name)}`);
  assert.deepEqual(over, []);
});
