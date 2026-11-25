// hooks/node.sh: the shell wrapper every hook command goes through, so a machine with no Node.js (or one too old) is
// told so at launch instead of failing where nobody looks. Run as Claude Code runs it: `sh node.sh <kind> <script>`,
// with a PATH that holds only what the case allows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
const WRAPPER = join(HOOKS, "node.sh");
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A PATH folder holding the named fakes: `node` (a script, or "real" for this Node) and `ps` (what it prints). */
function path({ node, ps } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rio-wrapper-"));
  roots.push(dir);
  if (node === "real") symlinkSync(process.execPath, join(dir, "node"));
  else if (node) {
    writeFileSync(join(dir, "node"), `#!/bin/sh\n${node}\n`);
    chmodSync(join(dir, "node"), 0o755);
  }
  if (ps !== undefined) {
    writeFileSync(join(dir, "ps"), `#!/bin/sh\necho '${ps}'\n`);
    chmodSync(join(dir, "ps"), 0o755);
  }
  return dir;
}

function wrapper(kind, dir, { script = join(dir, "hook.mjs"), env = {}, input = "" } = {}) {
  return spawnSync("/bin/sh", [WRAPPER, kind, script], { env: { PATH: dir, ...env }, input, encoding: "utf8", timeout: 10_000 });
}

test("no Node.js on PATH at launch: valid SessionStart JSON with one line for the user and the install pointers for Claude, exit 0", () => {
  const r = wrapper("session-start", path());
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.systemMessage, "runners.io: the plugin needs Node.js 20 or later and it isn't installed, so it can't run. Ask me to help you install it.");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const c = out.hookSpecificOutput.additionalContext;
  assert.match(c, /ask first/);
  assert.match(c, /brew install node/);
  assert.match(c, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(c, /nvm/);
  assert.match(c, /sudo or an administrator prompt is the user's to run.*`! <command>`/);
  assert.match(c, /restarted/);
});

test("a Node.js older than 20: the line names the version found, and the hook's script is not run", () => {
  const dir = path({ node: 'if [ "$1" = -p ]; then echo 18; else echo "the script ran"; fi' });
  const r = wrapper("session-start", dir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /needs Node\.js 20 or later and this machine has Node\.js 18, so it can't run/);
  assert.equal(r.stdout.includes("the script ran"), false);
});

test("a node that cannot say its version counts as too old, never as a pass", () => {
  const r = wrapper("session-start", path({ node: 'if [ "$1" = -p ]; then echo "v??"; exit 1; fi; echo "the script ran"' }));
  assert.match(JSON.parse(r.stdout).systemMessage, /this machine has Node\.js 0/);
});

test("Node.js 20 or later: the hook's script runs with its input, and the wrapper adds nothing", () => {
  const dir = path({ node: "real" });
  writeFileSync(join(dir, "hook.mjs"), 'let d = ""; process.stdin.on("data", (x) => (d += x)).on("end", () => process.stdout.write(`got:${d}`));\n');
  const r = wrapper("session-start", dir, { input: '{"source":"startup"}' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'got:{"source":"startup"}');
  const quiet = wrapper("quiet", dir, { input: "x" });
  assert.equal(quiet.stdout, "got:x");
});

test("after a tool call (quiet) with no Node.js: exit 0 and not a word", () => {
  const r = wrapper("quiet", path());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("silent in a headless run: a claude -p parent gets nothing, an interactive one gets the line", () => {
  for (const args of ["claude -p hello", "/Users/me/.local/bin/claude --print --model x", "node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js -p"]) {
    const r = wrapper("session-start", path({ ps: `1 ${args}` }));
    assert.equal(r.status, 0, args);
    assert.equal(r.stdout, "", args);
  }
  const person = wrapper("session-start", path({ ps: "1 claude --resume abc" }));
  assert.match(JSON.parse(person.stdout).systemMessage, /Node\.js/);
});

test("RUNNERS_IO_NO_SETUP_CHECKS=1: the one line still shows, with no offer for Claude to make", () => {
  const r = wrapper("session-start", path(), { env: { RUNNERS_IO_NO_SETUP_CHECKS: "1" } });
  const out = JSON.parse(r.stdout);
  assert.match(out.systemMessage, /Node\.js 20 or later/);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("hooks.json runs both hooks through the wrapper: the launch hook as session-start, the tool hook as quiet", () => {
  const hooks = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8")).hooks;
  const command = (event) => hooks[event][0].hooks[0].command;
  assert.equal(command("SessionStart"), 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/node.sh" session-start "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
  assert.equal(command("PostToolUse"), 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/node.sh" quiet "${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs"');
});

test("the hook commands as written in hooks.json run from a plugin folder with a space in its path", () => {
  const dir = path({ node: "real" });
  const plugin = join(dir, "my plugins", "runners-io");
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  writeFileSync(join(plugin, "hooks", "node.sh"), readFileSync(WRAPPER));
  writeFileSync(join(plugin, "hooks", "session-start.mjs"), 'process.stdout.write("ran");\n');
  const command = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command;
  const r = spawnSync("/bin/sh", ["-c", command], { env: { PATH: `${dir}:/bin:/usr/bin`, CLAUDE_PLUGIN_ROOT: plugin }, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ran");
});
