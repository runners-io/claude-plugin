import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseGitHubRemote, readGitScope } from "../src/git.ts";

test("every common form of a GitHub remote names owner/name", () => {
  for (const url of [
    "git@github.com:acme/widgets.git",
    "git@github.com:acme/widgets",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com:22/acme/widgets",
    "https://github.com/acme/widgets.git",
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets/",
    "https://x-access-token:abc@github.com/acme/widgets.git",
  ]) {
    assert.equal(parseGitHubRemote(url), "acme/widgets", url);
  }
  assert.equal(parseGitHubRemote("git@github.com:acme/my.repo.js.git"), "acme/my.repo.js");
});

test("a remote that is not GitHub, or not a repository, names nothing", () => {
  for (const url of ["git@gitlab.com:acme/widgets.git", "https://github.com.evil/acme/w", "https://github.com/acme", "/tmp/repo", "", "https://github.com/acme/.."]) {
    assert.equal(parseGitHubRemote(url), null, url);
  }
});

test("readGitScope follows the checked-out branch, and a directory with no repository is null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rio-git-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    assert.deepEqual(await readGitScope(dir), { repo: null, branch: null, pushed: null });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    assert.deepEqual(await readGitScope(dir), { repo: "acme/widgets", branch: "main", pushed: null });
    git("checkout", "-q", "-b", "fix-login");
    assert.deepEqual(await readGitScope(dir), { repo: "acme/widgets", branch: "fix-login", pushed: null });
    // A push moves refs/remotes/origin/<branch> in the clone; here it is set as git push would set it.
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git("update-ref", "refs/remotes/origin/fix-login", head);
    assert.deepEqual(await readGitScope(dir), { repo: "acme/widgets", branch: "fix-login", pushed: head });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inOwnHistory: a commit is this work tree's own only when it is HEAD or behind it, not merely in the shared object store", async () => {
  const { inOwnHistory } = await import("../src/git.ts");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "own-history-"));
  const main = join(root, "main");
  const other = join(root, "other");
  const g = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  g(main, "commit", "-q", "--allow-empty", "-m", "one");
  const one = g(main, "rev-parse", "HEAD");
  g(main, "worktree", "add", "-q", "-b", "feature", other);
  g(other, "commit", "-q", "--allow-empty", "-m", "two, pushed from the other worktree");
  const two = g(other, "rev-parse", "HEAD");

  assert.equal(await inOwnHistory(main, one), true, "HEAD");
  assert.equal(await inOwnHistory(main, two), false, "in the shared object store, but another worktree's commit: a presence check misses it");
  assert.equal(await inOwnHistory(other, two), true);
  assert.equal(await inOwnHistory(other, one), true, "an ancestor of HEAD: this work tree has moved on past it");
  assert.equal(await inOwnHistory(main, "f".repeat(40)), false, "a commit this machine has never seen");
  assert.equal(await inOwnHistory(root, one), null, "not a work tree: cannot tell");
  assert.equal(await inOwnHistory(main, "not-a-sha"), null);
});

test("readPushed reads origin/<b> for every branch asked in one go, and a worktree's push moves it in the session's folder", async () => {
  const { readPushed } = await import("../src/git.ts");
  const root = mkdtempSync(join(tmpdir(), "rio-pushed-"));
  const main = join(root, "main");
  const tree = join(root, "tree");
  try {
    const g = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    g(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    const one = g(main, "rev-parse", "HEAD");
    g(main, "update-ref", "refs/remotes/origin/feat-a", one);
    g(main, "update-ref", "refs/remotes/origin/feat-c/nested", one); // below the pattern origin/feat-c: not origin/feat-c
    assert.deepEqual(await readPushed(main, ["feat-a", "feat-b", "feat-c"]), new Map([["feat-a", one], ["feat-b", null], ["feat-c", null]]));
    // A worktree of the clone: a push from it (here, the ref update git push makes) is seen from the session's folder.
    g(main, "worktree", "add", "-q", "-b", "feat-b", tree);
    g(tree, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
    const two = g(tree, "rev-parse", "HEAD");
    g(tree, "update-ref", "refs/remotes/origin/feat-b", two);
    assert.deepEqual(await readPushed(main, ["feat-a", "feat-b"]), new Map([["feat-a", one], ["feat-b", two]]));
    // A name git would never make a ref of is not read and not passed to git; it has no reading.
    assert.deepEqual(await readPushed(main, ["a b", "tab\tname", "f*", "x/../y", "/lead", "feat-b"]), new Map([["feat-b", two]]));
    assert.deepEqual(await readPushed(main, []), new Map());
    // No repository: no reading at all, which is not "no ref".
    assert.equal(await readPushed(root, ["feat-a"]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a github.com remote is not read as a repository while the plugin is set to another GitHub host, nor the other way round", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rio-git-host-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    git("remote", "add", "upstream", "https://github.com/upstream/widgets.git");
    // Asked of another server, acme/widgets is another repository: its answer must never be reported as this one's.
    const enterprise = { RUNNERS_IO_GITHUB_API: "https://ghe.corp.example/api/v3" };
    assert.deepEqual(await readGitScope(dir, enterprise), { repo: null, branch: "main", pushed: null });
    // The controls: unset, github.com's own API, and the tests' fake that stands in for it.
    for (const env of [{}, { RUNNERS_IO_GITHUB_API: "https://api.github.com" }, { RUNNERS_IO_GITHUB_API: "http://127.0.0.1:8790", RUNNERS_IO_TEST_FAKE_GITHUB: "1" }]) {
      assert.deepEqual(await readGitScope(dir, env), { repo: "acme/widgets", branch: "main", pushed: null, upstream: "upstream/widgets" }, JSON.stringify(env));
    }
    // The other way round: a remote on the Enterprise host is never asked of github.com, whatever the plugin is set to.
    git("remote", "set-url", "origin", "git@ghe.corp.example:acme/widgets.git");
    git("remote", "remove", "upstream");
    assert.deepEqual(await readGitScope(dir, {}), { repo: null, branch: "main", pushed: null });
    assert.deepEqual(await readGitScope(dir, enterprise), { repo: null, branch: "main", pushed: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
