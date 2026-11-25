// The tools' side of a repo scope. `subscribe` with `scope: "repo"` sets it once for the project;
// `list_subscriptions` shows it; `unsubscribe` with `scope: "repo"` ends it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { ScopeStore, scopeFile } from "../src/scopes.ts";
import { Subscriptions } from "../src/subscriptions.ts";
import { makeTools } from "../src/tools.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

async function setup(scopes = new ScopeStore(null)) {
  const gh = await startFakeGitHub({ token: "gho_fakeToken123" });
  fakes.push(gh);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: "gho_fakeToken123", source: "gh" }));
  const subs = new Subscriptions();
  const tools = makeTools({ subs, gh: client, readScope: async () => ({ repo: "acme/widgets", branch: "feat" }), scopes });
  return { subs, scopes, tools };
}

test("subscribe with scope repo and involves me sets a scope for the repository's PRs that involve you", async () => {
  const t = await setup();
  const r = await t.tools.call("subscribe", { scope: "repo", repo: "acme/widgets", involves: "me" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(t.scopes.list(), [{ kind: "repo", repo: "acme/widgets", involves: "me", events: "all" }]);
  assert.match(r.text, /every open pull request in acme\/widgets that involves you/);
  assert.match(r.text, /no subscribe call/i);
});

test("subscribe with scope repo and no repo takes the session's own repository; a repo scope defaults to the PRs the login opened", async () => {
  const t = await setup();
  const r = await t.tools.call("subscribe", { scope: "repo" });
  assert.match(r.text, /every open pull request you opened in acme\/widgets\./);
  assert.deepEqual(t.scopes.list(), [{ kind: "repo", repo: "acme/widgets", involves: "mine", events: "all" }]);
});

test("a scope other than repo, or an involves other than me or all, is refused for now", async () => {
  const t = await setup();
  const org = await t.tools.call("subscribe", { scope: "org", repo: "acme/widgets" });
  assert.equal(org.isError, true);
  assert.match(org.text, /only a repository scope/i);
  const everyone = await t.tools.call("subscribe", { scope: "repo", involves: "everyone" });
  assert.equal(everyone.isError, true);
  assert.match(everyone.text, /involves must be/);
  assert.deepEqual(t.scopes.list(), []);
});

test("list_subscriptions shows the scope; unsubscribe with scope repo ends it and the PRs it held", async () => {
  const t = await setup();
  await t.tools.call("subscribe", { scope: "repo", repo: "acme/widgets", involves: "all" });
  t.subs.add({ repo: "acme/widgets", pr: 7, source: "scope" });
  t.subs.add({ repo: "acme/widgets", pr: 8, source: "tool" });
  const listed = await t.tools.call("list_subscriptions", {});
  assert.match(listed.text, /acme\/widgets: every open pull request \(scope\)/);
  const r = await t.tools.call("unsubscribe", { scope: "repo", repo: "acme/widgets" });
  assert.match(r.text, /Stopped watching acme\/widgets as a scope/);
  assert.deepEqual(t.scopes.list(), []);
  assert.equal(t.subs.get("acme/widgets", 7), undefined, "the scope's PR goes with it");
  assert.equal(t.subs.get("acme/widgets", 8)?.source, "tool", "a PR Claude subscribed to itself stays");
});

test("a scope's repository name is checked as strictly as GitHub's own, and an unknown argument is refused", async () => {
  const t = await setup();
  for (const repo of ["../etc/passwd", "acme/widgets/x", "acme", "acme/.."]) {
    const r = await t.tools.call("subscribe", { scope: "repo", repo });
    assert.equal(r.isError, true, repo);
    assert.match(r.text, /owner\/name/, repo);
  }
  const withPr = await t.tools.call("subscribe", { scope: "repo", repo: "acme/widgets", pr: 3 });
  assert.equal(withPr.isError, true, "a scope takes no pr");
  assert.match(withPr.text, /takes no pr/);
  const un = await t.tools.call("unsubscribe", { scope: "repo", repo: "../x" });
  assert.equal(un.isError, true);
  assert.match(un.text, /owner\/name/);
  assert.deepEqual(t.scopes.list(), []);
});

test("list_subscriptions names a scope that involves you, and the PRs a scope holds", async () => {
  const t = await setup();
  await t.tools.call("subscribe", { scope: "repo", repo: "acme/widgets", involves: "me" });
  t.subs.add({ repo: "acme/widgets", pr: 7, source: "scope" });
  const listed = await t.tools.call("list_subscriptions", {});
  assert.match(listed.text, /acme\/widgets: every open pull request that involves you \(scope\)/);
  // A scope, like the branch's automatic watch, leaves out the per-workflow kinds unless told otherwise (AUTO_QUIET_KINDS).
  assert.match(listed.text, /acme\/widgets PR #7: all events but ci\.workflow_started, ci\.workflow_succeeded, ci\.job_stuck_queued \(held by the scope\)/);
});

test("unsubscribe with scope repo when none is set says so and changes nothing", async () => {
  const t = await setup();
  t.subs.add({ repo: "acme/widgets", pr: 7, source: "scope" });
  const r = await t.tools.call("unsubscribe", { scope: "repo", repo: "acme/widgets" });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /No scope is set for acme\/widgets/);
  assert.equal(t.subs.get("acme/widgets", 7)?.source, "scope");
});

test("a scope file that could not be read is reported when a scope is set, and the scope holds for this session only", async () => {
  const file = scopeFile(mkdtempSync(join(tmpdir(), "rio-scope-")), "/p");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, "{ not json", { mode: 0o600 });
  const t = await setup(new ScopeStore(file));
  const r = await t.tools.call("subscribe", { scope: "repo", repo: "acme/widgets" });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /for this session only/);
  assert.match(r.text, /could not be read/);
  assert.equal(t.scopes.list().length, 1);
});

test("without a scope store a repo scope is refused, and the tools do not offer one", async () => {
  const gh = await startFakeGitHub({ token: "gho_fakeToken123" });
  fakes.push(gh);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: "gho_fakeToken123", source: "gh" }));
  const tools = makeTools({ subs: new Subscriptions(), gh: client, readScope: async () => ({ repo: "acme/widgets", branch: "feat" }) });
  const r = await tools.call("subscribe", { scope: "repo", repo: "acme/widgets" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not available/);
  for (const d of tools.list()) {
    assert.equal("scope" in d.inputSchema.properties, false, `${d.name} does not offer a scope it cannot keep`);
    assert.doesNotMatch(d.description, /scope/, d.name);
  }
});

test("the subscribe and unsubscribe schemas name the scope arguments", async () => {
  const t = await setup();
  const defs = t.tools.list();
  const props = (n: string) => defs.find((d) => d.name === n)?.inputSchema.properties ?? {};
  assert.deepEqual((props("subscribe").scope as { enum: string[] }).enum, ["repo"]);
  assert.deepEqual((props("subscribe").involves as { enum: string[] }).enum, ["mine", "me", "all"]);
  assert.deepEqual((props("unsubscribe").scope as { enum: string[] }).enum, ["repo"]);
});
