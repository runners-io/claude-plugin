// The SessionStart hook that tells the user when live CI events are off in this session, and how to relaunch it
// with the flag on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { noticeFor } from "../../hooks/session-start.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "session-start.mjs");
const SID = "3f2a9c1e-0b7d-4c55-9a51-6c8e2f0d4b11";
const input = (source = "startup") => ({ hook_event_name: "SessionStart", session_id: SID, source, cwd: "/w" });

test("launched without the flag: one line for the user and the same for Claude, with the session's own relaunch command", () => {
  const out = noticeFor(input(), { state: "off" }, "/Users/me/.claude/plugins/cache/runners-io/runners-io/0.2.0");
  assert.match(out.systemMessage, /live CI events are OFF/);
  assert.match(out.systemMessage, new RegExp(`claude-gh --resume ${SID}`));
  assert.match(out.systemMessage, /\/runners-io:setup-github/);
  assert.match(out.systemMessage, /checks on request \(ci_status\) still work/i);
  assert.match(out.systemMessage, new RegExp(`claude --resume ${SID} --dangerously-load-development-channels plugin:runners-io@runners-io`));
  assert.equal(out.systemMessage.includes("\n"), false, "one line");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /claude-gh --resume/);
});

test("a plugin loaded with --plugin-dir is relaunched with the same --plugin-dir and the inline entry", () => {
  const out = noticeFor(input("resume"), { state: "off" }, "/opt/plugins/runners-io");
  assert.match(out.systemMessage, new RegExp(`claude --resume ${SID} --plugin-dir /opt/plugins/runners-io --dangerously-load-development-channels plugin:runners-io@inline`));
});

test("no notice when the channel is on, in a headless run, or after /clear or /compact", () => {
  assert.equal(noticeFor(input(), { state: "on" }, "/x"), null);
  assert.equal(noticeFor(input(), { state: "headless" }, "/x"), null, "never in claude -p: scripts and other headless runs get no noise");
  assert.equal(noticeFor(input("clear"), { state: "off" }, "/x"), null);
  assert.equal(noticeFor(input("compact"), { state: "off" }, "/x"), null);
});

test("a session id that is not an id is never echoed into a command: the notice falls back to --continue", () => {
  const out = noticeFor({ ...input(), session_id: "x; rm -rf /" }, { state: "off" }, "/x");
  assert.equal(out.systemMessage.includes("rm -rf"), false);
  assert.match(out.systemMessage, /claude-gh --continue/);
});

test("a --plugin-dir path with a space is quoted for the shell", () => {
  const out = noticeFor(input(), { state: "off" }, "/Users/me/My Plugins/runners-io");
  assert.match(out.systemMessage, /--plugin-dir '\/Users\/me\/My Plugins\/runners-io'/);
});

test("when the launch cannot be read (no ps), the tip is conditional, never a claim that the channel is off", () => {
  const out = noticeFor(input(), { state: "unknown" }, "/x");
  assert.match(out.systemMessage, /^runners\.io: if this session was not started with/);
});

test("run as Claude Code runs it, it exits 0 and prints JSON or nothing, whatever stdin holds", () => {
  for (const stdin of [JSON.stringify(input()), "not json", ""]) {
    const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, stdin);
    if (r.stdout.trim()) assert.doesNotThrow(() => JSON.parse(r.stdout));
  }
});
