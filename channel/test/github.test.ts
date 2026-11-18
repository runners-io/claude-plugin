import assert from "node:assert/strict";
import { after, test } from "node:test";

import { type GhAuth, GitHubClient, loginHost, readGhAuth } from "../src/github.ts";
import { fetchSnapshot } from "../src/poller.ts";
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

test("a local API address never gets the github.com login, unless the tests' switch is on", async () => {
  const asked: string[][] = [];
  const gh = async (_cmd: string, args: readonly string[]) => {
    asked.push([...args]);
    return { code: 1, stdout: "" };
  };
  assert.deepEqual(await readGhAuth({ GH_TOKEN: "gho_real" }, gh, "http://127.0.0.1:9"), { kind: "signed_out" });
  assert.deepEqual(asked, [["auth", "token", "--hostname", "127.0.0.1:9"]], "asked for the local host's own login, port and all, not github.com's");
  const never = async () => {
    throw new Error("gh must not run when the environment has a token");
  };
  assert.deepEqual(await readGhAuth({ RUNNERS_IO_TEST_GITHUB_TOKEN: "gho_fake", RUNNERS_IO_TEST_FAKE_GITHUB: "1" }, never, "http://127.0.0.1:9"), {
    kind: "ok",
    token: "gho_fake",
    source: "env",
  });
});

// The switch ships in the bundle (its own end-to-end test runs the bundle against a fake GitHub), so whoever can set a
// session's environment can turn it on. Under it, a token is read only from the tests' own variable: never the user's
// GH_TOKEN, GITHUB_TOKEN or gh login, which would then travel in clear text to whatever listens on this machine.
test("under the tests' switch a local API address gets only the tests' own token, never the user's real login", async () => {
  const never = async () => {
    throw new Error("gh must not be asked for a login to send to this machine");
  };
  const on = { RUNNERS_IO_TEST_FAKE_GITHUB: "1", GH_TOKEN: "gho_real", GITHUB_TOKEN: "gho_real2" };
  assert.deepEqual(await readGhAuth(on, never, "http://127.0.0.1:9"), { kind: "signed_out" });
  assert.deepEqual(await readGhAuth({ ...on, RUNNERS_IO_TEST_GITHUB_TOKEN: "t" }, never, "http://127.0.0.1:9"), { kind: "ok", token: "t", source: "env" });
  // The tests' token is for the fake GitHub only: it is never sent to a real host.
  const gh = async () => ({ code: 0, stdout: "gho_fromGh\n" });
  assert.deepEqual(await readGhAuth({ RUNNERS_IO_TEST_GITHUB_TOKEN: "t" }, gh), { kind: "ok", token: "gho_fromGh", source: "gh" });
});

// GH_ENTERPRISE_TOKEN names no host of its own; gh uses it for GH_HOST. Read it for any other address and an
// environment that points RUNNERS_IO_GITHUB_API elsewhere receives the user's Enterprise token.
test("an Enterprise token from the environment goes only to the host GH_HOST names", async () => {
  const gh = async (_c: string, args: readonly string[]) => ({ code: 0, stdout: `token-for-${args.at(-1)}\n` });
  const env = { GH_ENTERPRISE_TOKEN: "ghe_own", GITHUB_ENTERPRISE_TOKEN: "ghe_own2" };
  assert.deepEqual(await readGhAuth(env, gh, "https://attacker.example/api/v3"), { kind: "ok", token: "token-for-attacker.example", source: "gh" });
  assert.deepEqual(await readGhAuth({ ...env, GH_HOST: "ghe.corp.example" }, gh, "https://attacker.example/api/v3"), {
    kind: "ok",
    token: "token-for-attacker.example",
    source: "gh",
  });
  assert.deepEqual(await readGhAuth({ ...env, GH_HOST: "ghe.corp.example" }, gh, "https://ghe.corp.example/api/v3"), { kind: "ok", token: "ghe_own", source: "env" });
});

