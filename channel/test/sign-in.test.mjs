// The plugin works with no runners.io account. The runners.io MCP server is an extra for runners.io customers, which
// the sign-in skill adds only with the user's yes. These hold the skill, and every other text a user reads, to that.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const skill = read("skills", "sign-in", "SKILL.md");
const flat = skill.replace(/\s+/g, " ");

/** The command that adds the server, as Claude Code's own `claude mcp add --help` gives its shape. */
const ADD = "claude mcp add --transport http --scope user runnersio https://mcp.runners.io/mcp";

test("the manifest installs no runners.io server: only the channel, a local process", () => {
  const manifest = JSON.parse(read(".claude-plugin", "plugin.json"));
  assert.deepEqual(Object.keys(manifest.mcpServers), ["runners-io"]);
  assert.equal(manifest.mcpServers["runners-io"].command, "node");
  assert.doesNotMatch(JSON.stringify(manifest), /mcp\.runners\.io/);
});

test("the sign-in skill adds the server with one exact command, and only after the user says yes", () => {
  assert.ok(skill.includes(`\n${ADD}\n`), "the command, on a line of its own");
  const ask = flat.indexOf("Ask the user");
  const run = flat.indexOf(ADD);
  assert.ok(ask >= 0 && ask < run, "the question comes before the command");
  assert.match(flat, /Run it only if the user says yes/);
  // What the yes is to: an entry in the user's own Claude Code configuration, and a connection at every session start.
  assert.match(flat, /user configuration/);
  assert.match(flat, /connects to (it|`?https:\/\/mcp\.runners\.io\/mcp`?) (at the start of|when) (every|each|a) session/);
  // And how to take it out again.
  assert.ok(skill.includes("claude mcp remove runnersio --scope user"));
});

test("the sign-in skill tells a customer whose server went away with the update how to get it back", () => {
  assert.match(flat, /Up to version 0\.4\.1 the plugin installed this server itself, as `runners-io-mcp`/);
  assert.match(flat, /From 0\.4\.2 it does not/);
  assert.match(flat, /sign in again/i);
});

test("the sign-in skill says the plugin needs no runners.io account, and never sends a user to make one for CI", () => {
  assert.match(flat, /needs no runners\.io account/);
  assert.match(skill, /^description: .*(optional|only for runners\.io customers)/im);
  assert.doesNotMatch(flat, /Create an account at[^.]*first/);
  assert.doesNotMatch(flat, /signing in needs one/);
  // The one line for somebody who is not a customer says first that nothing needs an account, then where one is made.
  const line = skill.split("\n").filter((l) => /not a runners\.io customer yet/i.test(l));
  assert.equal(line.length, 1);
  assert.match(line[0], /Nothing in the plugin needs an account, so never tell the user to make one for it; .*https:\/\/www\.runners\.io\/signup/);
});

test("no skill, and neither manifest, says the plugin brings or bundles the runners.io MCP server", () => {
  const texts = [
    [".claude-plugin/plugin.json", read(".claude-plugin", "plugin.json")],
    [".claude-plugin/marketplace.json", read(".claude-plugin", "marketplace.json")],
    ...readdirSync(join(root, "skills")).map((name) => [`skills/${name}/SKILL.md`, read("skills", name, "SKILL.md")]),
  ];
  assert.ok(texts.length >= 7);
  for (const [where, text] of texts) {
    assert.doesNotMatch(text, /plus the runners\.io MCP server|bundles? the runners\.io MCP server|also (installs|brings)[^.]*MCP server/i, where);
    // A skill may point at the server's tools only as something a customer may have added.
    if (where !== "skills/sign-in/SKILL.md") assert.doesNotMatch(text, /`runners-io-mcp`/, where);
  }
});
