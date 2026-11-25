// A repository scope, end to end against the fake GitHub: the poller reads the repository's open pull requests and
// holds each one the scope covers as an ordinary subscription. No test here calls subscribe for a pull request.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Config } from "../src/config.ts";
import type { EventLog } from "../src/eventlog.ts";
import type { ChannelMessage } from "../src/format.ts";
import { GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { runPoller } from "../src/poller.ts";
import { type Involves, ScopeStore } from "../src/scopes.ts";
import { MAX_SUBSCRIPTIONS, Subscriptions } from "../src/subscriptions.ts";
import { makeTools } from "../src/tools.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

const TOKEN = "gho_fakeToken123";
const REPO = "acme/widgets";
const LIST = "/repos/acme/widgets/pulls?state=open&per_page=100";
const sha = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

async function until(what: string, fn: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 120));

type Rec = { type: string } & Record<string, unknown>;

async function setup(opts: { involves?: Involves; total?: number; pulls?: number[]; scope?: boolean } = {}) {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  // Every pull request here is somebody else's unless a test says otherwise; the signed-in login is octocat.
  const open = (n: number, fields: Record<string, unknown> = {}) =>
    gh.setPull(REPO, n, { head: { ref: `branch-${n}`, sha: sha(n) }, user: { login: "someone-else" }, base: { ref: "main" }, ...fields });
  for (const n of opts.pulls ?? []) open(n);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: TOKEN, source: "gh" }));
  const subs = new Subscriptions();
  const scopes = new ScopeStore(null);
  if (opts.scope !== false) scopes.add({ kind: "repo", repo: REPO, involves: opts.involves ?? "all", events: "all" });
  const config: Config = { githubApi: gh.base, projectDir: "/nowhere", autoSubscribe: "off", pollSeconds: 20, eventLogDir: null, rateFloor: 200, reviewRequests: false };
  const messages: ChannelMessage[] = [];
  const records: Rec[] = [];
  const eventLog: EventLog = { write: (type, fields = {}) => void records.push({ type, ...fields }) };
  const readScope = async () => ({ repo: REPO, branch: "main" });
  const stop = new AbortController();
  const done = runPoller({
    config,
    gh: client,
    subs,
    scopes,
    readScope,
    notify: async (m) => {
      messages.push(m);
    },
    signal: stop.signal,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    eventLog,
    lookEveryMs: () => 0,
    allDoneHoldMs: 0,
    baseEveryMs: 0,
    baseIdleMs: 0,
    reviewEveryMs: 0,
    requestsEveryMs: 0,
    scopeEveryMs: 0,
    scopeLeaveMs: 0,
    ...(opts.total ? { limits: { total: opts.total } } : {}),
  });
  const tools = makeTools({ subs, gh: client, readScope, eventLog, scopes });
  const lists = () => gh.requests.filter((r) => r.path === LIST).length;
  return {
    gh,
    subs,
    scopes,
    tools,
    open,
    messages,
    records,
    kinds: () => messages.map((m) => m.meta.kind),
    held: () => subs.list().filter((e) => e.source === "scope").map((e) => e.pr).sort((a, b) => a - b),
    /** Waits until the repository's list has been read `n` more times: the scope has had that many chances to act. */
    async passes(n = 3) {
      const from = lists();
      await until(`${n} more reads of the open list`, () => lists() >= from + n);
    },
    async stop() {
      stop.abort();
      await done;
    },
  };
}

test("another actor's PR opened in a scoped repository is watched with no subscribe call, and its failing workflow is pushed", async () => {
  const t = await setup({ pulls: [7] });
  try {
    await until("the PR already open is held", () => t.subs.get(REPO, 7)?.last != null);
    // Opened later, by somebody else: nothing in this session names it.
    t.open(12);
    t.gh.setRuns(REPO, sha(12), [{ id: 120, name: "CI", status: "in_progress" }]);
    await until("the new PR is held and has been looked at", () => t.subs.get(REPO, 12)?.last != null);
    assert.equal(t.subs.get(REPO, 12)?.source, "scope");
    t.gh.setRuns(REPO, sha(12), [{ id: 120, name: "CI", status: "completed", conclusion: "failure" }]);
    await until("its failure is pushed", () => t.messages.some((m) => m.meta.kind === "ci.workflow_failed" && m.meta.pr === "12"));
    const failed = t.messages.find((m) => m.meta.kind === "ci.workflow_failed");
    assert.equal(failed?.meta.repo, REPO);
    assert.match(failed?.content ?? "", /was not opened by the signed-in GitHub login/, "it is said to be another login's pull request");
    assert.deepEqual(t.records.filter((r) => r.type === "subscribe").map((r) => r.source), ["scope", "scope"], "only the scope subscribed, never the tool");
    // Success stays quiet for a scope's pull request, as for the branch's own.
    t.gh.setRuns(REPO, sha(7), [{ id: 70, name: "CI", status: "completed", conclusion: "success" }]);
    await t.passes();
    assert.ok(!t.kinds().includes("ci.workflow_succeeded"));
  } finally {
    await t.stop();
  }
});

