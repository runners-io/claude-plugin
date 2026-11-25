// The SessionStart hook that tells the user when live CI events are off in this session, and how to relaunch it
// with the flag on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { OFFER_QUESTION, hookOutput, noticeFor } from "../../hooks/session-start.mjs";
import { fakeMachine, project } from "./fake-machine.mjs";

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
  // State and cache folders of its own: the hook runs the setup checks, which keep what they said in the state folder.
  const home = mkdtempSync(join(tmpdir(), "rio-hook-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache") };
  for (const stdin of [JSON.stringify(input()), "not json", ""]) {
    const r = spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: "utf8", timeout: 10_000 });
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

// ---- the setup checks at launch (hooks/readiness.mjs): what the machine is missing, said in the same hook --------

const SETUP = { line: "runners.io: the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.", context: "runners.io plugin setup checks: one thing…" };

test("a setup problem is the first line the user sees, and the first thing Claude is given; the channel line follows unchanged", () => {
  const alone = noticeFor(input(), { state: "off" }, ROOT);
  const out = noticeFor(input(), { state: "off" }, ROOT, { setup: SETUP });
  assert.equal(out.systemMessage, `${SETUP.line}\n${alone.systemMessage}`);
  assert.equal(out.hookSpecificOutput.additionalContext, `${SETUP.context}\n\n${alone.hookSpecificOutput.additionalContext}`);
});

test("a setup problem with the channel on and claude-gh there: its line and context, and nothing else", () => {
  const out = noticeFor(input(), { state: "on" }, ROOT, { claudeGh: true, setup: SETUP });
  assert.deepEqual(out, { systemMessage: SETUP.line, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SETUP.context } });
});

test("a setup problem is never said in a headless run, or after /clear or /compact", () => {
  assert.equal(noticeFor(input(), { state: "headless" }, ROOT, { setup: SETUP }), null);
  assert.equal(noticeFor(input("clear"), { state: "on" }, ROOT, { setup: SETUP }), null);
  assert.equal(noticeFor(input("compact"), { state: "on" }, ROOT, { setup: SETUP }), null);
});

const machines = [];
after(() => {
  for (const m of machines) rmSync(m.root, { recursive: true, force: true });
});
function machine(options) {
  const m = fakeMachine(options);
  machines.push(m);
  return m;
}
const hasClaudeGh = async () => true;

test("a machine that is ready, with the channel on: the hook adds nothing to the session", async () => {
  const m = machine();
  const dir = project(m);
  assert.equal(await hookOutput({ ...input(), cwd: dir }, { env: m.env, launch: { state: "on" }, platform: "linux", claudeGhFor: hasClaudeGh }), null);
});

test("gh missing: the hook's one line names it and Claude is given the offer, whether or not the channel is on", async () => {
  const m = machine({ gh: null });
  const dir = project(m);
  const on = await hookOutput({ ...input(), cwd: dir }, { env: m.env, launch: { state: "on" }, platform: "linux", claudeGhFor: hasClaudeGh });
  assert.equal(on.systemMessage, "runners.io: the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.");
  assert.match(on.hookSpecificOutput.additionalContext, /Fix to offer: Offer to install the GitHub CLI, asking first/);
  const off = await hookOutput({ ...input(), cwd: dir }, { env: m.env, launch: { state: "off" }, platform: "linux", claudeGhFor: hasClaudeGh });
  const [first, second] = off.systemMessage.split("\n");
  assert.equal(first, on.systemMessage);
  assert.match(second, /live CI events are OFF/);
});

test("headless, /clear and /compact: no check is run at all, so nothing is said and nothing is marked as said", async () => {
  const m = machine({ gh: "signed-out" });
  const dir = project(m, { workflows: false });
  const ran = () => existsSync(m.ghLog);
  assert.equal(await hookOutput({ ...input(), cwd: dir }, { env: m.env, launch: { state: "headless" }, platform: "linux", claudeGhFor: hasClaudeGh }), null);
  assert.equal(await hookOutput({ ...input("clear"), cwd: dir }, { env: m.env, launch: { state: "on" }, platform: "linux", claudeGhFor: hasClaudeGh }), null);
  assert.equal(await hookOutput({ ...input("compact"), cwd: dir }, { env: m.env, launch: { state: "on" }, platform: "linux", claudeGhFor: hasClaudeGh }), null);
  assert.equal(ran(), false, "gh was never asked");
  assert.equal(existsSync(join(m.env.XDG_STATE_HOME, "runners-io", "setup-checks.json")), false);
});

