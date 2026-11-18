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

/** One session on a simulated clock; `step(n, before)` runs n passes, calling `before(pass)` ahead of each. */
async function session(gh: FakeGitHub) {
  let t = 1_700_000_000_000;
  let asleep = false;
  let wake: () => void = () => {};
  const stop = new AbortController();
  const inbox: ChannelMessage[] = [];
  const auth: GhAuth = { kind: "ok", token: TOKEN, source: "gh" };
  const client = new GitHubClient(gh.base, async () => auth, fetch, { now: () => t });
  const config: Config = { githubApi: gh.base, projectDir: "/nowhere", autoSubscribe: "pr", pollSeconds: PASS_MS / 1000, eventLogDir: null, rateFloor: 200 };
  const done = runPoller({
    config,
    gh: client,
    subs: new Subscriptions(),
    readScope: async () => ({ repo: "octo-org/example", branch: "feat" }),
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

test("a pull request whose CI has finished costs under 30 GitHub requests an hour", async () => {
  const gh = await quietPr();
  const s = await session(gh);
  await s.step(3); // the first look and its baseline
  const before = gh.requests.length;
  await s.step(180); // an hour
  await s.stop();
  const hour = gh.requests.slice(before);
  if (process.env.SHOW_COUNTS) console.log(`quiet hour: ${hour.length} requests`);
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
    if (s.inbox.some((m) => m.meta.kind === "ci.workflow_started")) seenAt = s.passes;
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