test('involves: "me" holds only the PRs the signed-in login opened, is assigned to or is asked to review, from the list alone', async () => {
  const t = await setup({ involves: "me", pulls: [20] });
  try {
    t.open(21, { requested_reviewers: [{ login: "Octocat" }] });
    t.open(22, { user: { login: "octocat" } });
    t.open(23, { assignees: [{ login: "octocat" }] });
    await until("the three that involve octocat are held", () => t.held().length === 3);
    await t.passes();
    assert.deepEqual(t.held(), [21, 22, 23]);
    assert.equal(t.subs.get(REPO, 20), undefined, "a PR the login is not involved in is not watched");
    assert.ok(!t.gh.requests.some((r) => r.path.startsWith("/search")), "no search request: the list's own fields decide");
    assert.ok(!t.gh.requests.some((r) => /\/pulls\/20$/.test(r.path)), "and the PR that does not involve the login is never read");
    // Asked to review it later: it joins. No longer asked: it goes.
    t.open(20, { requested_reviewers: [{ login: "octocat" }] });
    await until("PR 20 joins once the login is asked to review it", () => t.held().includes(20));
    t.open(21, { requested_reviewers: [] });
    await until("PR 21 goes once the login is no longer involved", () => !t.held().includes(21));
  } finally {
    await t.stop();
  }
});