test("RUNNERS_IO_NO_SETUP_CHECKS=1 through the hook: a blocker's line and no offer; without a blocker, nothing", async () => {
  const blocked = machine({ gh: null, env: { RUNNERS_IO_NO_SETUP_CHECKS: "1" } });
  const out = await hookOutput({ ...input(), cwd: project(blocked) }, { env: blocked.env, launch: { state: "on" }, platform: "linux", claudeGhFor: hasClaudeGh });
  assert.match(out.systemMessage, /^runners\.io: the GitHub CLI isn't installed/);
  assert.equal(out.hookSpecificOutput.additionalContext.includes("Fix to offer"), false);
  const fine = machine({ env: { RUNNERS_IO_NO_SETUP_CHECKS: "1", HTTPS_PROXY: "http://p:1" } });
  assert.equal(await hookOutput({ ...input(), cwd: project(fine, { workflows: false }) }, { env: fine.env, launch: { state: "on" }, platform: "linux", claudeGhFor: hasClaudeGh }), null);
});

test("checks that take too long are given up on: the hook still answers, with whatever else it had to say", async () => {
  const never = () => new Promise(() => {});
  const begin = Date.now();
  const out = await hookOutput(input(), { env: {}, launch: { state: "off" }, claudeGhFor: hasClaudeGh, setup: never, setupLimitMs: 200 });
  assert.ok(Date.now() - begin < 3000);
  assert.match(out.systemMessage, /^runners\.io: live CI events are OFF/);
});

test("run as Claude Code runs it on a machine with no gh: the JSON it prints carries the line and the offer", () => {
  const m = machine({ gh: null });
  const dir = project(m);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...input(), cwd: dir }), env: { ...m.env, CLAUDE_PLUGIN_ROOT: ROOT }, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /^runners\.io: the GitHub CLI isn't installed, so CI can't be read\. Ask me to set it up\./);
  assert.match(out.hookSpecificOutput.additionalContext, /hooks\/readiness\.mjs decline/);
});

// Where live CI events cannot arrive whatever flag the session is started with (Claude Code on Amazon Bedrock, Google
// Cloud or Microsoft Foundry), telling the user to relaunch with the flag, or offering claude-gh, would send them
// after something that cannot work: the one line about it is said instead.
test("where live CI events cannot arrive, the relaunch line and the claude-gh offer are left out", () => {
  const setup = { line: "runners.io: Claude Code is set to use Amazon Bedrock", context: "ctx" };
  const out = noticeFor(input(), { state: "off" }, "/x", { claudeGh: false, setup, liveEventsUnavailable: true });
  assert.equal(out.systemMessage, setup.line);
  assert.equal(out.hookSpecificOutput.additionalContext, "ctx");
  assert.equal(noticeFor(input(), { state: "off" }, "/x", { claudeGh: false, liveEventsUnavailable: true }), null, "and with nothing new to say, nothing");
  assert.equal(noticeFor(input(), { state: "unknown" }, "/x", { claudeGh: false, liveEventsUnavailable: true }), null);
  // Without it, as before.
  assert.match(noticeFor(input(), { state: "off" }, "/x", { claudeGh: false }).systemMessage, /live CI events are OFF/);
});

test("Claude Code on Bedrock, launched without the flag: one line once in the project, never the relaunch line or the claude-gh offer", async () => {
  const m = machine({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
  const dir = project(m);
  const options = { env: m.env, launch: { state: "off" }, platform: "linux", claudeGhFor: () => false };
  const first = await hookOutput({ ...input(), cwd: dir }, options);
  assert.equal(first.systemMessage, "runners.io: Claude Code is set to use Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK), where live CI events are not available; CI on request (ci_status) still works.");
  assert.equal(first.hookSpecificOutput.additionalContext.includes(OFFER_QUESTION), false);
  assert.equal(/relaunch|claude-gh --/.test(first.systemMessage), false);
  assert.equal(await hookOutput({ ...input(), cwd: dir }, options), null, "said once: the next launch adds nothing");
});

test("Claude Code on Bedrock, launched WITH the channel flag: the line is said at every launch, since the flag brings nothing", async () => {
  const m = machine({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
  const dir = project(m);
  const options = { env: m.env, launch: { state: "on" }, platform: "linux", claudeGhFor: () => true };
  for (let launch = 0; launch < 2; launch++) {
    const out = await hookOutput({ ...input(), cwd: dir }, options);
    assert.match(out.systemMessage, /where live CI events are not available, so this session's channel flag brings none; CI on request \(ci_status\) still works\.$/);
    assert.match(out.hookSpecificOutput.additionalContext, /\[degrades\] \(live_events\)/);
  }
});
