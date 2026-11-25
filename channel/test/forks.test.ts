// A clone that is a fork (forks.ts): the pull request for its branch usually lives on the repository it was forked
// from, with the fork's branch as its head. The automatic branch watch finds that one first, then the fork's own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Config } from "../src/config.ts";
import type { EventLog } from "../src/eventlog.ts";
import { ForkParents, findBranchPull } from "../src/forks.ts";
import type { ChannelMessage } from "../src/format.ts";
import { type GitScope, readGitScope } from "../src/git.ts";
import { type GhAuth, GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { runPoller } from "../src/poller.ts";
import { Subscriptions } from "../src/subscriptions.ts";
import { makeTools } from "../src/tools.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

const TOKEN = "gho_fakeForkToken0123456789";
const SHA = "f".repeat(40);
const SHA_B = "b".repeat(40);
// The upstream repository, the user's fork of it, and the fork's branch.
const UPSTREAM = "acme/widgets";
const FORK = "ada/widgets";
const AS_FORK: GitScope = { repo: FORK, branch: "feat", upstream: UPSTREAM };

async function until(what: string, fn: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 80));

/** The fork's pull request on the upstream repository: its head is the fork's branch. */
function upstreamPull(gh: FakeGitHub, number = 7, fields: Record<string, unknown> = {}) {
  gh.setPull(UPSTREAM, number, { head: { ref: "feat", sha: SHA, repo: { full_name: FORK } }, ...fields });
  gh.setRuns(UPSTREAM, SHA, [{ id: 41, name: "CI", status: "queued", head_branch: "feat", head_repository: { full_name: FORK } }]);
}

type Rec = { type: string } & Record<string, unknown>;

async function setup(opts: {
  scope: GitScope;
  hookRequests?: { repo: string; pr: number; at: number }[];
  inOwnHistory?: (sha: string) => Promise<boolean | null>;
  readPushed?: (branches: readonly string[]) => Promise<ReadonlyMap<string, string | null> | null>;
  lookEveryMs?: () => number;
}) {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const auth: GhAuth = { kind: "ok", token: TOKEN, source: "gh" };
  const client = new GitHubClient(gh.base, async () => auth);
  const subs = new Subscriptions();
  const scope = { current: opts.scope };
  const config: Config = { githubApi: gh.base, projectDir: "/nowhere", autoSubscribe: "pr", pollSeconds: 20, eventLogDir: null, rateFloor: 200, reviewRequests: false };
  const messages: ChannelMessage[] = [];
  const records: Rec[] = [];
  const eventLog: EventLog = { write: (type, fields = {}) => void records.push({ type, ...fields }) };
  const stop = new AbortController();
  const parents = new ForkParents(client);
  let started: Promise<void> | null = null;
  const start = () => {
    started = runPoller({
      config,
      gh: client,
      subs,
      parents,
      readScope: async () => scope.current,
      notify: async (m) => void messages.push(m),
      signal: stop.signal,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      eventLog,
      inOwnHistory: opts.inOwnHistory,
      readPushed: opts.readPushed,
      baseEveryMs: 0,
      ...(opts.hookRequests ? { takeHookRequests: () => (opts.hookRequests as { repo: string; pr: number; at: number }[]).splice(0) } : {}),
      lookEveryMs: opts.lookEveryMs ?? (() => 0),
      allDoneHoldMs: 0,
      baseIdleMs: 0,
      reviewEveryMs: 0,
      requestsEveryMs: 0,
    });
  };
  const tools = makeTools({ subs, gh: client, parents, readScope: async () => scope.current, eventLog });
  return {
    gh,
    subs,
    scope,
    messages,
    records,
    tools,
    start,
    kinds: () => messages.map((m) => m.meta.kind),
    watched: () => subs.list().map((e) => `${e.repo}#${e.pr} ${e.source}`),
    asked: (pattern: RegExp) => gh.requests.filter((r) => pattern.test(r.path)).length,
    async stop() {
      stop.abort();
      await started;
    },
  };
}

// ---- which pull request is the branch's --------------------------------------------------------------------------

