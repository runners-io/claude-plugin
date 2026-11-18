// Whether this Claude Code session opted the runners-io channel in, so the user can be told to relaunch
// with the flag when they launched without it. Read from the launching process's own flags.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { channelFlags, findLaunch, parseLaunch, shellWord } from "../../hooks/launch.mjs";

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

test("flags are read only up to the prompt: words in it are not flags", () => {
  // ps loses the quotes, so `claude "explain the -p flag"` reads as these words.
  assert.equal(parseLaunch("claude explain the -p flag").state, "off");
  assert.equal(parseLaunch("claude --model opus explain the --print option").state, "off", "a flag's value, then the prompt");
  assert.equal(parseLaunch("claude fix it --channels plugin:runners-io@runners-io").state, "off", "a prompt naming the flag is no opt-in");
  assert.equal(parseLaunch("claude -- -p").state, "off", "nothing after -- is a flag");
  assert.equal(parseLaunch("claude --resume abc -p").state, "headless", "a value, then more flags");
  assert.equal(parseLaunch("claude --channels plugin:telegram@x plugin:runners-io@acme --resume abc").state, "on");
  assert.equal(
    parseLaunch("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --channels plugin:runners-io@acme").state,
    "on",
    "started through node: the script path is not the prompt",
  );
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

test("shellWord quotes for the shell that reads it: fish escapes a backslash and a quote inside single quotes", () => {
  assert.equal(shellWord("/plain/path"), "/plain/path");
  assert.equal(shellWord("/plain/path", "fish"), "/plain/path");
  assert.equal(shellWord("a b'c"), "'a b'\\''c'");
  assert.equal(shellWord("a b'c\\d", "fish"), "'a b\\'c\\\\d'");
  const block = channelFlags("/x/it's here\\", "fish");
  assert.ok(block.includes("'/x/it\\'s here\\\\'"), block.join(" "));
});

const TRICKY = ["a b", "it's", "back\\slash", "ends\\", "$HOME", "*", "(x)", "a\\'b", "semi;colon"];
for (const [shell, exe] of [["posix", "/bin/sh"], ["fish", lookup("fish")]]) {
  test(`a real ${shell} shell reads each quoted word back unchanged`, { skip: exe && existsSync(exe) ? false : `no ${shell} shell here` }, () => {
    for (const word of TRICKY) {
      const r = spawnSync(exe, ["-c", `printf %s ${shellWord(word, shell)}`], { encoding: "utf8" });
      assert.equal(r.stdout, word, `${shell}: ${word} -> ${shellWord(word, shell)} (${r.stderr})`);
    }
  });
}

function lookup(name) {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
