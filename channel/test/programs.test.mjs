// Which program a bare name runs (hooks/programs.mjs). gh, git and ps are started with the session's folder as the
// working folder, and a repository is somebody else's text: a file named gh or git in it must never be the one that
// runs. So a name is resolved to an absolute path from PATH first, and only that path is ever started.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { psRow } from "../../hooks/launch.mjs";
import { repoOfFolder } from "../../hooks/pr-created.mjs";
import { findProgram } from "../../hooks/programs.mjs";
import { which } from "../../hooks/readiness.mjs";
import { readGitScope } from "../src/git.ts";
import { readGhAuth } from "../src/github.ts";

const REAL_GIT_DIR = dirname(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function script(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * A repository somebody planted programs in (gh, git and ps, each leaving a mark when run), and a folder outside it
 * holding the real ones. `marks` lists what the planted programs wrote.
 */
function planted() {
  const root = mkdtempSync(join(tmpdir(), "rio-programs-"));
  roots.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const mark = join(root, "planted-ran");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  for (const name of ["gh", "git", "ps"]) script(join(repo, name), `echo ${name} >> '${mark}'\necho planted`);
  script(join(repo, "tools", "gh"), `echo tools/gh >> '${mark}'\necho planted`);
  script(join(bin, "gh"), "echo gho_fromTheRealGh");
  return { root, repo, bin, mark };
}

/** Runs `body` with the working folder and PATH changed, as a hook or the channel started in that folder would see them. */
async function inFolder(dir, path, body) {
  const was = { cwd: process.cwd(), path: process.env.PATH };
  process.chdir(dir);
  process.env.PATH = path;
  try {
    return await body();
  } finally {
    process.chdir(was.cwd);
    process.env.PATH = was.path;
  }
}

const ran = (p) => {
  try {
    return execFileSync("/bin/cat", [p.mark], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

test("a name is found only in PATH's absolute folders: an empty entry, `.` and a relative folder are never looked in", () => {
  const p = planted();
  const env = { PATH: `:.:tools:${p.repo}/../repo/missing:${p.bin}` };
  const was = process.cwd();
  process.chdir(p.repo);
  try {
    assert.equal(findProgram("gh", env, "linux"), join(p.bin, "gh"));
    assert.equal(findProgram("gh", { PATH: ":.:tools" }, "linux"), null, "nothing but the working folder: not found, never the planted one");
    assert.equal(findProgram("gh", { PATH: "" }, "linux"), null);
    assert.equal(findProgram("gh", {}, "linux"), null);
  } finally {
    process.chdir(was);
  }
});

test("only a file this user may run is a program: a folder of that name, or a file without the execute bit, is passed over", () => {
  const p = planted();
  const first = join(p.root, "first");
  mkdirSync(join(first, "gh"), { recursive: true });
  const second = join(p.root, "second");
  mkdirSync(second);
  writeFileSync(join(second, "gh"), "not a program");
  assert.equal(findProgram("gh", { PATH: `${first}:${second}:${p.bin}` }, "linux"), join(p.bin, "gh"));
});

test("a name that is a path, or is empty, is never looked up: only a bare name is", () => {
  const p = planted();
  for (const name of ["", "./gh", "../repo/gh", join(p.bin, "gh"), "tools/gh", "tools\\gh", "gh\0"]) assert.equal(findProgram(name, { PATH: p.bin }, "linux"), null, JSON.stringify(name));
});

test("on Windows: PATH's absolute folders in order with PATHEXT's endings, never the working folder, and only what starts without a shell", () => {
  const tried = [];
  const there = new Set(["C:\\Program Files\\GitHub CLI\\gh.EXE", "C:\\shims\\gh.CMD", "C:\\Program Files\\Git\\cmd\\git.exe"]);
  const isProgram = (file) => {
    tried.push(file);
    return there.has(file);
  };
  const env = { Path: ".;;tools;C:relative;\\rooted-on-no-drive;C:\\shims;C:\\Program Files\\GitHub CLI;C:\\Program Files\\Git\\cmd", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(findProgram("gh", env, "win32", isProgram), "C:\\Program Files\\GitHub CLI\\gh.EXE");
  assert.deepEqual(
    tried,
    ["C:\\shims\\gh.COM", "C:\\shims\\gh.EXE", "C:\\Program Files\\GitHub CLI\\gh.COM", "C:\\Program Files\\GitHub CLI\\gh.EXE"],
    "no relative or empty entry is looked in, and a .BAT or .CMD is never chosen: neither starts without a shell",
  );
  assert.equal(findProgram("git", { PATH: env.Path, PATHEXT: ".exe" }, "win32", isProgram), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(findProgram("git", { PATH: env.Path, PATHEXT: ".exe;..\\..\\evil;;.e*e" }, "win32", isProgram), "C:\\Program Files\\Git\\cmd\\git.exe", "an ending that is not an ending is not used");
  assert.equal(findProgram("gh", { PATH: ".;;tools", PATHEXT: ".EXE" }, "win32", () => true), null, "only the working folder on PATH: not found");
});

test("the setup checks' `which` is the same lookup", () => {
  const p = planted();
  assert.equal(which("gh", { PATH: `.:${p.bin}` }, "linux"), join(p.bin, "gh"));
  assert.equal(which, findProgram);
});

test("the channel reads the login from the gh on PATH, never from a gh planted in the session's folder", async () => {
  const p = planted();
  const auth = await inFolder(p.repo, `.::tools:${p.bin}`, () => readGhAuth({}));
  assert.deepEqual(auth, { kind: "ok", token: "gho_fromTheRealGh", source: "gh" });
  assert.equal(ran(p), "", "no planted program ran");
});

test("with gh only in the session's folder, the channel says gh is not installed, and runs nothing", async () => {
  const p = planted();
  const auth = await inFolder(p.repo, ".::tools", () => readGhAuth({}));
  assert.deepEqual(auth, { kind: "not_installed" });
  assert.equal(ran(p), "");
});

test("the channel reads the repository with the git on PATH, never a git planted in the session's folder", async () => {
  const p = planted();
  const scope = await inFolder(p.repo, `.::${REAL_GIT_DIR}`, () => readGitScope(p.repo));
  assert.deepEqual(scope, { repo: "acme/widgets", branch: "main", pushed: null });
  assert.equal(ran(p), "");
  const none = await inFolder(p.repo, ".:", () => readGitScope(p.repo));
  assert.deepEqual(none, { repo: null, branch: null, pushed: null }, "git only in the folder: as with no git at all");
  assert.equal(ran(p), "");
});

test("the pull-request hook reads the folder's remote with the git on PATH, never a planted one", async () => {
  const p = planted();
  assert.equal(await inFolder(p.repo, `.::${REAL_GIT_DIR}`, () => repoOfFolder(p.repo)), "acme/widgets");
  assert.equal(await inFolder(p.repo, ".:", () => repoOfFolder(p.repo)), null);
  assert.equal(repoOfFolder(p.repo, "origin", { PATH: `.::${REAL_GIT_DIR}` }), "acme/widgets", "the environment can be handed in");
  assert.equal(ran(p), "");
});

test("the launch is read with the ps on PATH, never a planted one; with none, and on Windows, there is no answer", async () => {
  const p = planted();
  const row = await inFolder(p.repo, `.::${dirname(findProgram("ps"))}`, () => psRow(process.pid));
  assert.equal(typeof row?.ppid, "number");
  assert.equal(ran(p), "");
  assert.throws(() => psRow(process.pid, { env: { PATH: ".:" } }), /ps is not on PATH/);
  assert.equal(await inFolder(p.repo, ".:", () => psRow(process.pid, { platform: "win32" })), null, "Windows has no ps: it is not looked for at all");
  assert.equal(ran(p), "");
});