test("a fork with an upstream remote: the branch's pull request on the upstream repository is watched, asked for by the fork owner's name", async () => {
  const t = await setup({ scope: AS_FORK });
  upstreamPull(t.gh);
  t.start();
  try {
    await until("the upstream PR watched", () => t.subs.get(UPSTREAM, 7)?.last != null);
    assert.deepEqual(t.watched(), [`${UPSTREAM}#7 auto`]);
    assert.equal(t.asked(/^\/repos\/acme\/widgets\/pulls\?head=ada%3Afeat&/), 1, "asked of the upstream repository, with the fork owner's branch as the head");
    assert.equal(t.asked(/^\/repos\/ada\/widgets$/), 0, "the remote says whose fork this is: GitHub is not asked");
    assert.ok(t.records.some((r) => r.type === "subscribe" && r.repo === UPSTREAM && r.pr === 7 && r.source === "auto"));
    // Once watched, it is not looked for again: many passes later, still one question.
    await settle();
    assert.equal(t.asked(/\/pulls\?head=/), 1, "a watched pull request is not looked for at every pass");
    assert.deepEqual(t.watched(), [`${UPSTREAM}#7 auto`], "and it is not taken for another branch's and unwatched");
  } finally {
    await t.stop();
  }
});

test("a fork with no upstream remote: GitHub says which repository it was forked from, once, and that repository's pull request is watched", async () => {
  const t = await setup({ scope: { repo: FORK, branch: "feat" } });
  t.gh.state.repos.set(FORK, { fork: true, parent: { full_name: UPSTREAM } });
  upstreamPull(t.gh);
  t.start();
  try {
    await until("the upstream PR watched", () => t.subs.get(UPSTREAM, 7)?.last != null);
    assert.deepEqual(t.watched(), [`${UPSTREAM}#7 auto`]);
    // Another branch, and back: the pull request is looked for again each time, the repository is not asked about again.
    t.scope.current = { repo: FORK, branch: "other" };
    await until("unwatched on the other branch", () => t.subs.list().length === 0);
    t.scope.current = { repo: FORK, branch: "feat" };
    await until("watched again", () => t.subs.get(UPSTREAM, 7) !== undefined);
    assert.equal(t.asked(/^\/repos\/ada\/widgets$/), 1, "one request for the repository, however often the branch changes");
  } finally {
    await t.stop();
  }
});

test("a clone that is not a fork is watched as before: its own repository's pull request, and one question about the repository itself", async () => {
  const t = await setup({ scope: { repo: UPSTREAM, branch: "feat" } });
  t.gh.setPull(UPSTREAM, 7, { head: { ref: "feat", sha: SHA } });
  t.gh.setRuns(UPSTREAM, SHA, [{ id: 41, name: "CI", status: "queued" }]);
  t.start();
  try {
    await until("its own PR watched", () => t.subs.get(UPSTREAM, 7)?.last != null);
    await settle();
    assert.deepEqual(t.watched(), [`${UPSTREAM}#7 auto`]);
    assert.equal(t.asked(/^\/repos\/acme\/widgets\/pulls\?head=acme%3Afeat&/), 1);
    assert.equal(t.asked(/\/pulls\?head=/), 1, "no other repository is asked for a pull request");
    assert.equal(t.asked(/^\/repos\/acme\/widgets$/), 1, "whether it is a fork is asked once");
  } finally {
    await t.stop();
  }
});

test("a fork whose branch has no pull request on the upstream repository: the fork's own is watched, if it has one", async () => {
  const t = await setup({ scope: AS_FORK });
  t.gh.setPull(FORK, 3, { head: { ref: "feat", sha: SHA } });
  t.gh.setRuns(FORK, SHA, [{ id: 41, name: "CI", status: "queued" }]);
  // Another fork's pull request for a branch of the same name is not this clone's.
  t.gh.setPull(UPSTREAM, 9, { head: { ref: "feat", sha: SHA_B, repo: { full_name: "stranger/widgets" } } });
  t.start();
  try {
    await until("the fork's own PR watched", () => t.subs.get(FORK, 3)?.last != null);
    assert.deepEqual(t.watched(), [`${FORK}#3 auto`]);
    assert.equal(t.asked(/^\/repos\/acme\/widgets\/pulls\?head=ada%3Afeat&/), 1, "the upstream repository was asked first");
  } finally {
    await t.stop();
  }
});

