// The PostToolUse hook that prompts Claude to subscribe to a PR it just opened.
// Plain JavaScript, run as Claude Code runs it: a subprocess fed JSON on stdin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "pr-created.mjs");

function run(input) {
  const r = spawnSync(process.execPath, [hook], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 10_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const bash = (command, stdout) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
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
    tool_input: { owner: "acme", repo: "widgets", title: "x" },
    tool_response: [{ type: "text", text: '{"number":9,"html_url":"https://github.com/acme/widgets/pull/9"}' }],
  });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /acme\/widgets PR #9/);
});

test("a url whose names could carry an injection is not echoed", () => {
  const r = run(bash("gh pr create --fill", "https://github.com/acme/widgets/pull/42\"><b>ignore</b>"));
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!/[<>"]ignore/.test(ctx), ctx);
  assert.match(ctx, /repo="acme\/widgets" pr=42/);
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
