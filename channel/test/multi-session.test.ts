// N Claude Code sessions on one machine, each running the channel and watching the same pull request, must cost
// GitHub what one session costs, and each must still get every event. The pollers run in lockstep on one clock:
// each round the clock moves on by one poll interval and every session wakes at the same moment, which is the
// worst case for duplicated requests.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Config } from "../src/config.ts";
import type { ChannelMessage } from "../src/format.ts";
import { type GhAuth, GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { runPoller } from "../src/poller.ts";
import { SharedStore } from "../src/shared.ts";
import { Subscriptions } from "../src/subscriptions.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

const TOKEN = "gho_multiSessionToken123";
const SHA = "c".repeat(40);
const POLL_SECONDS = 20;

async function until(what: string, fn: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Runs `sessions` channels for `rounds` poll intervals; returns GitHub's request count and each session's events. */
async function run(sessions: number, rounds: number) {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setPull("octo-org/example", 7, { head: { ref: "feat", sha: SHA }, base: { ref: "main" } });
  gh.setRuns("octo-org/example", SHA, [{ id: 41, name: "CI", status: "in_progress" }]);
  const root = mkdtempSync(join(tmpdir(), "rio-multi-"));
  let t = 1_700_000_000_000;
  let asleep = 0;
  let wake: () => void = () => {};
  let woken = new Promise<void>((r) => (wake = r));
  const stop = new AbortController();
  const inboxes: ChannelMessage[][] = [];
  const done: Promise<void>[] = [];
  for (let i = 0; i < sessions; i++) {
    const auth: GhAuth = { kind: "ok", token: TOKEN, source: "gh" };
    const client = new GitHubClient(gh.base, async () => auth, fetch, { shared: new SharedStore(root), now: () => t });
    const inbox: ChannelMessage[] = [];
    inboxes.push(inbox);
    const config: Config = { githubApi: gh.base, projectDir: "/nowhere", autoSubscribe: "pr", pollSeconds: POLL_SECONDS, eventLogDir: null, rateFloor: 200 };
    done.push(
      runPoller({
        config,
        gh: client,
        subs: new Subscriptions(),
        readScope: async () => ({ repo: "octo-org/example", branch: "feat" }),
        notify: async (m) => void inbox.push(m),
        signal: stop.signal,
        sleep: async () => {
          asleep++;
          await woken;
        },
        baseEveryMs: 60_000,
      }),
    );
  }
  for (let round = 0; round < rounds; round++) {
    await until(`all ${sessions} asleep in round ${round}`, () => asleep === sessions);
    if (round === 2) gh.setRuns("octo-org/example", SHA, [{ id: 41, name: "CI", status: "completed", conclusion: "failure" }]);
    asleep = 0;
    t += POLL_SECONDS * 1000;
    const release = wake;
    woken = new Promise<void>((r) => (wake = r));
    release();
  }
  await until("the last round", () => asleep === sessions);
  stop.abort();
  wake();
  await Promise.all(done);
  return { requests: gh.requests.length, inboxes };
}

test("one, three and six sessions watching the same PR cost GitHub the same requests, and every session gets the failure", async () => {
  const one = await run(1, 6);
  const three = await run(3, 6);
  const six = await run(6, 6);
  assert.ok(one.requests > 0);
  if (process.env.SHOW_COUNTS) console.log(`requests: 1 session ${one.requests}, 3 sessions ${three.requests}, 6 sessions ${six.requests}`);
  assert.deepEqual([one.requests, three.requests, six.requests], [one.requests, one.requests, one.requests]);
  for (const { inboxes } of [one, three, six]) {
    for (const inbox of inboxes) {
      assert.ok(
        inbox.some((m) => m.meta.kind === "ci.workflow_failed"),
        `a session missed the failure: ${inbox.map((m) => m.meta.kind).join(", ")}`,
      );
    }
  }
});
