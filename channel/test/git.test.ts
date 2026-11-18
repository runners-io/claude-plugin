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
    assert.deepEqual(await readGitScope(dir), { repo: null, branch: null });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    assert.deepEqual(await readGitScope(dir), { repo: "acme/widgets", branch: "main" });
    git("checkout", "-q", "-b", "fix-login");
    assert.deepEqual(await readGitScope(dir), { repo: "acme/widgets", branch: "fix-login" });
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