// A login is a host's: the same name on another port can be another server (or a local listener), so the port is part
// of the host a token is matched to.
test("the host a token is read for includes the API address's port", async () => {
  assert.equal(loginHost("https://api.github.com"), "github.com");
  assert.equal(loginHost("https://api.github.com:443/"), "github.com", "https's own port is no port");
  assert.equal(loginHost("https://api.github.com:8443"), "api.github.com:8443", "not github.com on another port");
  assert.equal(loginHost("https://ghe.corp.example/api/v3"), "ghe.corp.example");
  assert.equal(loginHost("https://GHE.corp.example:8443/api/v3"), "ghe.corp.example:8443");
  const asked: string[][] = [];
  const gh = async (_c: string, args: readonly string[]) => {
    asked.push([...args]);
    return { code: 0, stdout: `token-for-${args.at(-1)}\n` };
  };
  const env = { GH_HOST: "ghe.corp.example", GH_ENTERPRISE_TOKEN: "ghe_own" };
  assert.deepEqual(await readGhAuth(env, gh, "https://ghe.corp.example:8443/api/v3"), { kind: "ok", token: "token-for-ghe.corp.example:8443", source: "gh" });
  assert.deepEqual(asked, [["auth", "token", "--hostname", "ghe.corp.example:8443"]]);
  // The control: GH_HOST naming that port too is that server.
  assert.deepEqual(await readGhAuth({ ...env, GH_HOST: "ghe.corp.example:8443" }, gh, "https://ghe.corp.example:8443/api/v3"), { kind: "ok", token: "ghe_own", source: "env" });
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
    headRepo: "acme/widgets",
    mergeableState: "dirty",
    mergeStatus: "dirty", // GitHub's mergeable_state as it answered: whether the PR may be ready to merge
    htmlUrl: "https://github.com/acme/widgets/pull/7",
    author: "octocat", // the fake PR's user.login: who opened it, read to screen a handed-over PR
    bodyHash: "e3b0c44298fc1c14", // no body: the SHA-256 of ""
  });
});

test("a mergeable PR that a rule still blocks is no conflict, and says blocked", async () => {
  const gh = await fake();
  gh.setPull("acme/widgets", 7, { mergeable: true, mergeable_state: "blocked" });
  const r = await new GitHubClient(gh.base, ok()).getPull("acme/widgets", 7);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.value.mergeableState, "clean");
  assert.equal(r.value.mergeStatus, "blocked");
});

