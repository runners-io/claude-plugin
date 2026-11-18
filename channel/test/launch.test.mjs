// Whether this Claude Code session opted the runners-io channel in, so the user can be told to relaunch
// with the flag when they launched without it. Read from the launching process's own flags.
import assert from "node:assert/strict";
import { test } from "node:test";

import { findLaunch, parseLaunch } from "../../hooks/launch.mjs";

test("the channel is on only when a channel flag names the runners-io plugin or server", () => {
  assert.equal(parseLaunch("claude --dangerously-load-development-channels plugin:runners-io@inline --resume abc").state, "on");
  assert.equal(parseLaunch("claude --channels plugin:runners-io@runners-io").state, "on");
  assert.equal(parseLaunch("claude --channels=plugin:runners-io@runners-io").state, "on");
  assert.equal(parseLaunch("claude --channels plugin:telegram@claude-plugins-official plugin:runners-io@acme").state, "on", "one flag, several entries");
  assert.equal(parseLaunch("claude --dangerously-load-development-channels server:runners-io").state, "on");
  assert.equal(parseLaunch("claude --dangerously-skip-permissions").state, "off");
  assert.equal(parseLaunch("claude --channels plugin:telegram@claude-plugins-official").state, "off");
  assert.equal(parseLaunch("claude --channels plugin:runners-io-evil@x").state, "off", "the plugin's name must match exactly");
  assert.equal(parseLaunch("claude --plugin-dir /x plugin:runners-io@inline").state, "off", "an entry without a channel flag is not an opt-in");
});

test("a headless run is headless whatever its flags: Claude Code ignores the channel flag with -p", () => {
  assert.equal(parseLaunch("claude -p hello").state, "headless");
  assert.equal(parseLaunch("claude --print --dangerously-load-development-channels plugin:runners-io@inline").state, "headless");
  assert.equal(parseLaunch("claude --output-format=stream-json --print x").state, "headless");
});

test("findLaunch walks up from a hook or the channel to the claude process, and is unknown when it cannot find one", () => {
  const table = {
    500: { ppid: 400, args: "node /plugins/runners-io/hooks/session-start.mjs" },
    400: { ppid: 300, args: "/bin/sh -c node session-start.mjs" },
    300: { ppid: 200, args: "claude --dangerously-load-development-channels plugin:runners-io@inline" },
    200: { ppid: 1, args: "/bin/zsh -l" },
    600: { ppid: 1, args: "/usr/bin/python3 something" },
    700: { ppid: 1, args: "/Users/me/.local/share/claude/versions/2.2.0 -p go" },
    800: { ppid: 1, args: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --channels plugin:runners-io@m" },
  };
  const ps = (pid) => table[pid] ?? null;
  assert.equal(findLaunch(400, ps).state, "on", "a hook's parent is the shell Claude Code ran it with");
  assert.equal(findLaunch(300, ps).state, "on", "the channel's parent is claude itself");
  assert.equal(findLaunch(600, ps).state, "unknown");
  assert.equal(findLaunch(700, ps).state, "headless", "the native binary under versions/");
  assert.equal(findLaunch(800, ps).state, "on", "the npm-installed CLI");
  assert.equal(findLaunch(999, ps).state, "unknown");
  assert.equal(findLaunch(500, ps).state, "unknown", "a node process in between means something else started us");
  assert.equal(findLaunch(500, () => {
    throw new Error("no ps on this system");
  }).state, "unknown");
});

test("only shells are walked through: a channel started by a test runner under a claude session is not that session", () => {
  const table = {
    20: { ppid: 19, args: "node /x/dist/runners-io-channel.mjs" },
    19: { ppid: 18, args: "node --test test/bundle.test.mjs" },
    18: { ppid: 17, args: "npm test" },
    17: { ppid: 16, args: "/bin/zsh -c npm test" },
    16: { ppid: 1, args: "claude --dangerously-skip-permissions" },
    30: { ppid: 31, args: "-zsh" },
    31: { ppid: 1, args: "claude --channels plugin:runners-io@m" },
  };
  const ps = (pid) => table[pid] ?? null;
  assert.equal(findLaunch(19, ps).state, "unknown");
  assert.equal(findLaunch(30, ps).state, "on", "a login shell's leading dash");
});

test("the channel polls only where its events can arrive: on, or unknown (where it cannot tell)", async () => {
  const { pollsIn } = await import("../../hooks/launch.mjs");
  assert.equal(pollsIn("on"), true);
  assert.equal(pollsIn("unknown"), true);
  assert.equal(pollsIn("off"), false);
  assert.equal(pollsIn("headless"), false, "claude -p ignores the channel flag, so a push goes nowhere");
});
