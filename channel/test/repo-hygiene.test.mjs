// The repository's own supply chain: what its CI runs, what keeps that up to date, and where a vulnerability is
// reported. Runs in the published repository and in the tree it is published from.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflows = join(root, ".github", "workflows");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("every action a workflow uses is pinned to a full commit SHA, so a moved tag cannot change what runs", () => {
  const files = readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0);
  let seen = 0;
  for (const f of files)
    for (const line of read(".github", "workflows", f).split("\n")) {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (!m) continue;
      seen++;
      assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${line.trim()}`);
    }
  assert.ok(seen > 0, "no uses: line was read, so nothing was checked");
});

test("npm ci runs no package's install scripts", () => {
  let seen = 0;
  for (const f of readdirSync(workflows))
    for (const line of read(".github", "workflows", f).split("\n"))
      if (/\bnpm ci\b/.test(line)) {
        seen++;
        assert.match(line, /--ignore-scripts/, `${f}: ${line.trim()}`);
      }
  assert.ok(seen > 0);
});

test("Dependabot watches the workflow actions and the channel's npm packages", () => {
  const file = join(root, ".github", "dependabot.yml");
  assert.ok(existsSync(file), ".github/dependabot.yml");
  const text = readFileSync(file, "utf8");
  assert.match(text, /package-ecosystem:\s*"?github-actions"?/);
  assert.match(text, /package-ecosystem:\s*"?npm"?[\s\S]*?directory:\s*"?\/channel"?/);
});

test("Dependabot here raises alerts but opens no pull requests: this repository is published, and updates land at the source", () => {
  const text = readFileSync(join(root, ".github", "dependabot.yml"), "utf8");
  const entries = text.split(/\n\s*-\s*package-ecosystem:/).slice(1);
  assert.ok(entries.length >= 2, "both entries were read");
  for (const e of entries) assert.match(e, /\n\s+open-pull-requests-limit:\s*0\s*(\n|$)/, e.split("\n")[0]);
});

test("SECURITY.md offers GitHub's private vulnerability reporting as well as the email address", () => {
  const text = read("SECURITY.md");
  assert.match(text, /security@runners\.io/);
  assert.match(text, /https:\/\/github\.com\/runners-io\/claude-plugin\/security\/advisories\/new/);
});

test(".gitignore keeps local and packed files out", () => {
  const lines = new Set(read(".gitignore").split("\n").map((l) => l.trim()));
  for (const entry of ["node_modules/", ".env*", ".DS_Store", "*.tgz", ".claude/settings.local.json", "coverage/"])
    assert.ok(lines.has(entry), entry);
});

// A pull request from a fork runs the fork's own copy of this file, so nothing here can stop a fork from asking for
// any runner. What this file can do is run nothing of a fork's: the check runs for pushes, for a person's dispatch, and
// for pull requests from a branch of this repository (which is how a release is published). A fork's pull request
// FAILS the check before anything is checked out, rather than skipping it: a ruleset requires this check by name, and
// GitHub counts a skipped required check as passing.
const ciText = () => readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const FORK = "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository";

/** The check job's header (up to `steps:`) and its steps, each step's text from its `- ` line. */
function checkJob() {
  const ci = ciText();
  const job = /\n {2}check:\n([\s\S]*?)\n {4}steps:\n([\s\S]*?)(?=\n {2}\S|$)/.exec(ci);
  assert.ok(job, "the check job");
  const steps = job[2].split(/\n(?= {6}- )/).filter((s) => s.trim());
  assert.ok(steps.length > 3, "its steps were read");
  return { header: job[1], steps };
}

// The check runs on a runners.io runner. That is safe only because nothing of a fork's runs here: the refusal below is
// the job's first step, and the repository asks a maintainer to approve every outside contributor's run.
test("the check runs on a runners.io runner, and the workflow says why that is safe", () => {
  const { header } = checkJob();
  assert.match(`\n${header}\n`, /\n {4}runs-on: runnersio-2vcpu-ubuntu-2404\n/);
  const ci = ciText();
  assert.doesNotMatch(ci, /GitHub-hosted runner, never one of our own/, "the old comment says the opposite");
  assert.match(ci, /^# .*runners\.io runner/m, "the file's own comment says where it runs");
  assert.match(ci, /approv/i, "and names the approval that outside contributors' runs need");
  assert.doesNotMatch(ci, new RegExp(["self", "hosted"].join("-")), "never a runner of the repository's own registering");
});

test("the required check keeps its name, and the job has no if: of its own, so a fork's pull request never skips it", () => {
  const { header } = checkJob();
  assert.match(`\n${header}\n`, /\n {4}name: manifest, bundle and tests\n/, "the ruleset requires the check by this exact name");
  assert.doesNotMatch(`\n${header}`, /\n {4}if:/, "a job-level if: skips the job, and a skipped required check passes");
});

test("on a fork's pull request the first step fails the check, with a message, before anything is checked out", () => {
  const { steps } = checkJob();
  const first = steps[0];
  assert.doesNotMatch(first, /uses:/, "the first step checks nothing out and runs no action");
  assert.ok(first.includes(`if: ${FORK}`), `the first step runs only for a fork's pull request:\n${first}`);
  assert.match(first, /::error[^\n]*fork/i, "it says why");
  assert.match(first, /\n\s+exit 1\s*$/, "and fails");
  // Every later step runs only after the steps before it succeeded: none overrides that with always() or failure().
  for (const s of steps.slice(1)) assert.doesNotMatch(s, /\b(always|failure|cancelled)\(\)/, s.split("\n")[0]);
  // The control: for this repository's own branch the condition is false, so the check goes on.
  assert.ok(!FORK.includes("== github.repository"));
});

test("the workflow stays read-only and secret-free: no pull_request_target, no secrets, no persisted credentials", () => {
  const ci = ciText();
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.doesNotMatch(ci, /\$\{\{[^}]*\bsecrets\b/, "no expression reads a secret");
  assert.match(ci, /\npermissions:\n {2}contents: read\n/);
  const { steps } = checkJob();
  const checkout = steps.find((s) => /uses: actions\/checkout@/.test(s));
  assert.ok(checkout, "the checkout step");
  assert.match(checkout, /persist-credentials: false/);
});
