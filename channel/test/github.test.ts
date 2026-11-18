import assert from "node:assert/strict";
import { after, test } from "node:test";

import { type GhAuth, GitHubClient, readGhAuth } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

async function fake(): Promise<FakeGitHub> {
  const f = await startFakeGitHub({ token: "gho_fakeToken123" });
  fakes.push(f);
  return f;
}

const ok = (token = "gho_fakeToken123"): (() => Promise<GhAuth>) => async () => ({ kind: "ok", token, source: "gh" });

test("readGhAuth prefers GH_TOKEN, then GITHUB_TOKEN, then gh auth token", async () => {
  const never = async () => {
    throw new Error("gh must not run when the environment has a token");
  };
  assert.deepEqual(await readGhAuth({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, never), { kind: "ok", token: "a", source: "env" });
  assert.deepEqual(await readGhAuth({ GITHUB_TOKEN: "b" }, never), { kind: "ok", token: "b", source: "env" });
  const gh = async () => ({ code: 0, stdout: "gho_fromGh\n" });
  assert.deepEqual(await readGhAuth({}, gh), { kind: "ok", token: "gho_fromGh", source: "gh" });
});

test("readGhAuth maps a missing gh to not_installed and a failing or empty one to signed_out", async () => {
  const missing = async () => ({ code: null, stdout: "", errorCode: "ENOENT" });
  assert.deepEqual(await readGhAuth({}, missing), { kind: "not_installed" });
  assert.deepEqual(await readGhAuth({}, async () => ({ code: 1, stdout: "" })), { kind: "signed_out" });
  assert.deepEqual(await readGhAuth({}, async () => ({ code: 0, stdout: "  \n" })), { kind: "signed_out" });
});

test("getPull maps GitHub's pull request to PullInfo", async () => {
  const gh = await fake();
  gh.setPull("acme/widgets", 7, { head: { sha: "b".repeat(40), ref: "feat" }, mergeable: false, mergeable_state: "dirty" });
  const client = new GitHubClient(gh.base, ok());
  const r = await client.getPull("acme/widgets", 7);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.deepEqual(r.value, {
    number: 7,
    state: "open",
    merged: false,
    headSha: "b".repeat(40),
    headRef: "feat",
    mergeableState: "dirty",
    htmlUrl: "https://github.com/acme/widgets/pull/7",
    bodyHash: "e3b0c44298fc1c14", // no body: the SHA-256 of ""
  });
});

test("a 304 returns the cached body", async () => {
  const gh = await fake();
  gh.setRuns("acme/widgets", "c".repeat(40), [{ id: 11, name: "CI", status: "in_progress" }]);
  const client = new GitHubClient(gh.base, ok());
  const first = await client.runsForSha("acme/widgets", "c".repeat(40));
  const second = await client.runsForSha("acme/widgets", "c".repeat(40));
  assert.deepEqual(gh.requests.map((r) => r.status), [200, 304]);
  assert.deepEqual(second, first);
  assert.equal(first.kind === "ok" && first.value[0].name, "CI");
  assert.equal(first.kind === "ok" && first.value[0].status, "in_progress");
});

test("a 401 re-reads the login: a new token is retried once, the same one is signed_out", async () => {
  const gh = await fake();
  gh.setPull("acme/widgets", 1);
  let calls = 0;
  const rotating = async (): Promise<GhAuth> => ({ kind: "ok", token: calls++ === 0 ? "gho_stale" : "gho_fakeToken123", source: "gh" });
  const r = await new GitHubClient(gh.base, rotating).getPull("acme/widgets", 1);
  assert.equal(r.kind, "ok");

  const stuck = await new GitHubClient(gh.base, ok("gho_wrong")).getPull("acme/widgets", 1);
  assert.deepEqual(stuck, { kind: "auth", auth: { kind: "signed_out" } });
});

test("no login at all is reported without a request", async () => {
  const gh = await fake();
  const r = await new GitHubClient(gh.base, async () => ({ kind: "not_installed" })).getPull("acme/widgets", 1);
  assert.deepEqual(r, { kind: "auth", auth: { kind: "not_installed" } });
  assert.equal(gh.requests.length, 0);
});

test("a rate-limit 403 is retry, after x-ratelimit-reset", async () => {
  const gh = await fake();
  gh.state.rateLimited = { resetEpoch: Math.floor(Date.now() / 1000) + 30 };
  const client = new GitHubClient(gh.base, ok());
  const r = await client.getPull("acme/widgets", 1);
  assert.equal(r.kind, "retry");
  if (r.kind !== "retry") return;
  assert.ok(r.afterMs !== undefined && r.afterMs > 20_000 && r.afterMs <= 31_000, String(r.afterMs));
  assert.equal(client.rateRemaining, 0);
});

test("a 404 is not_found", async () => {
  const gh = await fake();
  assert.deepEqual(await new GitHubClient(gh.base, ok()).getPull("acme/widgets", 404), { kind: "not_found" });
});

test("findOpenPull asks by owner:branch and answers the PR number or null", async () => {
  const gh = await fake();
  gh.setPull("acme/widgets", 9, { head: { ref: "feat", sha: "d".repeat(40) } });
  const client = new GitHubClient(gh.base, ok());
  const found = await client.findOpenPull("acme/widgets", "feat");
  assert.deepEqual(found, { kind: "ok", value: 9 });
  assert.match(gh.requests.at(-1)?.path ?? "", /head=acme%3Afeat/);
  assert.deepEqual(await client.findOpenPull("acme/widgets", "other"), { kind: "ok", value: null });
});

test("failedJobs names the failed, timed-out and cancelled jobs only", async () => {
  const gh = await fake();
  gh.setJobs(21, [
    { name: "lint", conclusion: "success" },
    { name: "test", conclusion: "failure" },
    { name: "e2e", conclusion: "timed_out" },
  ]);
  assert.deepEqual(await new GitHubClient(gh.base, ok()).failedJobs("acme/widgets", 21), { kind: "ok", value: ["test", "e2e"] });
});

test("a 403 whose message is a secondary rate limit is a retry after at least a minute, not not_found", async () => {
  const gh = await fake();
  gh.state.secondaryLimited = true;
  const r = await new GitHubClient(gh.base, ok()).getPull("acme/widgets", 1);
  assert.equal(r.kind, "retry");
  assert.ok(r.kind === "retry" && (r.afterMs ?? 0) >= 60_000, JSON.stringify(r));
});

test("mergeability comes from the mergeable boolean: false is a conflict, null is unknown, a draft is not a conflict", async () => {
  const gh = await fake();
  const client = new GitHubClient(gh.base, ok());
  const state = async (fields: Record<string, unknown>) => {
    gh.setPull("acme/widgets", 3, fields);
    const r = await client.getPull("acme/widgets", 3);
    return r.kind === "ok" ? r.value.mergeableState : r.kind;
  };
  assert.equal(await state({ mergeable: false, mergeable_state: "draft" }), "dirty", "a conflicted draft is a conflict");
  assert.equal(await state({ mergeable: true, mergeable_state: "draft" }), "clean", "a clean draft is not");
  assert.equal(await state({ mergeable: null, mergeable_state: "unknown" }), "unknown");
  assert.equal(await state({ mergeable: true, mergeable_state: "blocked" }), "clean");
});

test("the token's scopes are read from x-oauth-scopes, and are null for a token that sends none", async () => {
  const gh = await fake();
  gh.setPull("acme/widgets", 1);
  const client = new GitHubClient(gh.base, ok());
  assert.equal(client.scopes, null);
  await client.getPull("acme/widgets", 1);
  assert.deepEqual(client.scopes, ["repo", "workflow"]);
  gh.state.scopes = null;
  gh.setPull("acme/widgets", 1, { title: "changed" });
  await client.getPull("acme/widgets", 1);
  assert.equal(client.scopes, null);
});

test("getPull reads draft, label names, the base branch, GitHub's updated time and a hash of the body, never the body", async () => {
  const gh = await fake();
  gh.setPull("acme/widgets", 3, {
    draft: true,
    labels: [{ name: "hold" }, { name: "ci" }, { nope: 1 }],
    base: { ref: "main" },
    updated_at: "2026-11-18T02:00:00Z",
    body: "Hold: wait for the export window",
  });
  const c = new GitHubClient(gh.base, ok());
  const r = await c.getPull("acme/widgets", 3);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.value.draft, true);
  assert.deepEqual(r.value.labels, ["ci", "hold"]);
  assert.equal(r.value.baseRef, "main");
  assert.equal(r.value.updatedAt, "2026-11-18T02:00:00Z");
  assert.match(String(r.value.bodyHash), /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(r.value).includes("export window"), false, "the body text is never kept");
  gh.setPull("acme/widgets", 3, { body: null });
  const empty = await c.getPull("acme/widgets", 3);
  assert.match(String(empty.kind === "ok" && empty.value.bodyHash), /^[0-9a-f]{16}$/, "an empty body hashes too, so clearing it is a change");
});

