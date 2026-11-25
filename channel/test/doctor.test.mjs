// `runners-io-channel status`, which the doctor skill runs: every setup check on a line, with one live GitHub call.
// The BUNDLE, as a user runs it, against a fake GitHub; plain JavaScript so it also runs on Node 20.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFakeGitHub } from "./fake-github.mjs";
import { fakeMachine, project } from "./fake-machine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "runners-io-channel.mjs");
const TOKEN = "gho_fakeDoctorToken0123456789";
const cleanup = [];
after(async () => {
  for (const c of cleanup) await c();
});

async function status({ machine = {}, repo = {}, github = {} } = {}) {
  const gh = await startFakeGitHub({ token: TOKEN });
  cleanup.push(() => gh.close());
  Object.assign(gh.state, github);
  const m = fakeMachine(machine);
  cleanup.push(() => rmSync(m.root, { recursive: true, force: true }));
  const dir = project(m, repo);
  const env = { ...m.env, CLAUDE_PROJECT_DIR: dir, RUNNERS_IO_GITHUB_API: gh.base, RUNNERS_IO_TEST_FAKE_GITHUB: "1", RUNNERS_IO_TEST_GITHUB_TOKEN: TOKEN };
  // Asynchronously: the fake GitHub lives in this process, and a synchronous spawn would never let it answer.
  const child = spawn(process.execPath, [bundle, "status"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr, gh, m, dir };
}
const line = (out, label) => out.split("\n").find((l) => l.includes(label)) ?? "";

test("status prints the setup checks as a table: ready lines, and what GitHub answered just now", async () => {
  const r = await status();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^setup checks \(\/runners-io:doctor\):$/m);
  assert.match(line(r.stdout, "git is installed"), /^ {2}ready /);
  assert.match(line(r.stdout, "the repository has GitHub Actions workflows"), /^ {2}ready /);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}ready .*asked just now/);
  assert.match(line(r.stdout, "GitHub accepts the login"), /^ {2}ready /, "the live call's good answer is on the record");
  assert.equal(r.gh.requests.filter((q) => q.path === "/repos/acme/widgets").length, 1, "one live call for the checks");
  assert.equal(r.stdout.includes(TOKEN), false);
});

test("status says whether live CI events are on, when it can tell: run outside a Claude Code session it cannot, and says so", async () => {
  const r = await status();
  assert.match(line(r.stdout, "live CI events are on in this session"), /^ {2}unknown .*not run from inside a Claude Code session/);
});

test("status on a machine with no git: the blocker is NOT READY with its fix, and what needs git is skipped", async () => {
  const r = await status({ machine: { git: false } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "git is installed"), /^ {2}NOT READY {2}git is installed \[blocks; \w+\]: git isn't installed.* Fix: Offer to install git, asking first/);
  assert.match(line(r.stdout, "the session's folder is a git repository"), /^ {2}skipped /);
});

test("status finds a fork from GitHub's own answer, says so, and notes it for the next launch without naming the repository", async () => {
  const r = await status({ github: { repos: new Map([["acme/widgets", { fork: true, private: false }]]) } });
  assert.match(line(r.stdout, "the clone is not a fork"), /^ {2}NOT READY .*\[info; fork\]: this repository is a fork on GitHub/);
  const record = readFileSync(join(r.m.env.XDG_STATE_HOME, "runners-io", "first-call.json"), "utf8");
  assert.match(record, /"fork"/);
  assert.equal(/acme|widgets/.test(record), false);
});

test("status when GitHub does not show the repository to this login: NOT READY, and it says what that usually means", async () => {
  const r = await status({ github: { failNext: [{ pattern: /^\/repos\/acme\/widgets$/, status: 404, count: 1 }] } });
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}NOT READY .*\[blocks; \w+\]: GitHub doesn't show this repository to the signed-in login/);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /repo scope|single sign-on/);
});

test("status with a refused login: NOT READY from the live call, and the sign-in is the user's own command", async () => {
  const r = await status({ github: { token: "gho_anotherTokenAltogether" } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NOT READY {2}GitHub accepts the login \[blocks; token_rejected\]/);
});