test("a 304 returns the cached body", async () => {
  const gh = await fake();
  gh.setRuns("acme/widgets", "c".repeat(40), [{ id: 11, name: "CI", status: "in_progress" }]);
  const client = new GitHubClient(gh.base, ok());
  const own = { ref: "fix-login", repo: "acme/widgets" };
  const first = await client.runsForSha("acme/widgets", "c".repeat(40), own);
  const second = await client.runsForSha("acme/widgets", "c".repeat(40), own);
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

test("runsForSha keeps only runs from the pull request's own head repository and branch", async () => {
  // A stranger can push the same public commit to a fork and open their own pull request: its runs carry the same
  // head_sha in this repository, and must never be reported as this pull request's CI.
  const gh = await fake();
  const sha = "c".repeat(40);
  gh.setRuns("acme/widgets", sha, [
    { id: 11, name: "CI", head_branch: "fix-login", head_repository: { full_name: "acme/widgets" } },
    { id: 12, name: "CI", head_branch: "fix-login", head_repository: { full_name: "stranger/widgets" } },
    { id: 13, name: "CI", head_branch: "other", head_repository: { full_name: "acme/widgets" } },
  ]);
  const client = new GitHubClient(gh.base, ok());
  const r = await client.runsForSha("acme/widgets", sha, { ref: "fix-login", repo: "Acme/Widgets" });
  assert.deepEqual(r.kind === "ok" && r.value.map((x) => x.id), [11]);
  assert.match(gh.requests.at(-1)?.path ?? "", /branch=fix-login/, "the branch narrows GitHub's page, so a stranger's runs cannot push ours off it");
  const forked = await client.runsForSha("acme/widgets", sha, { ref: "fix-login", repo: "stranger/widgets" });
  assert.deepEqual(forked.kind === "ok" && forked.value.map((x) => x.id), [12], "a fork's pull request keeps the fork's runs");
  const gone = await client.runsForSha("acme/widgets", sha, { ref: "fix-login", repo: null });
  assert.deepEqual(gone.kind === "ok" && gone.value, [], "a head repository GitHub no longer names matches nothing");
});

test("runsForSha keeps each run's event and who started it, and leaves either out when GitHub does not say", async () => {
  const gh = await fake();
  const sha = "d".repeat(40);
  gh.setRuns("acme/widgets", sha, [
    { id: 21, name: "CI", head_branch: "fix-login", event: "pull_request", triggering_actor: { login: "octocat" } },
    { id: 22, name: "CI", head_branch: "fix-login", event: "pull_request_review", triggering_actor: { login: "stranger" } },
    { id: 23, name: "CI", head_branch: "fix-login", event: 7, triggering_actor: null },
  ]);
  const r = await new GitHubClient(gh.base, ok()).runsForSha("acme/widgets", sha, { ref: "fix-login", repo: "acme/widgets" });
  assert.equal(r.kind, "ok");
  const runs = r.kind === "ok" ? r.value : [];
  assert.deepEqual(runs.map((x) => [x.id, x.event, x.triggeringActor]), [
    [21, "pull_request", "octocat"],
    [22, "pull_request_review", "stranger"],
    [23, undefined, undefined],
  ]);
});

test("a run GitHub answers with an id that is not a safe positive integer is left out: the id goes into a gh command", async () => {
  const gh = await fake();
  const sha = "9".repeat(40);
  gh.setRuns("acme/widgets", sha, [
    { id: 31, name: "CI", head_branch: "fix-login" },
    { id: "32", name: "CI", head_branch: "fix-login" },
    { id: -33, name: "CI", head_branch: "fix-login" },
    { id: 2 ** 60, name: "CI", head_branch: "fix-login" },
  ]);
  const r = await new GitHubClient(gh.base, ok()).runsForSha("acme/widgets", sha, { ref: "fix-login", repo: "acme/widgets" });
  assert.deepEqual(r.kind === "ok" && r.value.map((x) => x.id), [31]);
});

test("a pull request's snapshot holds no run of a stranger's pull request on the same commit", async () => {
  const gh = await fake();
  const sha = "e".repeat(40);
  gh.setPull("acme/widgets", 5, { head: { sha, ref: "fix-login", repo: { full_name: "acme/widgets" } } });
  gh.setRuns("acme/widgets", sha, [
    { id: 21, name: "CI", status: "completed", conclusion: "success", head_branch: "fix-login", head_repository: { full_name: "acme/widgets" } },
    { id: 22, name: "CI", status: "completed", conclusion: "failure", head_branch: "fix-login", head_repository: { full_name: "stranger/widgets" } },
    { id: 23, name: "CI", status: "completed", conclusion: "action_required", head_branch: "fix-login", head_repository: { full_name: "stranger/widgets" } },
  ]);
  const snap = await fetchSnapshot(new GitHubClient(gh.base, ok()), "acme/widgets", 5);
  assert.deepEqual(snap.kind === "ok" && snap.value.runs.map((x) => x.id), [21]);
});

test("runJobs and failedJobs on one run each get their own shape, whichever is cached first", async () => {
  const gh = await fake();
  gh.setJobs(31, [
    { id: 1, name: "lint", conclusion: "success", status: "completed" },
    { id: 2, name: "test", conclusion: "failure", status: "completed" },
  ]);
  const client = new GitHubClient(gh.base, ok());
  const jobs = await client.runJobs("acme/widgets", 31);
  assert.deepEqual(jobs.kind === "ok" && jobs.value.map((j) => j.name), ["lint", "test"]);
  assert.deepEqual(await client.failedJobs("acme/widgets", 31), { kind: "ok", value: ["test"] });
  const again = await client.runJobs("acme/widgets", 31);
  assert.deepEqual(again.kind === "ok" && again.value.map((j) => j.name), ["lint", "test"]);
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
  // A loopback address is a test's fake GitHub only under the tests' switch; without it, it is just another host.
  const tests = { ...env, RUNNERS_IO_TEST_FAKE_GITHUB: "1", RUNNERS_IO_TEST_GITHUB_TOKEN: "gho_testsown" };
  assert.deepEqual(await readGhAuth(tests, gh, "http://127.0.0.1:4567"), { kind: "ok", token: "gho_testsown", source: "env" });
  assert.deepEqual(await readGhAuth(env, gh, "http://127.0.0.1:4567"), { kind: "ok", token: "token-for-127.0.0.1:4567", source: "gh" }, "no switch: the github.com token stays home, and the port is part of the host");
  const ghe = await readGhAuth(env, gh, "https://ghe.example.com/api/v3");
  assert.deepEqual(ghe, { kind: "ok", token: "token-for-ghe.example.com", source: "gh" }, "GH_TOKEN is github.com's, never sent elsewhere");
  assert.deepEqual(asked.at(-1), ["auth", "token", "--hostname", "ghe.example.com"]);
  const enterprise = await readGhAuth({ ...env, GH_ENTERPRISE_TOKEN: "ghe_own", GH_HOST: "ghe.example.com" }, gh, "https://ghe.example.com/api/v3");
  assert.deepEqual(enterprise, { kind: "ok", token: "ghe_own", source: "env" });
});

test("reviewState asks GraphQL once, and GraphQL's budget is kept apart from REST's", async () => {
  const gh = await fake();
  gh.setReviewPull("acme/widgets", 7, {
    headRefOid: "a".repeat(40),
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    latestOpinionatedReviews: { nodes: [{ id: "R1", state: "APPROVED", authorAssociation: "MEMBER", author: { login: "alice", __typename: "User" } }] },
    reviewThreads: { nodes: [] },
  });
  gh.setGraphqlRate(4321);
  const client = new GitHubClient(gh.base, ok());
  await client.getPull("acme/widgets", 1).catch(() => undefined);
  const restBefore = client.rateRemaining;
  const r = await client.reviewState("acme/widgets", 7);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.value.mergeState, "CLEAN");
  assert.deepEqual(r.value.reviews.map((x) => x.login), ["alice"]);
  const asked = gh.requests.filter((x) => x.path === "/graphql");
  assert.equal(asked.length, 1);
  assert.deepEqual((asked[0] as unknown as { variables: unknown }).variables, { owner: "acme", name: "widgets", number: 7 });
  assert.equal(client.graphqlRemaining, 4321);
  assert.equal(client.graphqlLimit, 5000);
  assert.equal(client.rateRemaining, restBefore, "REST's reading is not GraphQL's");
  assert.equal(client.requests.graphql, 1);
});

test("reviewState of a pull request GraphQL cannot see is not_found", async () => {
  const gh = await fake();
  const client = new GitHubClient(gh.base, ok());
  assert.deepEqual(await client.reviewState("acme/widgets", 99), { kind: "not_found" });
});

test("reviewRequests asks GraphQL's search for this login's open review requests, and counts against GraphQL's budget", async () => {
  const gh = await fake();
  gh.setReviewRequests([
    {
      number: 9,
      url: "https://github.com/acme/api/pull/9",
      repository: { nameWithOwner: "acme/api" },
      timelineItems: { nodes: [{ id: "E1", createdAt: "2026-01-01T00:00:00Z", actor: { login: "alice", __typename: "User" }, requestedReviewer: { __typename: "User", login: "octocat" } }] },
    },
  ]);
  gh.setGraphqlRate(4000);
  const client = new GitHubClient(gh.base, ok());
  const r = await client.reviewRequests();
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.value.viewer, "octocat");
  assert.deepEqual(r.value.requests.map((q) => [q.repo, q.pr, q.id]), [["acme/api", 9, "E1"]]);
  const asked = gh.requests.filter((x) => x.path === "/graphql") as unknown as { query: string; variables: { q: string } }[];
  assert.equal(asked.length, 1);
  assert.match(asked[0].variables.q, /review-requested:@me/);
  assert.equal(client.graphqlRemaining, 4000);
});
