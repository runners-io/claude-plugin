// The PostToolUse hook that prompts Claude to subscribe to a PR it just opened.
// Plain JavaScript, run as Claude Code runs it: a subprocess fed JSON on stdin.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "pr-created.mjs");

function run(input) {
  const r = spawnSync(process.execPath, [hook], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 10_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// The session's folder: a clone of acme/widgets. The hook offers a PR to Claude only in the session's own repository.
const WIDGETS = mkdtempSync(join(tmpdir(), "rio-hook-widgets-"));
execFileSync("git", ["init", "-q", WIDGETS]);
execFileSync("git", ["-C", WIDGETS, "remote", "add", "origin", "https://github.com/acme/widgets.git"]);

const bash = (command, stdout) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  cwd: WIDGETS,
  tool_input: { command },
  tool_response: { stdout, stderr: "", interrupted: false },
});

test("gh pr create with a PR url prompts a subscribe naming the repo and the pr", () => {
  const r = run(bash('gh pr create --title "x" --body "y"', "Creating pull request...\nhttps://github.com/acme/widgets/pull/42\n"));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /acme\/widgets PR #42/);
  assert.match(ctx, /subscribe tool/);
  assert.match(ctx, /repo="acme\/widgets" pr=42/);
  assert.match(ctx, /call ci_status/);
});

test("gh pr create inside a longer command line still counts", () => {
  const r = run(bash("cd ../wt/x && git push -u origin HEAD && gh pr create --fill", "https://github.com/acme/widgets/pull/7"));
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PR #7/);
});

test("another Bash command prints nothing, even when its output holds a PR url", () => {
  const r = run(bash("gh pr view 42", "https://github.com/acme/widgets/pull/42"));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("a gh pr create that printed no PR url prints nothing", () => {
  const r = run(bash("gh pr create --fill", "pull request create failed: GraphQL: No commits between main and feat"));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("a GitHub MCP create_pull_request result prompts a subscribe", () => {
  const r = run({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__github__create_pull_request",
    cwd: WIDGETS,
    tool_input: { owner: "acme", repo: "widgets", title: "x" },
    tool_response: [{ type: "text", text: '{"number":9,"html_url":"https://github.com/acme/widgets/pull/9"}' }],
  });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /acme\/widgets PR #9/);
});

// gh pr create prints the address alone on its last line; a line with more on it is not what the create printed.
test("a url whose names could carry an injection is not echoed", () => {
  const r = run(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/42\"><b>ignore</b>"));
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /ignore/);
  const lone = run(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/42\n"));
  assert.match(JSON.parse(lone.stdout).hookSpecificOutput.additionalContext, /repo="acme\/widgets" pr=42/, "the control");
});

test("malformed stdin exits 0 and prints nothing", () => {
  for (const input of ["", "not json", "[]", "null"]) {
    const r = run(input);
    assert.equal(r.code, 0, input);
    assert.equal(r.stdout, "", input);
  }
});

// The hook hands a PR to this session's channel, so a PR is watched without Claude having to call subscribe --
// including one a script opened, whose command line never says `gh pr create`. Only a PR in the repository the
// session works in, only when the channel is on and automatic subscription is not off: a PR URL printed in a log
// or a README is text anyone can write.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { handle } from "../../hooks/pr-created.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "rio-hook-"));
const on = () => ({ state: "on", claudePid: 4242 });
const opts = (root, extra = {}) => ({ launch: on, root, now: 1000, env: {}, repoOf: () => "acme/widgets", ...extra });

test("a script that opened a PR (its command never says gh pr create) still hands the PR to this session's channel", () => {
  const root = scratch();
  const out = handle(bash("./tools/open-pr.sh", "pushed\nopened https://github.com/acme/widgets/pull/42\n"), opts(root));
  const dir = join(root, "requests", "4242");
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), "utf8")), { repo: "acme/widgets", pr: 42, at: 1000 });
  assert.equal(lstatSync(dir).mode & 0o777, 0o700, "the folder is the user's alone");
  assert.equal(out, null, "no message: not a creation Claude made itself, so the channel decides whether it is new");
});

