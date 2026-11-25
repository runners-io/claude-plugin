// What GitHub answers is noted for the next launch (firstcall.ts, hooks/readiness.mjs): the client says what it saw,
// the recorder keeps kinds, counts and times in a small file, and a good answer takes a refusal off again.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FirstCallRecorder, WRITE_EVERY_MS } from "../src/firstcall.ts";
import { type GhAuth, GitHubClient, type Observation } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { readFirstCall, stateRoot } from "../../hooks/readiness.mjs";

setQuiet(true);
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function stateEnv(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "rio-firstcall-"));
  roots.push(root);
  return { XDG_STATE_HOME: root, HOME: root };
}

const auth = (source: "gh" | "env" = "gh"): (() => Promise<GhAuth>) => async () => ({ kind: "ok", token: "gho_fakeToken123", source });

/** A client whose GitHub is `answer`, and everything it said it saw. */
function client(answer: (url: string) => Response | Promise<Response>, source: "gh" | "env" = "gh") {
  const seen: Observation[] = [];
  const gh = new GitHubClient("https://api.github.com", auth(source), async (url) => answer(String(url)), { observe: (o) => seen.push(o) });
  return { gh, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const whats = (seen: Observation[]) => seen.map((o) => o.what);

test("a good answer is seen as ok, with the path and where the token came from", async () => {
  const { gh, seen } = client(() => json(200, { fork: false, private: true }, { etag: '"a"' }), "env");
  assert.deepEqual(await gh.repoInfo("acme/widgets"), { kind: "ok", value: { fork: false, private: true, parent: null } });
  assert.deepEqual(seen, [{ what: "ok", path: "/repos/acme/widgets", source: "env" }]);
});

test("a 401 with the same login still in place is seen as a rejected token", async () => {
  const { gh, seen } = client(() => json(401, { message: "Bad credentials" }));
  assert.equal((await gh.repoInfo("acme/widgets")).kind, "auth");
  assert.deepEqual(whats(seen), ["token_rejected"]);
});

test("a classic token's scopes without repo are seen as no_repo_scope, with repo as repo_scope, and a token that names none as neither", async () => {
  const none = client(() => json(200, {}, { "x-oauth-scopes": "read:org, gist" }));
  await none.gh.repoInfo("acme/widgets");
  assert.deepEqual(whats(none.seen), ["no_repo_scope", "ok"]);
  const has = client(() => json(200, {}, { "x-oauth-scopes": "repo, read:org" }));
  await has.gh.repoInfo("acme/widgets");
  assert.deepEqual(whats(has.seen), ["repo_scope", "ok"]);
  const fine = client(() => json(200, {}));
  await fine.gh.repoInfo("acme/widgets");
  assert.deepEqual(whats(fine.seen), ["ok"]);
});

test("a 403 carrying x-github-sso is seen as sso; any other 403 that is not a rate limit as forbidden; a rate limit as neither", async () => {
  const sso = client(() => json(403, { message: "Resource protected by organization SAML enforcement." }, { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=x" }));
  assert.equal((await sso.gh.repoInfo("acme/widgets")).kind, "not_found");
  assert.deepEqual(whats(sso.seen), ["sso"]);
  const forbidden = client(() => json(403, { message: "Resource not accessible by personal access token" }));
  await forbidden.gh.repoInfo("acme/widgets");
  assert.deepEqual(whats(forbidden.seen), ["forbidden"]);
  const limited = client(() => json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" }));
  assert.equal((await limited.gh.repoInfo("acme/widgets")).kind, "retry");
  assert.deepEqual(whats(limited.seen), []);
});

test("a certificate that does not verify is seen as cert_error; any other network failure is not", async () => {
  const failing = (code: string) =>
    client(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) });
    });
  for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
    const c = failing(code);
    assert.equal((await c.gh.repoInfo("acme/widgets")).kind, "retry", code);
    assert.deepEqual(whats(c.seen), ["cert_error"], code);
  }
  const down = failing("ECONNREFUSED");
  await down.gh.repoInfo("acme/widgets");
  assert.deepEqual(whats(down.seen), []);
});

test("a repository name GitHub would not allow is never asked for", async () => {
  const { gh, seen } = client(() => {
    throw new Error("must not be asked");
  });
  assert.deepEqual(await gh.repoInfo("acme/../../user"), { kind: "not_found" });
  assert.deepEqual(seen, []);
});

// ---- the recorder ------------------------------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const seenAs = (what: Observation["what"], path = "/repos/acme/widgets/pulls/1", source: "gh" | "env" = "gh"): Observation => ({ what, path, source });

test("a refusal is written once and then not again for ten minutes, however often it is seen", () => {
  const env = stateEnv();
  let now = T0;
  const r = new FirstCallRecorder(env, "/work/project", () => now);
  for (let i = 0; i < 500; i++) r.observe(seenAs("token_rejected"));
  assert.equal(readFirstCall(env, now).kinds.token_rejected?.n, 1);
  now += WRITE_EVERY_MS + 1;
  r.observe(seenAs("token_rejected"));
  assert.equal(readFirstCall(env, now).kinds.token_rejected?.n, 2);
});

test("a good answer takes the refused login and the certificate off the record, and is itself noted", () => {
  const env = stateEnv();
  const r = new FirstCallRecorder(env, "/work/project", () => T0);
  r.observe(seenAs("token_rejected"));
  r.observe(seenAs("cert_error"));
  assert.deepEqual(Object.keys(readFirstCall(env, T0).kinds).sort(), ["cert_error", "token_rejected"]);
  r.observe(seenAs("ok"));
  assert.deepEqual(Object.keys(readFirstCall(env, T0).kinds), ["ok"]);
});

test("a good answer already on the record is not written again, however many follow, in this session or the next", () => {
  const env = stateEnv();
  let now = T0;
  const r = new FirstCallRecorder(env, "/work/project", () => now);
  for (let i = 0; i < 50; i++) r.observe(seenAs("ok"));
  now += 3 * WRITE_EVERY_MS;
  r.observe(seenAs("ok"));
  new FirstCallRecorder(env, "/work/project", () => now).observe(seenAs("ok"));
  assert.deepEqual(readFirstCall(env, now).kinds.ok, { n: 1, first: T0, last: T0, source: "gh" });
});

test("a single sign-on refusal is cleared only by a good answer from the same organisation, and the file never names it", () => {
  const env = stateEnv();
  const r = new FirstCallRecorder(env, "/work/project", () => T0);
  r.observe(seenAs("sso", "/repos/Secret-Org/widgets/pulls/1"));
  r.observe(seenAs("ok", "/repos/other-org/thing/pulls/2"));
  assert.ok(readFirstCall(env, T0).kinds.sso, "another organisation's good answer says nothing about this one");
  assert.equal(readFileSync(join(stateRoot(env) as string, "first-call.json"), "utf8").toLowerCase().includes("secret-org"), false);
  // A later session, which never saw the refusal itself, clears it when that organisation answers well.
  const later = new FirstCallRecorder(env, "/work/project", () => T0 + 1000);
  later.observe(seenAs("ok", "/repos/secret-org/widgets/pulls/1"));
  assert.equal(readFirstCall(env, T0 + 1000).kinds.sso, undefined);
});

test("a plain 403 is recorded only for a token from a variable: with gh's login it is most often a repository that is not shown", () => {
  const gh = stateEnv();
  new FirstCallRecorder(gh, "/work/project", () => T0).observe(seenAs("forbidden"));
  assert.equal(readFirstCall(gh, T0).kinds.forbidden, undefined);
  const env = stateEnv();
  new FirstCallRecorder(env, "/work/project", () => T0).observe(seenAs("forbidden", "/repos/acme/widgets/actions/runs", "env"));
  assert.equal(readFirstCall(env, T0).kinds.forbidden?.source, "env");
});

test("a missing repo scope is recorded, and cleared when the login has it", () => {
  const env = stateEnv();
  const r = new FirstCallRecorder(env, "/work/project", () => T0);
  r.observe(seenAs("no_repo_scope"));
  assert.ok(readFirstCall(env, T0).kinds.no_repo_scope);
  r.observe(seenAs("repo_scope"));
  assert.equal(readFirstCall(env, T0).kinds.no_repo_scope, undefined);
});

test("a fork is filed under the project, and taken off when GitHub says it is not one", () => {
  const env = stateEnv();
  const r = new FirstCallRecorder(env, "/work/project", () => T0);
  r.fork(true);
  assert.equal(Object.keys(readFirstCall(env, T0).projects).length, 1);
  assert.equal(readFileSync(join(stateRoot(env) as string, "first-call.json"), "utf8").includes("/work/project"), false);
  r.fork(false);
  assert.deepEqual(readFirstCall(env, T0).projects, {});
});

test("a state folder that cannot be written stops nothing: the recorder never throws", () => {
  const r = new FirstCallRecorder({ XDG_STATE_HOME: "/dev/null/nowhere", HOME: "/dev/null/nowhere" }, "/work/project", () => T0);
  assert.doesNotThrow(() => {
    r.observe(seenAs("token_rejected"));
    r.observe(seenAs("ok"));
    r.fork(true);
  });
});