test("a fork with no pull request anywhere watches nothing, and keeps to the usual pace of looking", async () => {
  const t = await setup({ scope: AS_FORK, lookEveryMs: () => 60_000 });
  t.start();
  try {
    await until("both asked", () => t.asked(/\/pulls\?head=/) >= 2);
    await settle();
    assert.deepEqual(t.watched(), []);
    assert.equal(t.asked(/^\/repos\/acme\/widgets\/pulls\?head=/), 1, "looked for once a minute at most, not at every pass");
    assert.equal(t.asked(/^\/repos\/ada\/widgets\/pulls\?head=/), 1);
  } finally {
    await t.stop();
  }
});

test("when GitHub does not answer for the upstream repository, nothing is decided: the fork's own pull request is not taken in its place", async () => {
  // Looked for once a minute, as in a real session: the one failed answer is the only look this test sees.
  const t = await setup({ scope: AS_FORK, lookEveryMs: () => 60_000 });
  upstreamPull(t.gh);
  t.gh.setPull(FORK, 3, { head: { ref: "feat", sha: SHA } });
  t.gh.state.failNext.push({ pattern: /^\/repos\/acme\/widgets\/pulls$/, status: 502, count: 1 });
  t.start();
  try {
    await until("asked", () => t.asked(/^\/repos\/acme\/widgets\/pulls\?head=/) >= 1);
    await settle();
    assert.deepEqual(t.watched(), [], "not the fork's own, which would then hide the upstream one");
    assert.equal(t.asked(/^\/repos\/ada\/widgets\/pulls\?head=/), 0);
  } finally {
    await t.stop();
  }
});

// ---- what follows from watching it -------------------------------------------------------------------------------

test("the upstream pull request's merge is reported, then it is unwatched: it is the branch's own, not a leftover of another branch", async () => {
  const t = await setup({ scope: AS_FORK });
  upstreamPull(t.gh);
  t.start();
  try {
    await until("watched", () => t.subs.get(UPSTREAM, 7)?.last != null);
    t.gh.setPull(UPSTREAM, 7, { state: "closed", merged: true, merged_at: new Date().toISOString() });
    await until("the merge", () => t.kinds().includes("pr.merged"));
    assert.equal(t.records.some((r) => r.type === "unsubscribe" && r.reason === "branch_switch"), false, "never dropped as another branch's before its merge was said");
    await until("unwatched", () => t.subs.list().length === 0);
  } finally {
    await t.stop();
  }
});

test("a push by someone else to the fork's branch is pr.head_moved on the upstream pull request", async () => {
  const known = new Set([SHA]);
  const t = await setup({ scope: AS_FORK, inOwnHistory: async (sha) => known.has(sha) });
  upstreamPull(t.gh);
  t.start();
  try {
    await until("watched", () => t.subs.get(UPSTREAM, 7)?.last != null);
    t.gh.setPull(UPSTREAM, 7, { head: { sha: SHA_B }, updated_at: new Date().toISOString() });
    await until("head_moved", () => t.kinds().includes("pr.head_moved"));
  } finally {
    await t.stop();
  }
});

test("the session's own push to the fork's branch quickens the upstream pull request: its head is the clone's origin", async () => {
  // A settled pull request is looked at rarely; a push from the clone (origin/feat moves) makes the next pass look.
  const pushed = new Map<string, string | null>([["feat", SHA]]);
  let slow = false;
  const t = await setup({ scope: { ...AS_FORK, pushed: SHA }, readPushed: async () => pushed, lookEveryMs: () => (slow ? 3_600_000 : 0) });
  upstreamPull(t.gh);
  t.gh.setRuns(UPSTREAM, SHA, [{ id: 41, name: "CI", status: "completed", conclusion: "success", head_branch: "feat", head_repository: { full_name: FORK } }]);
  t.start();
  try {
    await until("watched", () => t.subs.get(UPSTREAM, 7)?.last != null);
    slow = true;
    await settle();
    const before = t.asked(/^\/repos\/acme\/widgets\/pulls\/7$/);
    await settle();
    assert.ok(t.asked(/^\/repos\/acme\/widgets\/pulls\/7$/) - before <= 1, "settled: not looked at every pass");
    t.gh.setPull(UPSTREAM, 7, { head: { sha: SHA_B } });
    t.scope.current = { ...AS_FORK, pushed: SHA_B };
    await until("the push seen", () => t.subs.get(UPSTREAM, 7)?.last?.headSha === SHA_B);
  } finally {
    await t.stop();
  }
});

