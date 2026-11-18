// The channel's side of the hand-over from hooks/pr-created.mjs. A request is a file under
// `<root>/requests/<claude pid>/`; the channel of that Claude process takes each once.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { REQUEST_MAX_AGE_MS, removeRequests, resetRequests, takeRequests } from "../src/hookrequests.ts";

function put(root: string, pid: number, name: string, body: unknown) {
  const dir = join(root, "requests", String(pid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "requests"), 0o700);
  writeFileSync(join(dir, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  return dir;
}

test("takes this session's requests once, and leaves another session's alone", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const at = Date.now();
  put(root, 4242, "a", { repo: "acme/widgets", pr: 42, at });
  const other = put(root, 999, "b", { repo: "acme/widgets", pr: 43, at });
  assert.deepEqual(takeRequests(root, 4242), [{ repo: "acme/widgets", pr: 42, at }]);
  assert.deepEqual(takeRequests(root, 4242), [], "taken once: the file is gone");
  assert.equal(readdirSync(other).length, 1, "the other session's request is not touched");
});

test("a requests folder another user could write to is refused and left as it is", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const dir = put(root, 4242, "a", { repo: "acme/widgets", pr: 42, at: 1 });
  chmodSync(dir, 0o777);
  assert.deepEqual(takeRequests(root, 4242), []);
  assert.equal(readdirSync(dir).length, 1);
});

test("a request that is not a plain repo and PR number is dropped, not subscribed", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const dir = put(root, 4242, "bad1", { repo: "../../etc", pr: 1, at: 1 });
  put(root, 4242, "bad2", { repo: "acme/widgets", pr: "7; rm -rf /", at: 1 });
  put(root, 4242, "bad3", "not json");
  put(root, 4242, "good", { repo: "acme/widgets", pr: 9, at: 5 });
  assert.deepEqual(takeRequests(root, 4242, undefined, 10), [{ repo: "acme/widgets", pr: 9, at: 5 }]);
  assert.deepEqual(readdirSync(dir), [], "the bad ones are deleted too, so they are not read again");
});

test("no requests folder at all is simply nothing to take", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  assert.deepEqual(takeRequests(root, 4242), []);
  assert.equal(existsSync(join(root, "requests")), false, "reading creates nothing");
});

test("a request older than a few minutes is dropped, and its file removed", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const now = 10_000_000;
  const dir = put(root, 4242, "old", { repo: "acme/widgets", pr: 1, at: now - REQUEST_MAX_AGE_MS - 1 });
  put(root, 4242, "new", { repo: "acme/widgets", pr: 2, at: now - 1000 });
  assert.deepEqual(takeRequests(root, 4242, undefined, now), [{ repo: "acme/widgets", pr: 2, at: now - 1000 }]);
  assert.deepEqual(readdirSync(dir), []);
  assert.ok(REQUEST_MAX_AGE_MS >= 60_000 && REQUEST_MAX_AGE_MS <= 10 * 60_000, "a few minutes");
});

test("at start the channel empties its pid's folder (a reused pid must not inherit another session's requests)", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const dir = put(root, 4242, "left-over", { repo: "acme/widgets", pr: 1, at: Date.now() });
  resetRequests(root, 4242);
  assert.deepEqual(readdirSync(dir), []);
});

test("at exit the channel removes its pid's folder, but never follows a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const dir = put(root, 4242, "a", { repo: "acme/widgets", pr: 1, at: Date.now() });
  removeRequests(root, 4242);
  assert.equal(existsSync(dir), false);
  const elsewhere = mkdtempSync(join(tmpdir(), "rio-req-"));
  writeFileSync(join(elsewhere, "keep.json"), "{}");
  symlinkSync(elsewhere, join(root, "requests", "4243"));
  removeRequests(root, 4243);
  assert.deepEqual(readdirSync(elsewhere), ["keep.json"]);
});

test("at exit, a requests folder that is a symlink is never followed into, even to a plain folder of the user's", () => {
  const root = mkdtempSync(join(tmpdir(), "rio-req-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "rio-req-"));
  mkdirSync(join(elsewhere, "4242"), { mode: 0o700 });
  writeFileSync(join(elsewhere, "4242", "keep.json"), "{}");
  symlinkSync(elsewhere, join(root, "requests"));
  removeRequests(root, 4242);
  assert.deepEqual(readdirSync(join(elsewhere, "4242")), ["keep.json"], "the folder the link points at is untouched");
  // The control: the same layout as a real folder is removed.
  const plain = mkdtempSync(join(tmpdir(), "rio-req-"));
  const dir = put(plain, 4242, "a", { repo: "acme/widgets", pr: 1, at: Date.now() });
  removeRequests(plain, 4242);
  assert.equal(existsSync(dir), false);
});
