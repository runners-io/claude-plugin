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
