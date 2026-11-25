// The cadence (cadence.ts) inside the poller, on a simulated clock: one pass every 20 s for an hour.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Config } from "../src/config.ts";
import type { ChannelMessage } from "../src/format.ts";
import { type GhAuth, GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { runPoller } from "../src/poller.ts";
import { Subscriptions } from "../src/subscriptions.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

const TOKEN = "gho_cadenceToken1234567";
const A = "a".repeat(40);
const B = "b".repeat(40);
const PASS_MS = 20_000;

async function until(what: string, fn: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * The clone's git, as the poller reads it: the folder's branch, its `origin/<branch>` (git.ts `pushed`), and, when
 * `remotes` is given, `refs/remotes/origin/<b>` for any branch (git.ts `readPushed`), which a push from a worktree
 * of the clone moves.
 */
interface Clone {
  branch?: string;
  pushed?: string | null;
  remotes?: Record<string, string | null>;
}

/** One session on a simulated clock; `step(n, before)` runs n passes, calling `before(pass)` ahead of each. */
async function session(gh: FakeGitHub, scope: Clone = {}) {
  let t = 1_700_000_000_000;
  let asleep = false;
  let wake: () => void = () => {};
  const stop = new AbortController();
  const inbox: ChannelMessage[] = [];
  const auth: GhAuth = { kind: "ok", token: TOKEN, source: "gh" };
  const client = new GitHubClient(gh.base, async () => auth, fetch, { now: () => t });
  const config: Config = { githubApi: gh.base, projectDir: "/nowhere", autoSubscribe: "pr", pollSeconds: PASS_MS / 1000, eventLogDir: null, rateFloor: 200 };
  const subs = new Subscriptions();
  const done = runPoller({
    config,
    gh: client,
    subs,
    readScope: async () => ({ repo: "octo-org/example", branch: scope.branch ?? "feat", ...(scope.pushed !== undefined ? { pushed: scope.pushed } : {}) }),
    ...(scope.remotes
      ? { readPushed: async (branches: readonly string[]) => new Map(branches.map((b) => [b, scope.remotes?.[b] ?? null] as const)) }
      : {}),
    notify: async (m) => void inbox.push(m),
    signal: stop.signal,
    now: () => t,
    sleep: () =>
      new Promise<void>((r) => {
        asleep = true;
        wake = r;
      }),
  });
  let pass = 0;
  return {
    inbox,
    subs,
    get passes() {
      return pass;
    },
    async step(n: number, before: (pass: number) => void = () => {}) {
      for (let i = 0; i < n; i++) {
        await until(`pass ${pass} asleep`, () => asleep);
        before(pass);
        asleep = false;
        t += PASS_MS;
        pass++;
        wake();
      }
      await until("the last pass", () => asleep);
    },
    async stop() {
      stop.abort();
      wake();
      await done;
    },
  };
}

async function quietPr() {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setPull("octo-org/example", 7, { head: { ref: "feat", sha: A }, base: { ref: "main" }, updated_at: "2026-01-01T00:00:00Z" });
  gh.setRuns("octo-org/example", A, [{ id: 41, name: "CI", status: "completed", conclusion: "success" }]);
  gh.setBaseRuns("octo-org/example", "main", [{ id: 1, name: "CI", status: "completed", conclusion: "success" }]);
  return gh;
}

test("a pull request whose CI has finished costs under 30 REST requests an hour, and about 60 GraphQL points", async () => {
  const gh = await quietPr();
  const s = await session(gh);
  await s.step(3); // the first look and its baseline
  const before = gh.requests.length;
  await s.step(180); // an hour
  await s.stop();
  // REST and GraphQL are separate hourly budgets; the review read (reviews.ts) is GraphQL's, about once a minute.
  const all = gh.requests.slice(before);
  const hour = all.filter((r) => r.path !== "/graphql");
  const graphql = all.length - hour.length;
  if (process.env.SHOW_COUNTS) console.log(`quiet hour: ${hour.length} REST requests, ${graphql} GraphQL`);
  assert.ok(graphql >= 55 && graphql <= 61, `${graphql} GraphQL reads in an hour`);
  assert.ok(hour.length < 30, `${hour.length} requests in a quiet hour: ${[...new Set(hour.map((r) => r.path.split("?")[0]))].join(", ")}`);
});

test("a push to a finished PR is seen within five minutes, and its failure within one pass of GitHub's", async () => {
  const gh = await quietPr();
  const s = await session(gh);
  await s.step(90); // half an hour of quiet: the slowest cadence
  let pushedAt = -1;
  let seenAt = -1;
  await s.step(1, (p) => {
    pushedAt = p;
    gh.setPull("octo-org/example", 7, { head: { ref: "feat", sha: B }, base: { ref: "main" }, updated_at: "2026-01-01T00:30:00Z" });
    gh.setRuns("octo-org/example", B, [{ id: 42, name: "CI", status: "in_progress" }]);
  });
  for (let i = 0; i < 20 && seenAt < 0; i++) {
    await s.step(1);
    // Seen: the watch holds the new head. (The automatic watch no longer pushes ci.workflow_started by default.)
    if (s.subs.list()[0]?.last?.headSha === B) seenAt = s.passes;
  }
  assert.ok(seenAt > 0 && (seenAt - pushedAt) * PASS_MS <= 300_000, `the push was seen ${(seenAt - pushedAt) * 20} s later`);
  let failedAt = -1;
  await s.step(1, (p) => {
    failedAt = p;
    gh.setRuns("octo-org/example", B, [{ id: 42, name: "CI", status: "completed", conclusion: "failure" }]);
  });
  await s.step(1);
  await s.stop();
  assert.ok(s.inbox.some((m) => m.meta.kind === "ci.workflow_failed"), "the failure was sent at the next pass, while the PR was running");
  assert.ok(failedAt > 0);
});

test("the session's own push to a settled PR is seen at once, and its failure within the next pass", async () => {
  const gh = await quietPr();
  // The clone's origin/feat, as git.ts reads it: what `git push` from the session's folder moves.
  const scope: { pushed?: string | null } = { pushed: A };
  const s = await session(gh, scope);
  await s.step(90); // half an hour of quiet: the slowest cadence, a look every five minutes
  const pulls = () => gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
  let pushedAt = -1;
  let seenAt = -1;
  await s.step(1, (p) => {
    pushedAt = p;
    scope.pushed = B;
    gh.setPull("octo-org/example", 7, { head: { ref: "feat", sha: B }, base: { ref: "main" }, updated_at: "2026-01-01T00:30:00Z" });
    gh.setRuns("octo-org/example", B, []); // CI has not registered yet
  });
  if (s.subs.list()[0]?.last?.headSha === B) seenAt = s.passes;
  assert.equal(seenAt - pushedAt, 1, `the push was seen ${(seenAt - pushedAt) * 20} s later, not at the pass it was made`);
  // CI registers a minute later and fails: on the fast beat, it arrives at the next pass, not after a pending minute.
  const before = pulls();
  await s.step(3);
  assert.equal(pulls() - before, 3, "looked at every pass after the push, before CI started");
  await s.step(1, () => gh.setRuns("octo-org/example", B, [{ id: 42, name: "CI", status: "completed", conclusion: "failure" }]));
  assert.ok(s.inbox.some((m) => m.meta.kind === "ci.workflow_failed"), "the failure was sent at the next pass");
  // Five minutes after the push the fast beat ends, and a settled PR is looked at as before.
  await s.step(15);
  const quiet = pulls();
  await s.step(5);
  await s.stop();
  assert.ok(pulls() - quiet <= 1, `${pulls() - quiet} looks in 100 s after the fast beat ended`);
});

test("a push from a worktree of the session's clone to a settled PR is seen at once, and only that PR goes fast", async () => {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  const C = "c".repeat(40);
  gh.setPull("octo-org/example", 7, { head: { ref: "feat-a", sha: A }, base: { ref: "main" }, updated_at: "2026-01-01T00:00:00Z" });
  gh.setPull("octo-org/example", 8, { head: { ref: "feat-b", sha: C }, base: { ref: "main" }, updated_at: "2026-01-01T00:00:00Z" });
  gh.setRuns("octo-org/example", A, [{ id: 41, name: "CI", status: "completed", conclusion: "success" }]);
  gh.setRuns("octo-org/example", C, [{ id: 43, name: "CI", status: "completed", conclusion: "success" }]);
  gh.setBaseRuns("octo-org/example", "main", [{ id: 1, name: "CI", status: "completed", conclusion: "success" }]);
  // The folder is on a third branch, with no pull request; both PRs were subscribed by Claude. Worktrees share
  // refs/remotes with their clone, so a push from a worktree moves origin/feat-a here.
  const clone: Clone = { branch: "chore", pushed: null, remotes: { "feat-a": A, "feat-b": C } };
  const s = await session(gh, clone);
  s.subs.add({ repo: "octo-org/example", pr: 7, source: "tool" });
  s.subs.add({ repo: "octo-org/example", pr: 8, source: "tool" });
  await s.step(90); // half an hour of quiet: the slowest cadence, a look every five minutes
  const pulls = (n: number) => gh.requests.filter((r) => r.path === `/repos/octo-org/example/pulls/${n}`).length;
  const pr7 = () => s.subs.list().find((e) => e.pr === 7);
  let pushedAt = -1;
  await s.step(1, (p) => {
    pushedAt = p;
    if (clone.remotes) clone.remotes["feat-a"] = B;
    gh.setPull("octo-org/example", 7, { head: { ref: "feat-a", sha: B }, base: { ref: "main" }, updated_at: "2026-01-01T00:30:00Z" });
    gh.setRuns("octo-org/example", B, []); // CI has not registered yet
  });
  assert.equal(pr7()?.last?.headSha, B, `the worktree push was not seen at the pass after it (pass ${pushedAt})`);
  const before7 = pulls(7);
  const before8 = pulls(8);
  await s.step(3);
  assert.equal(pulls(7) - before7, 3, "the pushed PR is looked at every pass after the push");
  assert.ok(pulls(8) - before8 <= 1, `the PR nobody pushed to stayed on its slow beat (${pulls(8) - before8} looks in 60 s)`);
  await s.step(1, () => gh.setRuns("octo-org/example", B, [{ id: 42, name: "CI", status: "completed", conclusion: "failure" }]));
  assert.ok(s.inbox.some((m) => m.meta.kind === "ci.workflow_failed" && m.meta.pr === "7"), "the failure was sent at the next pass");
  // Five minutes after the push the fast beat ends.
  await s.step(15);
  const quiet = pulls(7);
  await s.step(5);
  await s.stop();
  assert.ok(pulls(7) - quiet <= 1, `${pulls(7) - quiet} looks in 100 s after the fast beat ended`);
});

test("a ref the clone first reads for a PR is a baseline, not a push, and reading every pass costs no GitHub request", async () => {
  // Two identical sessions with the folder on a branch of its own; only the first reads each watched PR's origin/<headRef>.
  const hour = async (clone: Clone) => {
    const gh = await quietPr();
    const s = await session(gh, clone);
    s.subs.add({ repo: "octo-org/example", pr: 7, source: "tool" });
    await s.step(90);
    const pulls = () => gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
    const before = pulls();
    await s.step(10); // a clone that already had origin/feat: its first reading must not put the PR on the fast beat
    const looks = pulls() - before;
    const from = gh.requests.length;
    await s.step(180);
    await s.stop();
    return { looks, requests: gh.requests.length - from };
  };
  const reading = await hour({ branch: "chore", pushed: null, remotes: { feat: A } });
  const without = await hour({ branch: "chore", pushed: null });
  assert.ok(reading.looks <= 1, `${reading.looks} looks in 200 s of quiet`);
  assert.equal(reading.requests, without.requests, "the refs are read from git, so a quiet hour costs what it did without them");
});

test("a push the session did not make does not change the cadence; the first reading of origin/<branch> is a baseline", async () => {
  const gh = await quietPr();
  const scope: { pushed?: string | null } = { pushed: null }; // no origin/feat yet
  const s = await session(gh, scope);
  await s.step(90);
  const pulls = () => gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
  const before = pulls();
  await s.step(10); // nothing moved: a settled PR is not looked at every pass
  await s.stop();
  assert.ok(pulls() - before <= 1, `${pulls() - before} looks in 200 s of quiet`);
});

test("while CI runs, the PR is looked at every pass", async () => {
  const gh = await quietPr();
  gh.setRuns("octo-org/example", A, [{ id: 41, name: "CI", status: "in_progress" }]);
  const s = await session(gh);
  await s.step(3);
  const before = gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
  await s.step(30);
  await s.stop();
  const after = gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
  assert.equal(after - before, 30);
});

test("with 15% of the rate limit left, a finished PR is read less often; with plenty it is read as before", async () => {
  const hourAt = async (remaining: number) => {
    const gh = await quietPr();
    gh.setRate(remaining);
    const s = await session(gh);
    await s.step(3);
    const before = gh.requests.length;
    await s.step(180);
    await s.stop();
    return gh.requests.length - before;
  };
  const plenty = await hourAt(4000);
  const low = await hourAt(750);
  if (process.env.SHOW_COUNTS) console.log(`quiet hour: ${plenty} requests with plenty left, ${low} at 15%`);
  assert.ok(low < plenty, `${low} at 15% left, ${plenty} with plenty`);
  assert.ok(low >= plenty / 2, `15% left stretches by a third, not more: ${low} vs ${plenty}`);
});

test("at 10% left, a finished PR, its base and the search for a new PR pause, and resume when the limit resets", async () => {
  const gh = await quietPr();
  const s = await session(gh);
  await s.step(3);
  const resetAt = 1_700_000_000 + 25 * 60; // the session's clock starts at 1_700_000_000 s
  gh.setRate(400, 5000, resetAt); // 8%
  // the reading changes only with an answer: wait for the next look at the finished PR to bring it
  const rest = () => gh.requests.filter((r) => r.path !== "/graphql").length;
  const asked = rest();
  for (let i = 0; i < 20 && rest() === asked; i++) await s.step(1);
  assert.ok(rest() > asked, "the PR was looked at again");
  await s.step(1);
  const before = gh.requests.length;
  const pausedFor = resetAt * 1000 - 1_700_000_000_000 - s.passes * PASS_MS - PASS_MS;
  await s.step(Math.floor(pausedFor / PASS_MS)); // until just before the reset
  const paused = gh.requests.slice(before).filter((r) => r.path !== "/graphql"); // GraphQL's budget is its own
  assert.deepEqual(paused.map((r) => r.path), [], "nothing read for a finished PR while paused");
  // GitHub refills the limit only at x-ratelimit-reset, and nothing paused asks it again, so the reading is void
  // once that time passes: without that, a paused session would stay paused for ever.
  gh.setRate(4999, 5000, resetAt + 3600);
  await s.step(30);
  await s.stop();
  assert.ok(gh.requests.length > before, "reads resumed after the reset");
});

test("below the pause line, a PR whose CI is running is still read, at a stretched pace, and its failure still arrives", async () => {
  const gh = await quietPr();
  gh.setRuns("octo-org/example", A, [{ id: 41, name: "CI", status: "in_progress" }]);
  const s = await session(gh);
  await s.step(3);
  gh.setRate(375); // 7.5%: four times slower, and paused
  await s.step(2);
  const pulls = () => gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
  const bases = () => gh.requests.filter((r) => r.path.includes("branch=main")).length;
  const p0 = pulls();
  const b0 = bases();
  await s.step(40);
  const read = pulls() - p0;
  assert.ok(read >= 8 && read <= 12, `read ${read} times in 40 passes, four times slower than every pass`);
  assert.equal(bases() - b0, 0, "the base is not read while paused");
  gh.setRuns("octo-org/example", A, [{ id: 41, name: "CI", status: "completed", conclusion: "failure" }]);
  await s.step(5);
  await s.stop();
  assert.ok(s.inbox.some((m) => m.meta.kind === "ci.workflow_failed"), "the failure arrived while paused");
});

const quietReviews = (gh: FakeGitHub, over: Record<string, unknown> = {}) =>
  gh.setReviewPull("octo-org/example", 7, { headRefOid: A, mergeStateStatus: "BLOCKED", reviewDecision: null, latestOpinionatedReviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over });

test("reviews are read about once a minute, and an approval arrives within about a minute", async () => {
  const gh = await quietPr();
  quietReviews(gh);
  const s = await session(gh);
  await s.step(3);
  const before = gh.requests.filter((r) => r.path === "/graphql").length;
  await s.step(30); // ten minutes
  const reads = gh.requests.filter((r) => r.path === "/graphql").length - before;
  assert.ok(reads >= 9 && reads <= 11, `${reads} GraphQL reads in ten minutes`);
  let approvedAt = -1;
  await s.step(1, (p) => {
    approvedAt = p;
    quietReviews(gh, { latestOpinionatedReviews: { nodes: [{ id: "R1", state: "APPROVED", authorAssociation: "MEMBER", author: { login: "alice", __typename: "User" } }] } });
  });
  let seenAt = -1;
  for (let i = 0; i < 6 && seenAt < 0; i++) {
    if (s.inbox.some((m) => m.meta.kind === "pr.approved")) seenAt = s.passes;
    else await s.step(1);
  }
  await s.stop();
  assert.ok(seenAt > 0 && (seenAt - approvedAt) * PASS_MS <= 80_000, `seen ${(seenAt - approvedAt) * 20} s later`);
});

test("at 10% of GraphQL's own budget the review reads pause, and the REST reads go on", async () => {
  const gh = await quietPr();
  quietReviews(gh);
  gh.setGraphqlRate(400);
  gh.setRuns("octo-org/example", A, [{ id: 41, name: "CI", status: "in_progress" }]);
  const s = await session(gh);
  await s.step(3); // the first review read brings the reading
  const g0 = gh.requests.filter((r) => r.path === "/graphql").length;
  const p0 = gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length;
  await s.step(30);
  await s.stop();
  assert.equal(gh.requests.filter((r) => r.path === "/graphql").length - g0, 0, "no review read while GraphQL's budget is low");
  assert.equal(gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7").length - p0, 30, "the PR's REST reads are unaffected");
});