test("a pull request the hook saw on the upstream repository is taken, as one in the fork is; one in any other repository is refused", async () => {
  const hookRequests: { repo: string; pr: number; at: number }[] = [];
  const t = await setup({ scope: { repo: FORK, branch: "main", upstream: UPSTREAM }, hookRequests });
  const SHA9 = "9".repeat(40);
  t.gh.setPull(UPSTREAM, 9, { head: { ref: "scripted", sha: SHA9, repo: { full_name: FORK } }, created_at: new Date(Date.now() - 60_000).toISOString() });
  t.gh.setPull("stranger/elsewhere", 4, { head: { ref: "x", sha: SHA9 }, created_at: new Date().toISOString() });
  t.start();
  try {
    hookRequests.push({ repo: UPSTREAM, pr: 9, at: Date.now() }, { repo: "stranger/elsewhere", pr: 4, at: Date.now() });
    await until("the upstream PR watched", () => t.subs.list().some((e) => e.repo === UPSTREAM && e.pr === 9 && e.source === "hook" && e.last !== null));
    assert.ok(t.records.some((r) => r.type === "hook_refused" && r.repo === "stranger/elsewhere" && r.reason === "other_repo"));
    assert.equal(t.subs.get("stranger/elsewhere", 4), undefined);
  } finally {
    await t.stop();
  }
});

// ---- the pieces --------------------------------------------------------------------------------------------------

test("findBranchPull: upstream first, by the fork owner's branch; then the clone's own repository; an answer GitHub did not give is not a no", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: TOKEN, source: "gh" }));
  const parents = new ForkParents(client);
  const fork = { repo: FORK, branch: "feat", upstream: UPSTREAM };
  assert.deepEqual(await findBranchPull(client, fork, parents), { kind: "ok", value: null });
  gh.setPull(FORK, 3, { head: { ref: "feat", sha: SHA } });
  assert.deepEqual(await findBranchPull(client, fork, parents), { kind: "ok", value: { repo: FORK, pr: 3 } });
  upstreamPull(gh);
  assert.deepEqual(await findBranchPull(client, fork, parents), { kind: "ok", value: { repo: UPSTREAM, pr: 7 } });
  gh.state.failNext.push({ pattern: /^\/repos\/acme\/widgets\/pulls$/, status: 500, count: 1 });
  assert.equal((await findBranchPull(client, fork, parents)).kind, "retry");
  // An upstream GitHub does not show to this login (a 404) is no pull request there: the clone's own repository answers.
  gh.state.failNext.push({ pattern: /^\/repos\/acme\/widgets\/pulls$/, status: 404, count: 1 });
  assert.deepEqual(await findBranchPull(client, fork, parents), { kind: "ok", value: { repo: FORK, pr: 3 } });
});

test("ForkParents: the upstream remote when there is one; else GitHub's answer, kept; an upstream that is the clone's own repository is no parent", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: TOKEN, source: "gh" }));
  const parents = new ForkParents(client);
  assert.equal(await parents.parentOf({ repo: FORK, upstream: UPSTREAM }), UPSTREAM);
  assert.equal(gh.requests.length, 0, "a remote costs no request");
  assert.equal(await parents.parentOf({ repo: null }), null);
  gh.state.repos.set(FORK, { fork: true, parent: { full_name: UPSTREAM } });
  assert.equal(await parents.parentOf({ repo: FORK }), UPSTREAM);
  assert.equal(await parents.parentOf({ repo: "Ada/Widgets" }), UPSTREAM);
  assert.equal(gh.requests.length, 1, "asked once for a repository, whatever its spelling");
  assert.equal(await parents.parentOf({ repo: UPSTREAM, upstream: "ACME/widgets" }), null, "an upstream remote that is origin itself");
  assert.equal(await parents.parentOf({ repo: "acme/plain" }), null);
  // A parent GitHub names in characters no repository has is not a repository to ask.
  gh.state.repos.set("ada/odd", { fork: true, parent: { full_name: "acme/widgets/../../user" } });
  assert.equal(await parents.parentOf({ repo: "ada/odd" }), null);
});

