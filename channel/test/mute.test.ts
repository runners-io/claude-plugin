// A per-session mute: a session not interested in some events says so, and only that session stops hearing them.
// Today's gap first: unsubscribing the branch's own pull request did not stick, because the automatic watch found it
// again within minutes.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Config } from "../src/config.ts";
import type { ChannelMessage } from "../src/format.ts";
import type { GitScope } from "../src/git.ts";
import { GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import type { EventLog } from "../src/eventlog.ts";
import { runPoller } from "../src/poller.ts";
import { MAX_MUTES, Subscriptions } from "../src/subscriptions.ts";
import { makeTools } from "../src/tools.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

const SHA = "f".repeat(40);
const TOKEN = "gho_fakeToken123";

async function until(what: string, fn: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Rec = { type: string } & Record<string, unknown>;

type HookRequest = { repo: string; pr: number; at: number };

async function setup(opts: { autoSubscribe?: "pr" | "off"; branch?: string | null; hookRequests?: HookRequest[]; allDoneHoldMs?: number } = {}) {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setPull("acme/widgets", 7, { head: { ref: "feat", sha: SHA } });
  gh.setRuns("acme/widgets", SHA, [
    { id: 41, name: "CI", status: "queued" },
    { id: 42, name: "Lint", status: "queued" },
  ]);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: TOKEN, source: "gh" }));
  const subs = new Subscriptions();
  const scope = { current: { repo: "acme/widgets", branch: opts.branch === undefined ? "feat" : opts.branch } as GitScope };
  const config: Config = { githubApi: gh.base, projectDir: "/nowhere", autoSubscribe: opts.autoSubscribe ?? "pr", pollSeconds: 20, eventLogDir: null, rateFloor: 200, reviewRequests: false };
  const messages: ChannelMessage[] = [];
  const records: Rec[] = [];
  const eventLog: EventLog = { write: (type, fields = {}) => void records.push({ type, ...fields }) };
  const stop = new AbortController();
  let passes = 0;
  const done = runPoller({
    config,
    gh: client,
    subs,
    readScope: async () => scope.current,
    notify: async (m) => {
      messages.push(m);
    },
    signal: stop.signal,
    sleep: () => {
      passes++;
      return new Promise((r) => setTimeout(r, 5));
    },
    eventLog,
    baseEveryMs: 0,
    lookEveryMs: () => 0,
    allDoneHoldMs: opts.allDoneHoldMs ?? 0,
    baseIdleMs: 0,
    ...(opts.hookRequests ? { takeHookRequests: () => (opts.hookRequests as HookRequest[]).splice(0) } : {}),
    reviewEveryMs: 0,
    requestsEveryMs: 0,
  });
  const tools = makeTools({ subs, gh: client, readScope: async () => scope.current, eventLog });
  return {
    gh,
    subs,
    scope,
    messages,
    records,
    tools,
    kinds: () => messages.map((m) => m.meta.kind),
    /** Waits for `n` more whole passes of the poller. */
    async passes(n: number) {
      const target = passes + n + 1;
      await until(`${n} passes`, () => passes >= target);
    },
    async stop() {
      stop.abort();
      await done;
    },
  };
}

const finish = (t: Awaited<ReturnType<typeof setup>>, lint = "success") =>
  t.gh.setRuns("acme/widgets", SHA, [
    { id: 41, name: "CI", status: "completed", conclusion: "success" },
    { id: 42, name: "Lint", status: "completed", conclusion: lint },
  ]);

