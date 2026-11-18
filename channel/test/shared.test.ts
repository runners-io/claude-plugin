// Several Claude Code sessions on one machine, each with the channel, watching the same pull requests: GitHub must
// be asked once, not once per session. The sessions share one store per GitHub login (shared.ts); whichever asks
// first holds that request's lease and asks GitHub, and the others read its answer.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { GitHubClient, type GhAuth } from "../src/github.ts";
import { SharedStore } from "../src/shared.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

const TOKEN = "ghp_sharedtestsharedtestsharedtest00";
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

async function fake(): Promise<FakeGitHub> {
  const gh = await startFakeGitHub({ token: TOKEN });
  fakes.push(gh);
  gh.setPull("octo-org/example", 7, { head: { sha: "a".repeat(40), ref: "feat" }, base: { ref: "main" } });
  return gh;
}

function client(gh: FakeGitHub, root: string, opts: { token?: string; now?: () => number; freshMs?: number } = {}): GitHubClient {
  const auth: GhAuth = { kind: "ok", token: opts.token ?? TOKEN, source: "env" };
  const c = new GitHubClient(gh.base, async () => auth, fetch, { shared: new SharedStore(root), ...(opts.now ? { now: opts.now } : {}) });
  c.freshMs = opts.freshMs ?? 20_000;
  return c;
}

const pulls = (gh: FakeGitHub) => gh.requests.filter((r) => r.path === "/repos/octo-org/example/pulls/7");

test("six sessions reading the same pull request within the window cost one request between them", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  const sessions = Array.from({ length: 6 }, () => client(gh, root));
  const first = await sessions[0].getPull("octo-org/example", 7);
  assert.equal(first.kind, "ok");
  for (const s of sessions.slice(1)) {
    const r = await s.getPull("octo-org/example", 7);
    assert.deepEqual(r, first, "the others get the same answer");
  }
  assert.equal(pulls(gh).length, 1);
  assert.equal(sessions[0].requests.ok, 1);
  assert.equal(sessions[1].requests.ok + sessions[1].requests.not_modified, 0, "a session that read the store made no request");
  assert.equal(sessions[1].requests.shared, 1);
});

test("sessions asking at the same moment still make one request: the others wait for the lease holder's answer", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  const sessions = Array.from({ length: 6 }, () => client(gh, root));
  const results = await Promise.all(sessions.map((s) => s.getPull("octo-org/example", 7)));
  assert.ok(results.every((r) => r.kind === "ok"));
  assert.equal(pulls(gh).length, 1);
});

test("once the window has passed, the next asker revalidates with the stored ETag, and an unchanged answer is a free 304", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  let t = 1_000_000;
  const a = client(gh, root, { now: () => t });
  const b = client(gh, root, { now: () => t });
  await a.getPull("octo-org/example", 7);
  t += 25_000;
  const r = await b.getPull("octo-org/example", 7);
  assert.equal(r.kind, "ok");
  assert.deepEqual(pulls(gh).map((x) => x.status), [200, 304], "b sent a's ETag although b never asked before");
  assert.equal(b.requests.not_modified, 1);
  t += 5_000;
  await a.getPull("octo-org/example", 7);
  assert.equal(pulls(gh).length, 2, "b's revalidation refreshed the window for a too");
});

test("a change is seen by every session: the new answer replaces the stored one", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  let t = 1_000_000;
  const a = client(gh, root, { now: () => t });
  const b = client(gh, root, { now: () => t });
  await a.getPull("octo-org/example", 7);
  gh.setPull("octo-org/example", 7, { head: { sha: "b".repeat(40), ref: "feat" }, base: { ref: "main" } });
  t += 25_000;
  await a.getPull("octo-org/example", 7);
  const seen = await b.getPull("octo-org/example", 7);
  assert.equal(seen.kind === "ok" && seen.value.headSha, "b".repeat(40));
  assert.equal(pulls(gh).length, 2);
});

test("two GitHub logins never share: each has its own store, because each can see different repositories", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  const a = client(gh, root);
  const other = client(gh, root, { token: "ghp_anotherloginanotherloginanother0" });
  await a.getPull("octo-org/example", 7);
  await other.getPull("octo-org/example", 7);
  assert.equal(pulls(gh).length, 2);
});

test("a lease left by a session that died is taken over, so a crash never stops the others", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  const a = client(gh, root);
  await a.getPull("octo-org/example", 7); // creates the store's directory
  const dir = readdirSync(root).map((d) => join(root, d)).find((d) => statSync(d).isDirectory()) as string;
  const store = new SharedStore(root);
  const key = store.keyFor("/repos/octo-org/example/pulls/7");
  writeFileSync(join(dir, `${key}.lock`), JSON.stringify({ pid: 999_999_999, at: Date.now() }));
  let t = Date.now() + 60_000;
  const b = client(gh, root, { now: () => t });
  const r = await b.getPull("octo-org/example", 7);
  assert.equal(r.kind, "ok");
  assert.equal(pulls(gh).length, 2, "b asked GitHub itself instead of waiting on a dead process");
  t += 1;
});

test("the rate limit left, as any session last saw it, is what every session backs off on", async () => {
  const gh = await fake();
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  const a = client(gh, root);
  const b = client(gh, root);
  await a.getPull("octo-org/example", 7);
  await b.login(); // every pass starts with this; it is what tells b which login's store to read
  assert.equal(typeof a.rateRemaining, "number");
  assert.equal(b.rateRemaining, a.rateRemaining, "b has made no request and still knows the machine's rate limit");
});

test("the store is private to the user and holds no token and no response body: only the fields the channel reads", async () => {
  const gh = await fake();
  gh.setPull("octo-org/example", 7, { head: { sha: "a".repeat(40), ref: "feat" }, base: { ref: "main" }, body: "SECRET DESCRIPTION TEXT", title: "SECRET TITLE" });
  const root = mkdtempSync(join(tmpdir(), "rio-shared-"));
  await client(gh, root).getPull("octo-org/example", 7);
  const dirs = readdirSync(root).map((d) => join(root, d));
  assert.equal(dirs.length, 1);
  assert.equal(statSync(dirs[0]).mode & 0o777, 0o700);
  for (const f of readdirSync(dirs[0])) {
    const p = join(dirs[0], f);
    assert.equal(statSync(p).mode & 0o777, 0o600, f);
    const text = readFileSync(p, "utf8");
    assert.equal(text.includes(TOKEN), false, `${f} holds the token`);
    assert.equal(text.includes("SECRET"), false, `${f} holds the PR's text`);
  }
  assert.equal(dirs[0].includes(TOKEN.slice(4, 12)), false, "the directory name is not the token");
});

test("a store that cannot be written is not an outage: the session asks GitHub itself", async () => {
  const gh = await fake();
  const file = join(mkdtempSync(join(tmpdir(), "rio-shared-")), "not-a-dir");
  writeFileSync(file, "x");
  const r = await client(gh, file).getPull("octo-org/example", 7);
  assert.equal(r.kind, "ok");
  assert.equal(pulls(gh).length, 1);
});