test("gh pr create: the request is written and Claude is told the PR is now watched, not asked to subscribe", () => {
  const root = scratch();
  const out = handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(root));
  assert.equal(readdirSync(join(root, "requests", "4242")).length, 1);
  assert.match(out, /now watching acme\/widgets PR #7/);
  assert.doesNotMatch(out, /call the runners-io channel's subscribe tool/);
});

test("when the Claude process cannot be found, nothing is written and Claude is still asked to subscribe", () => {
  const root = scratch();
  const out = handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(root, { launch: () => ({ state: "on", claudePid: null }) }));
  assert.deepEqual(readdirSync(root), []);
  assert.match(out, /repo="acme\/widgets" pr=7/);
});

test("a requests folder that is a symlink is not written through", () => {
  const root = scratch();
  const elsewhere = scratch();
  mkdirSync(join(root, "requests"), { mode: 0o700 });
  symlinkSync(elsewhere, join(root, "requests", "4242"));
  handle(bash("x.sh", "https://github.com/acme/widgets/pull/42"), opts(root));
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("a PR in another repository is not handed over: a URL in printed output is text anyone can write", () => {
  const root = scratch();
  const out = handle(bash("cat README.md", "see https://github.com/stranger/bait/pull/1 for details\n"), opts(root));
  assert.deepEqual(readdirSync(root), []);
  assert.equal(out, null);
});

test("a session folder with no GitHub repository hands nothing over", () => {
  const root = scratch();
  handle(bash("x.sh", "https://github.com/acme/widgets/pull/42"), opts(root, { repoOf: () => null }));
  assert.deepEqual(readdirSync(root), []);
});

test("automatic subscription switched off: nothing is handed over, and gh pr create still asks Claude to subscribe", () => {
  const root = scratch();
  const out = handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(root, { env: { RUNNERS_IO_AUTO_SUBSCRIBE: "off" } }));
  assert.deepEqual(readdirSync(root), []);
  assert.match(out, /repo="acme\/widgets" pr=7/);
  assert.doesNotMatch(out, /now watching/);
});

test("a session whose channel is not on hands nothing over, and keeps asking Claude to subscribe", () => {
  for (const state of ["off", "headless"]) {
    const root = scratch();
    const out = handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(root, { launch: () => ({ state, claudePid: 4242 }) }));
    assert.deepEqual(readdirSync(root), [], state);
    assert.match(out, /repo="acme\/widgets" pr=7/, state);
    assert.doesNotMatch(out, /now watching/, state);
  }
});

test("output with no PR URL in it never looks for the Claude process", () => {
  let looked = 0;
  const out = handle(bash("ls", "a\nb\n"), opts(scratch(), { launch: () => (looked++, on()) }));
  assert.equal(out, null);
  assert.equal(looked, 0);
});

// The prompt that asks Claude to subscribe is held to the same rule as the hand-over: only the PR this session's own
// `gh pr create` printed, in the session's own repository. Text printed before it, by another command in the same line
// or by a failed create, is anyone's.
test("gh pr create after another command: a stranger's PR URL in the earlier output is never what Claude is asked to watch", () => {
  const root = scratch();
  const out = handle(
    bash("git log -3 && gh pr create --fill", "fix: see https://github.com/stranger/bait/pull/1\nhttps://github.com/acme/widgets/pull/7\n"),
    opts(root, { launch: () => ({ state: "on", claudePid: null }) }),
  );
  assert.doesNotMatch(out ?? "", /stranger/);
  assert.match(out, /repo="acme\/widgets" pr=7/, "the PR the create printed, on its own last line");
});

test("gh pr create that printed no PR of its own: a stranger's URL in its output asks Claude for nothing", () => {
  for (const stdout of [
    "see https://github.com/stranger/bait/pull/1 for details\n",
    "https://github.com/stranger/bait/pull/1 was already open\n",
    "https://github.com/acme/widgets/pull/7\ncreated, then also see https://github.com/stranger/bait/pull/1\n",
  ]) {
    const out = handle(bash("gh pr create --fill", stdout), opts(scratch(), { launch: () => ({ state: "on", claudePid: null }) }));
    assert.equal(out, null, stdout);
  }
});