test("a scope's PR that merges is reported once and dropped; a scope ended elsewhere takes its PRs with it", async () => {
  const t = await setup({ pulls: [7, 8] });
  try {
    await until("both are held and looked at", () => t.subs.get(REPO, 7)?.last != null && t.subs.get(REPO, 8)?.last != null);
    t.gh.setPull(REPO, 7, { state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z" });
    await until("the merge is pushed", () => t.kinds().includes("pr.merged"));
    await t.passes();
    assert.equal(t.kinds().filter((k) => k === "pr.merged").length, 1);
    assert.equal(t.subs.get(REPO, 7), undefined);
    assert.deepEqual(t.held(), [8]);
    // Another session of the project ends the scope: the store is read again at each pass.
    t.scopes.remove(REPO);
    await until("the scope's PRs are dropped", () => t.held().length === 0);
    assert.ok(t.records.some((r) => r.type === "unsubscribe" && r.reason === "scope_ended" && r.pr === 8));
  } finally {
    await t.stop();
  }
});

// Precondition 4a: a scope must not quietly undo an unsubscribe.
test("4a: unsubscribing a PR a scope holds keeps it unwatched: the scope's next looks do not add it back", async () => {
  const t = await setup({ pulls: [7, 8] });
  try {
    await until("both are held", () => t.held().length === 2);
    const r = await t.tools.call("unsubscribe", { repo: REPO, pr: 7 });
    assert.match(r.text, /Stopped watching acme\/widgets PR #7/);
    await t.passes(5);
    assert.equal(t.subs.get(REPO, 7), undefined, "the scope did not add PR 7 back");
    assert.deepEqual(t.held(), [8], "and still holds the other");
    assert.match(r.text, /scope/i, "the answer says a scope covers it and what keeps it unwatched");
    const listed = await t.tools.call("list_subscriptions", {});
    assert.match(listed.text, /acme\/widgets PR #7/, "the mute is shown");
    // Asked for by name again: watched again, as Claude's own.
    const again = await t.tools.call("subscribe", { repo: REPO, pr: 7 });
    assert.equal(again.isError, undefined);
    assert.equal(t.subs.get(REPO, 7)?.source, "tool");
    // And the mute does not outlive the pull request: unsubscribed again, then closed, nothing of it is kept.
    await t.tools.call("unsubscribe", { repo: REPO, pr: 7 });
    assert.equal(t.subs.mutes.list().length, 1);
    t.gh.setPull(REPO, 7, { state: "closed" });
    await until("the mute ends when the PR leaves the open list", () => t.subs.mutes.list().length === 0);
  } finally {
    await t.stop();
  }
});

test("4a: unsubscribe all: true ends the scopes too and says so; whole_repo: true ends that repository's", async () => {
  const t = await setup({ pulls: [7, 8] });
  try {
    await until("both are held", () => t.held().length === 2);
    const r = await t.tools.call("unsubscribe", { all: true });
    assert.match(r.text, /Stopped watching 2 pull request/);
    await settle();
    assert.deepEqual(t.subs.list(), [], "nothing came back");
    assert.deepEqual(t.scopes.list(), [], "the scope is ended, not left to add everything back");
    assert.match(r.text, /scope on acme\/widgets (is|was) ended/i, "the answer names the scope it ended");
    // The same for one repository.
    t.scopes.add({ kind: "repo", repo: REPO, involves: "all", events: "all" });
    await until("held again under a new scope", () => t.held().length === 2);
    const whole = await t.tools.call("unsubscribe", { whole_repo: true, repo: REPO });
    assert.match(whole.text, /scope on acme\/widgets (is|was) ended/i);
    assert.deepEqual(t.scopes.list(), []);
    await settle();
    assert.deepEqual(t.subs.list(), []);
    const described = t.tools.list().find((d) => d.name === "unsubscribe")?.description ?? "";
    assert.match(described, /all: true[^.]*end[^.]*scope/i, "the tool says all: true ends the scopes");
  } finally {
    await t.stop();
  }
});

// Precondition 4b: the scope path honours the session's cap.
test("4b: a scope never takes the session past its cap: the newest are held, the rest are counted and said once", async () => {
  const t = await setup({ total: 3, pulls: [1, 2, 3, 4, 5, 6] });
  try {
    await until("the scope has filled the session", () => t.held().length >= 3);
    let most = 0;
    for (let i = 0; i < 5; i++) {
      await t.passes(1);
      most = Math.max(most, t.subs.list().length);
    }
    assert.equal(most, 3, "never more than the cap");
    assert.deepEqual(t.held(), [4, 5, 6], "the newest three");
    const said = t.messages.filter((m) => m.meta.kind === "channel_scope_capped");
    assert.equal(said.length, 1, "said once, not at every look");
    assert.match(said[0]?.content ?? "", /#6, #5, #4/);
    assert.match(said[0]?.content ?? "", /leaves out the 3 older/);
    assert.equal(said[0]?.meta.left_out, "3");
    const listed = await t.tools.call("list_subscriptions", {});
    assert.match(listed.text, /acme\/widgets: every open pull request \(scope\)[^\n]*holds 3[^\n]*3 more[^\n]*left out/);
    // A newer pull request takes the oldest held one's place; the count left out grows, without a second notice.
    t.open(9);
    await until("PR 9 is held in place of PR 4", () => t.held().join() === "5,6,9");
    assert.equal(t.subs.list().length, 3);
    assert.equal(t.messages.filter((m) => m.meta.kind === "channel_scope_capped").length, 1);
  } finally {
    await t.stop();
  }
});

test("4b: a PR Claude, the hook or the branch watches keeps its place: a scope only fills what is left", async () => {
  const t = await setup({ total: 3, pulls: [1, 2, 3, 4], scope: false });
  try {
    const own = await t.tools.call("subscribe", { repo: REPO, pr: 1 });
    assert.equal(own.isError, undefined);
    t.scopes.add({ kind: "repo", repo: REPO, involves: "all", events: "all" });
    await until("the scope fills the two places left", () => t.held().length >= 2);
    await t.passes();
    assert.deepEqual(t.held(), [3, 4]);
    assert.equal(t.subs.get(REPO, 1)?.source, "tool");
    assert.equal(t.subs.list().length, 3);
  } finally {
    await t.stop();
  }
});

test("4b: at the cap, Claude's own subscribe takes the place of the scope's oldest PR instead of being refused", async () => {
  const numbers = Array.from({ length: MAX_SUBSCRIPTIONS + 2 }, (_, i) => i + 1);
  const t = await setup({ pulls: numbers });
  try {
    await until("the scope has filled the session", () => t.held().length === MAX_SUBSCRIPTIONS);
    assert.equal(t.held()[0], 3, "PRs 1 and 2 are the ones left out");
    const r = await t.tools.call("subscribe", { repo: REPO, pr: 1 });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /Subscribed to acme\/widgets PR #1/);
    assert.match(r.text, /PR #3[^.]*scope/i, "the answer says which of the scope's PRs made room");
    assert.equal(t.subs.get(REPO, 1)?.source, "tool");
    await t.passes();
    assert.equal(t.subs.list().length, MAX_SUBSCRIPTIONS);
    assert.equal(t.subs.get(REPO, 3), undefined);
    const described = t.tools.list().find((d) => d.name === "subscribe")?.description ?? "";
    assert.match(described, new RegExp(`scope[^]*counts towards the same ${MAX_SUBSCRIPTIONS}`), "the scope's cap is in the tool's description");
    assert.match(described, /commented/, "and what involves does not count");
  } finally {
    await t.stop();
  }
});

test("a repository GitHub does not show is said once, and the scope holds nothing", async () => {
  const t = await setup({ scope: false });
  try {
    t.gh.state.failNext.push({ pattern: /^\/repos\/acme\/hidden\/pulls$/, status: 404, count: 1000 });
    t.scopes.add({ kind: "repo", repo: "acme/hidden", involves: "all", events: "all" });
    await until("the notice", () => t.kinds().includes("channel_scope_not_visible"));
    await settle();
    assert.equal(t.kinds().filter((k) => k === "channel_scope_not_visible").length, 1);
    assert.deepEqual(t.subs.list(), []);
    const listed = await t.tools.call("list_subscriptions", {});
    assert.match(listed.text, /acme\/hidden[^\n]*does not show/);
  } finally {
    await t.stop();
  }
});