test("unsubscribing the branch's own pull request sticks until the branch changes", async () => {
  const t = await setup();
  try {
    t.gh.setPull("acme/widgets", 8, { head: { ref: "other", sha: SHA } });
    await until("PR 7 watched", () => t.subs.list().some((e) => e.pr === 7 && e.source === "auto"));
    const r = await t.tools.call("unsubscribe", { repo: "acme/widgets", pr: 7 });
    assert.ok(!r.isError, r.text);
    await t.passes(5);
    assert.deepEqual(t.subs.list(), [], "the automatic watch did not add it back");
    assert.match((await t.tools.call("list_subscriptions", {})).text, /acme\/widgets PR #7/, "the mute is listed");
    // A branch change ends that mute: back on the branch, its pull request is watched again.
    t.scope.current = { repo: "acme/widgets", branch: "other" };
    await until("PR 8 watched", () => t.subs.list().some((e) => e.pr === 8));
    t.scope.current = { repo: "acme/widgets", branch: "feat" };
    await until("PR 7 watched again", () => t.subs.list().some((e) => e.pr === 7));
  } finally {
    await t.stop();
  }
});

test("a PR muted with mute is never added by the automatic watch, across a branch change, and unmute lets it in", async () => {
  const t = await setup({ branch: "main" });
  try {
    const r = await t.tools.call("mute", { repo: "acme/widgets", pr: 7 });
    assert.ok(!r.isError, r.text);
    await t.passes(1);
    t.scope.current = { repo: "acme/widgets", branch: "feat" };
    await t.passes(5);
    assert.deepEqual(t.subs.list(), []);
    assert.ok(!(await t.tools.call("unmute", { repo: "acme/widgets", pr: 7 })).isError);
    await until("PR 7 watched", () => t.subs.list().some((e) => e.pr === 7));
  } finally {
    await t.stop();
  }
});

test("a kinds mute holds back those kinds on every PR, logged as filtered for muted; the rest still arrive", async () => {
  const t = await setup({ autoSubscribe: "off" });
  try {
    await t.tools.call("subscribe", { repo: "acme/widgets", pr: 7 });
    await until("baseline", () => t.subs.list()[0]?.last != null);
    assert.ok(!(await t.tools.call("mute", { kinds: ["ci.workflow_succeeded"] })).isError);
    finish(t);
    await until("all done", () => t.kinds().includes("ci.run_all_done"));
    assert.equal(t.kinds().includes("ci.workflow_succeeded"), false, t.kinds().join());
    const muted = t.records.filter((x) => x.type === "event" && x.outcome === "filtered" && x.reason === "muted");
    assert.deepEqual(muted.map((x) => x.kind), ["ci.workflow_succeeded", "ci.workflow_succeeded"]);
  } finally {
    await t.stop();
  }
});

test("a workflow mute holds back that workflow's events only, matched on its cleaned name", async () => {
  const t = await setup({ autoSubscribe: "off" });
  try {
    await t.tools.call("subscribe", { repo: "acme/widgets", pr: 7 });
    await until("baseline", () => t.subs.list()[0]?.last != null);
    assert.ok(!(await t.tools.call("mute", { workflow: "Lint" })).isError);
    finish(t, "failure");
    await until("all done", () => t.kinds().includes("ci.run_all_done"));
    const workflows = t.messages.filter((m) => m.meta.workflow).map((m) => `${m.meta.kind} ${m.meta.workflow}`);
    assert.deepEqual(workflows, ["ci.workflow_succeeded CI"]);
    assert.ok(t.records.some((x) => x.type === "event" && x.reason === "muted" && x.workflow === "Lint" && x.kind === "ci.workflow_failed"));
  } finally {
    await t.stop();
  }
});

test("a repo, pr and kinds mute holds back those kinds on that PR only", async () => {
  const t = await setup({ autoSubscribe: "off" });
  try {
    const sha8 = "e".repeat(40);
    t.gh.setPull("acme/widgets", 8, { head: { ref: "other", sha: sha8 } });
    t.gh.setRuns("acme/widgets", sha8, [{ id: 51, name: "CI", status: "queued" }]);
    assert.ok(!(await t.tools.call("subscribe", { repo: "acme/widgets", pr: 7 })).isError);
    assert.ok(!(await t.tools.call("subscribe", { repo: "acme/widgets", pr: 8 })).isError);
    assert.ok(!(await t.tools.call("mute", { repo: "acme/widgets", pr: 7, kinds: ["ci.workflow_succeeded", "ci.run_all_done"] })).isError);
    finish(t);
    t.gh.setRuns("acme/widgets", sha8, [{ id: 51, name: "CI", status: "completed", conclusion: "success" }]);
    await until("PR 8 done", () => t.messages.some((m) => m.meta.pr === "8" && m.meta.kind === "ci.run_all_done"));
    await t.passes(2);
    assert.deepEqual(t.messages.filter((m) => m.meta.pr === "7").map((m) => m.meta.kind), []);
    assert.deepEqual(t.messages.filter((m) => m.meta.pr === "8").map((m) => m.meta.kind), ["ci.workflow_succeeded", "ci.run_all_done"]);
  } finally {
    await t.stop();
  }
});

test("mute checks what it is given, says what it did, and keeps at most 50", async () => {
  const t = await setup({ autoSubscribe: "off" });
  try {
    for (const bad of [{}, { repo: "acme/widgets" }, { repo: "not a repo", pr: 1 }, { pr: 0 }, { kinds: [] }, { kinds: ["ci.nope"] }, { workflow: "" }, { workflow: 3 }]) {
      const r = await t.tools.call("mute", bad);
      assert.equal(r.isError, true, `${JSON.stringify(bad)}: ${r.text}`);
    }
    assert.equal(MAX_MUTES, 50);
    for (let i = 1; i <= MAX_MUTES; i++) {
      const r = await t.tools.call("mute", { repo: "acme/widgets", pr: i });
      assert.ok(!r.isError, `${i}: ${r.text}`);
    }
    const full = await t.tools.call("mute", { repo: "acme/widgets", pr: 51 });
    assert.equal(full.isError, true);
    assert.match(full.text, /50/);
    assert.match(full.text, /unmute/);
    const list = (await t.tools.call("list_subscriptions", {})).text;
    assert.match(list, /acme\/widgets PR #50/);
    assert.ok(!(await t.tools.call("unmute", { all: true })).isError);
    assert.doesNotMatch((await t.tools.call("list_subscriptions", {})).text, /PR #50/);
    assert.ok(t.records.some((x) => x.type === "mute"), "a mute is in the event log");
  } finally {
    await t.stop();
  }
});

test("the instructions mention mute and unmute", async () => {
  const { INSTRUCTIONS } = await import("../src/instructions.ts");
  assert.match(INSTRUCTIONS, /\bmute\b/);
  assert.match(INSTRUCTIONS, /\bunmute\b/);
});

// A pull request opened in the session (gh pr create) is usually handed over by the hook before the branch's
// automatic watch finds it, and the automatic watch cannot replace a hook's or Claude's subscription. So the quiet
// default and the sticky unsubscribe have to hold whichever of the three holds the branch's pull request.
const SHA9 = "9".repeat(40);
const recent = () => new Date(Date.now() - 60_000).toISOString();

test("a PR the hook handed over gets the automatic watch's kinds: no ci.workflow_succeeded", async () => {
  const hookRequests: HookRequest[] = [];
  const t = await setup({ branch: "no-pr-here", hookRequests });
  try {
    t.gh.setPull("acme/widgets", 9, { head: { ref: "scripted", sha: SHA9 }, created_at: recent() });
    t.gh.setRuns("acme/widgets", SHA9, [{ id: 91, name: "CI", status: "queued" }]);
    hookRequests.push({ repo: "acme/widgets", pr: 9, at: Date.now() });
    await until("PR 9 watched", () => t.subs.list().some((e) => e.pr === 9 && e.source === "hook" && e.last !== null));
    t.gh.setRuns("acme/widgets", SHA9, [{ id: 91, name: "CI", status: "completed", conclusion: "success" }]);
    await until("all done", () => t.kinds().includes("ci.run_all_done"));
    assert.equal(t.kinds().includes("ci.workflow_succeeded"), false, `${t.kinds()}`);
    assert.ok(t.records.some((r) => r.type === "event" && r.kind === "ci.workflow_succeeded" && r.outcome === "filtered"));
    const sub = t.records.find((r) => r.type === "subscribe" && r.pr === 9);
    assert.notEqual(sub?.events, "all", "logged with the kinds it gets");
  } finally {
    await t.stop();
  }
});

for (const how of ["hook", "tool"] as const) {
  test(`unsubscribing the branch's own pull request sticks when ${how === "hook" ? "the hook" : "Claude's subscribe"} holds it`, async () => {
    const hookRequests: HookRequest[] = [];
    const t = await setup({ branch: how === "hook" ? "main" : "feat", hookRequests });
    try {
      t.gh.setPull("acme/widgets", 7, { created_at: recent() });
      if (how === "hook") {
        // Handed over while the session is on another branch, then the session switches to the PR's branch.
        hookRequests.push({ repo: "acme/widgets", pr: 7, at: Date.now() });
        await until("PR 7 watched", () => t.subs.list().some((e) => e.pr === 7 && e.source === "hook" && e.last !== null));
        t.scope.current = { repo: "acme/widgets", branch: "feat" };
        await t.passes(2);
      } else {
        await until("PR 7 watched", () => t.subs.list().some((e) => e.pr === 7 && e.source === "auto"));
        assert.ok(!(await t.tools.call("subscribe", { repo: "acme/widgets", pr: 7 })).isError);
      }
      assert.equal(t.subs.get("acme/widgets", 7)?.source, how);
      const r = await t.tools.call("unsubscribe", { repo: "acme/widgets", pr: 7 });
      assert.match(r.text, /until the branch changes/, r.text);
      await t.passes(5);
      assert.equal(t.subs.get("acme/widgets", 7), undefined, "the automatic watch did not add it back");
    } finally {
      await t.stop();
    }
  });
}

// git answers no branch mid-rebase, and nothing at all when it times out: neither is the session leaving the branch.
for (const blank of [null, ""]) {
  test(`a branch git cannot read for a moment (${JSON.stringify(blank)}) is no branch change`, async () => {
    const t = await setup();
    try {
      await until("PR 7 watched", () => t.subs.list().some((e) => e.pr === 7 && e.source === "auto"));
      t.scope.current = { repo: "acme/widgets", branch: blank as string | null };
      await t.passes(3);
      t.scope.current = { repo: "acme/widgets", branch: "feat" };
      await t.passes(1);
      assert.ok(t.subs.get("acme/widgets", 7), "the automatic watch stayed");
      assert.equal(t.records.some((r) => r.type === "unsubscribe" && r.pr === 7), false, "never unsubscribed");
      // The mute an unsubscribe leaves survives it too.
      assert.ok(!(await t.tools.call("unsubscribe", { repo: "acme/widgets", pr: 7 })).isError);
      t.scope.current = { repo: "acme/widgets", branch: blank as string | null };
      await t.passes(3);
      t.scope.current = { repo: "acme/widgets", branch: "feat" };
      await t.passes(5);
      assert.equal(t.subs.get("acme/widgets", 7), undefined, "still muted");
    } finally {
      await t.stop();
    }
  });
}

test("a held all done survives a branch git cannot read for a moment", async () => {
  const t = await setup({ allDoneHoldMs: 1500 });
  try {
    await until("PR 7 watched", () => t.subs.list().some((e) => e.pr === 7 && e.last !== null));
    finish(t);
    await until("both finished", () => t.subs.get("acme/widgets", 7)?.last?.runs.every((r) => r.status === "completed") === true);
    t.scope.current = { repo: "acme/widgets", branch: null };
    await t.passes(3);
    t.scope.current = { repo: "acme/widgets", branch: "feat" };
    await until("all done", () => t.kinds().includes("ci.run_all_done"));
    assert.deepEqual(t.kinds(), ["ci.run_all_done"]);
  } finally {
    await t.stop();
  }
});

// A base-branch event names every watched PR on that base. Muting one of them is not muting the base.
test("muting one PR does not hold back base.red for another PR on the same base", async () => {
  const t = await setup({ autoSubscribe: "off" });
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  try {
    const SHA8 = "8".repeat(40);
    t.gh.setPull("acme/widgets", 7, { base: { ref: "main" } });
    t.gh.setPull("acme/widgets", 8, { head: { ref: "other", sha: SHA8 }, base: { ref: "main" } });
    t.gh.setRuns("acme/widgets", SHA8, [{ id: 81, name: "CI", status: "queued" }]);
    t.gh.setBaseRuns("acme/widgets", "main", [{ id: 1, name: "CI", status: "completed", conclusion: "success", created_at: at(10), updated_at: at(9) }]);
    assert.ok(!(await t.tools.call("subscribe", { repo: "acme/widgets", pr: 7 })).isError);
    assert.ok(!(await t.tools.call("subscribe", { repo: "acme/widgets", pr: 8 })).isError);
    assert.ok(!(await t.tools.call("mute", { repo: "acme/widgets", pr: 7 })).isError);
    await until("base read", () => t.gh.requests.some((r) => r.path.includes("branch=main")));
    await t.passes(2);
    t.gh.setBaseRuns("acme/widgets", "main", [{ id: 2, name: "CI", status: "completed", conclusion: "failure", created_at: at(2), updated_at: at(1) }]);
    await until("base.red", () => t.kinds().includes("base.red"));
    assert.equal(t.messages.find((m) => m.meta.kind === "base.red")?.meta.pr, "8", "said about the PR that is not muted");
    // The control: with every PR on the base muted, the base event is held back, and logged as muted.
    assert.ok(!(await t.tools.call("mute", { repo: "acme/widgets", pr: 8 })).isError);
    t.gh.setBaseRuns("acme/widgets", "main", [{ id: 3, name: "CI", status: "completed", conclusion: "success", created_at: at(1), updated_at: at(0) }]);
    await until("base.green muted", () => t.records.some((r) => r.type === "event" && r.kind === "base.green" && r.reason === "muted"));
    assert.equal(t.kinds().includes("base.green"), false);
  } finally {
    await t.stop();
  }
});