test("gh pr create in another repository asks Claude for nothing: the session watches its own repository's PRs only", () => {
  const off = { launch: () => ({ state: "on", claudePid: null }) };
  assert.equal(handle(bash("gh pr create -R stranger/bait --fill", "https://github.com/stranger/bait/pull/1\n"), opts(scratch(), off)), null);
  assert.equal(handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(scratch(), { ...off, repoOf: () => null })), null);
});

// A clone that is a fork: its pull requests are opened on the repository it was forked from (the `upstream` remote), so
// that repository's PRs are the session's own too. Any other repository's stay text anyone can write.
const fork = (root, extra = {}) => opts(root, { repoOf: () => "ada/widgets", parentOf: () => "acme/widgets", ...extra });

test("in a fork, gh pr create's pull request on the upstream repository is handed over, and Claude is told it is watched", () => {
  const root = scratch();
  const out = handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), fork(root));
  const dir = join(root, "requests", "4242");
  assert.deepEqual(readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))), [{ repo: "acme/widgets", pr: 7, at: 1000 }]);
  assert.match(out, /now watching acme\/widgets PR #7/);
});

test("in a fork, a script's pull request on the upstream repository is handed over like one in the fork itself", () => {
  const root = scratch();
  const out = handle(bash("./tools/open-pr.sh", "https://github.com/acme/widgets/pull/42\nhttps://github.com/ada/widgets/pull/3\n"), fork(root));
  const dir = join(root, "requests", "4242");
  const handed = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).repo).sort();
  assert.deepEqual(handed, ["acme/widgets", "ada/widgets"]);
  assert.equal(out, null);
});

test("in a fork, a pull request in any other repository is still not the session's: nothing is handed over and Claude is asked for nothing", () => {
  const root = scratch();
  assert.equal(handle(bash("gh pr create -R stranger/bait --fill", "https://github.com/stranger/bait/pull/1\n"), fork(root)), null);
  assert.deepEqual(readdirSync(root), []);
});

test("in a fork whose channel is not on, gh pr create on the upstream repository asks Claude to subscribe to it there", () => {
  const out = handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), fork(scratch(), { launch: () => ({ state: "off", claudePid: 4242 }) }));
  assert.match(out, /You opened acme\/widgets PR #7/);
  assert.match(out, /repo="acme\/widgets" pr=7/);
});

test("the upstream remote is read from the clone: a fork's gh pr create is answered with the upstream repository's pull request", () => {
  const clone = mkdtempSync(join(tmpdir(), "rio-hook-fork-"));
  execFileSync("git", ["init", "-q", clone]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", "git@github.com:ada/widgets.git"]);
  execFileSync("git", ["-C", clone, "remote", "add", "upstream", "https://github.com/acme/widgets.git"]);
  const input = { ...bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), cwd: clone };
  const r = run(input);
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /repo="acme\/widgets" pr=7/);
  // With no upstream remote the hook cannot know of a parent: it asks for nothing, and the channel's own branch watch
  // finds the pull request (it asks GitHub which repository the clone was forked from).
  execFileSync("git", ["-C", clone, "remote", "remove", "upstream"]);
  assert.equal(run(input).stdout, "");
});

test("with the plugin set to another GitHub host, a github.com pull request is neither handed over nor put to Claude: it would be asked of the wrong server", () => {
  const root = scratch();
  const env = { RUNNERS_IO_GITHUB_API: "https://ghe.corp.example/api/v3" };
  assert.equal(handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(root, { env })), null);
  assert.equal(handle(bash("./tools/open-pr.sh", "opened https://github.com/acme/widgets/pull/42\n"), opts(root, { env })), null);
  assert.deepEqual(readdirSync(root), [], "nothing was written for the channel");
  // The control: with github.com's own API named, the same output is handed over.
  assert.match(handle(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"), opts(root, { env: { RUNNERS_IO_GITHUB_API: "https://api.github.com" } })), /now watching acme\/widgets PR #7/);
});