test("ForkParents: when GitHub does not answer, nothing is kept as a no: it is asked again later, not at every pass", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  let now = 1_000_000;
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: TOKEN, source: "gh" }));
  const parents = new ForkParents(client, () => now);
  gh.state.repos.set(FORK, { fork: true, parent: { full_name: UPSTREAM } });
  gh.state.failNext.push({ pattern: /^\/repos\/ada\/widgets$/, status: 502, count: 1 });
  assert.equal(await parents.parentOf({ repo: FORK }), null);
  assert.equal(await parents.parentOf({ repo: FORK }), null, "not asked again at once");
  assert.equal(gh.requests.length, 1);
  now += 11 * 60_000;
  assert.equal(await parents.parentOf({ repo: FORK }), UPSTREAM);
});

test("the client asks for a fork's pull request by the fork owner's name, and reads a repository's parent", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: TOKEN, source: "gh" }));
  upstreamPull(gh);
  assert.deepEqual(await client.findOpenPull(UPSTREAM, "feat", "ada"), { kind: "ok", value: 7 });
  assert.match(gh.requests.at(-1)?.path ?? "", /^\/repos\/acme\/widgets\/pulls\?head=ada%3Afeat&/);
  assert.deepEqual(await client.findOpenPull(UPSTREAM, "feat"), { kind: "ok", value: null }, "the upstream repository has no branch feat of its own");
  gh.state.repos.set(FORK, { fork: true, private: false, parent: { full_name: UPSTREAM } });
  assert.deepEqual(await client.repoInfo(FORK), { kind: "ok", value: { fork: true, private: false, parent: UPSTREAM } });
  assert.deepEqual(await client.repoInfo(UPSTREAM), { kind: "ok", value: { fork: false, private: false, parent: null } });
});

test("readGitScope names the upstream remote when it is a GitHub repository other than origin, and nothing otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rio-fork-git-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "feat");
    git("remote", "add", "origin", "git@github.com:ada/widgets.git");
    assert.deepEqual(await readGitScope(dir), { repo: FORK, branch: "feat", pushed: null });
    git("remote", "add", "upstream", "https://github.com/acme/widgets.git");
    assert.deepEqual(await readGitScope(dir), { repo: FORK, branch: "feat", pushed: null, upstream: UPSTREAM });
    git("remote", "set-url", "upstream", "git@github.com:Ada/Widgets.git");
    assert.deepEqual(await readGitScope(dir), { repo: FORK, branch: "feat", pushed: null }, "an upstream that is origin");
    git("remote", "set-url", "upstream", "https://gitlab.com/acme/widgets.git");
    assert.deepEqual(await readGitScope(dir), { repo: FORK, branch: "feat", pushed: null }, "an upstream that is not on GitHub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the tools ---------------------------------------------------------------------------------------------------

test("ci_status and subscribe with no pull request named find the fork's pull request on the upstream repository", async () => {
  const t = await setup({ scope: AS_FORK });
  upstreamPull(t.gh);
  const status = await t.tools.call("ci_status", {});
  assert.notEqual(status.isError, true, status.text);
  assert.match(status.text, /acme\/widgets PR #7/);
  const sub = await t.tools.call("subscribe", {});
  assert.notEqual(sub.isError, true, sub.text);
  assert.match(sub.text, /^Subscribed to acme\/widgets PR #7/);
  // Named outright, the fork's own repository is the only one asked.
  const own = await t.tools.call("ci_status", { repo: FORK });
  assert.equal(own.isError, true);
  assert.match(own.text, /no open pull request for branch feat in ada\/widgets/);
});
