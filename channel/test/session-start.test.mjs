// The SessionStart hook that tells the user when live CI events are off in this session, and how to relaunch it
// with the flag on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OFFER_QUESTION, noticeFor } from "../../hooks/session-start.mjs";

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

// ---- the claude-gh offer: made while claude-gh is missing, except for 7 days after a no (claude-gh.mjs
// decline); silent once it exists, and never in a headless run.

const ROOT = "/Users/me/.claude/plugins/cache/runners-io/runners-io/0.2.0";

test("channel on and no claude-gh: Claude is asked to offer it once in this session, with nothing shown to the user directly", () => {
  const out = noticeFor(input(), { state: "on" }, ROOT, { claudeGh: false });
  assert.equal(out.systemMessage, undefined);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Set up `claude-gh` so live CI events are on whenever you start Claude Code with it\?/);
  assert.match(ctx, /setup-github/);
  assert.match(ctx, /once in this session/i);
  assert.match(ctx, /no/i);
});

test("a no is recorded by a command the offer names, and the user is told it will be asked again in a week", () => {
  const ctx = noticeFor(input(), { state: "on" }, ROOT, { claudeGh: false }).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(`node ${ROOT}/skills/setup-github/claude-gh.mjs decline`), ctx);
  assert.match(ctx, /7 days/);
  const spaced = noticeFor(input(), { state: "on" }, "/a path/plugin", { claudeGh: false }).hookSpecificOutput.additionalContext;
  assert.ok(spaced.includes("node '/a path/plugin/skills/setup-github/claude-gh.mjs' decline"), "the path is one shell word");
});

test("claude-gh already exists, or whether it does cannot be told: no offer", () => {
  assert.equal(noticeFor(input(), { state: "on" }, ROOT, { claudeGh: true }), null);
  assert.equal(noticeFor(input(), { state: "on" }, ROOT, { claudeGh: null }), null);
});

test("the offer is made again on a later launch: there is no remembered no", () => {
  const first = noticeFor(input("startup"), { state: "on" }, ROOT, { claudeGh: false });
  const later = noticeFor(input("resume"), { state: "on" }, ROOT, { claudeGh: false });
  assert.ok(first && later);
});

test("never in a headless run, and not after /clear or /compact", () => {
  assert.equal(noticeFor(input(), { state: "headless" }, ROOT, { claudeGh: false }), null);
  assert.equal(noticeFor(input("clear"), { state: "on" }, ROOT, { claudeGh: false }), null);
  assert.equal(noticeFor(input("compact"), { state: "off" }, ROOT, { claudeGh: false }), null);
});

test("channel off and no claude-gh: the user sees the relaunch line, and Claude offers claude-gh and then gives the relaunch with it", () => {
  const out = noticeFor(input(), { state: "off" }, ROOT, { claudeGh: false });
  assert.match(out.systemMessage, /live CI events are OFF/);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Set up `claude-gh`/);
  assert.match(ctx, new RegExp(`claude-gh --resume ${SID}`));
});

// The user answers the offer's question and nothing else they are shown, so the question itself says what claude-gh
// does: it starts Claude Code with the development flag, which allows a channel not yet on Claude Code's approved list.
test("the offer's question says claude-gh uses Claude Code's development flag, and what that shows at each launch", () => {
  assert.match(OFFER_QUESTION, /development flag/);
  assert.match(OFFER_QUESTION, /every launch|each launch/);
});