test("baseRuns reads the push runs on a branch", async () => {
  const gh = await fake();
  gh.setBaseRuns("acme/widgets", "main", [{ id: 5, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-11-18T01:00:00Z", updated_at: "2026-11-18T01:10:00Z" }]);
  const c = new GitHubClient(gh.base, ok());
  const r = await c.baseRuns("acme/widgets", "main");
  assert.equal(r.kind, "ok");
  assert.deepEqual(r.kind === "ok" && r.value.map((x) => [x.name, x.conclusion, x.updated_at]), [["CI", "failure", "2026-11-18T01:10:00Z"]]);
  assert.ok(gh.requests.some((q) => q.path.includes("branch=main") && q.path.includes("event=push")));
});

test("a github.com token is only ever read for api.github.com (or loopback, for tests); another host gets that host's own login", async () => {
  const asked: string[][] = [];
  const gh = async (_c: string, args: readonly string[]) => {
    asked.push([...args]);
    return { code: 0, stdout: `token-for-${args.at(-1)}\n` };
  };
  const env = { GH_TOKEN: "gho_githubcom", GITHUB_TOKEN: "gho_githubcom2" };
  assert.deepEqual(await readGhAuth(env, gh, "https://api.github.com"), { kind: "ok", token: "gho_githubcom", source: "env" });
  assert.deepEqual(await readGhAuth(env, gh, "http://127.0.0.1:4567"), { kind: "ok", token: "gho_githubcom", source: "env" });
  const ghe = await readGhAuth(env, gh, "https://ghe.example.com/api/v3");
  assert.deepEqual(ghe, { kind: "ok", token: "token-for-ghe.example.com", source: "gh" }, "GH_TOKEN is github.com's, never sent elsewhere");
  assert.deepEqual(asked.at(-1), ["auth", "token", "--hostname", "ghe.example.com"]);
  const enterprise = await readGhAuth({ ...env, GH_ENTERPRISE_TOKEN: "ghe_own" }, gh, "https://ghe.example.com/api/v3");
  assert.deepEqual(enterprise, { kind: "ok", token: "ghe_own", source: "env" });
});
