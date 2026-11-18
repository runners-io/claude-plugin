// The README is the user's only account of what installing this plugin does. Two things a reviewer found missing:
// that every install connects to the runners.io MCP server (and that it has write tools, off by default), and what the
// development-channels flag actually risks, including for later updates.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");

/** The text of one `## ` section, by its heading's start. */
function section(start) {
  const at = readme.indexOf(`\n## ${start}`);
  assert.ok(at >= 0, `no section "## ${start}"`);
  const next = readme.indexOf("\n## ", at + 4);
  return readme.slice(at, next < 0 ? undefined : next);
}

test("'What is sent' says every install connects to mcp.runners.io when a session starts, and what that sends", () => {
  const sent = section("What is sent");
  assert.match(sent, /mcp\.runners\.io/);
  assert.match(sent, /when (a|each) session starts/i);
  assert.match(sent, /before you sign in|without signing in|not signed in/i, "what it sends before sign-in");
  assert.match(sent, /disable|turn (it )?off|remove/i, "how to stop it");
});

test("'What is sent' says the MCP server has write tools, and that they do nothing unless switched on", () => {
  const sent = section("What is sent");
  assert.match(sent, /cancel_job/);
  assert.match(sent, /delete_cache_entry/);
  assert.match(sent, /organisation/i);
  assert.match(sent, /confirm/);
});

test("the development-channels flag's risk is said plainly, including that it covers later updates", () => {
  const sec = section("Security");
  const at = sec.indexOf("development-channels flag");
  assert.ok(at >= 0);
  const para = sec.slice(at, sec.indexOf("\n\n**", at + 1) > 0 ? sec.indexOf("\n\n**", at + 1) : undefined);
  assert.match(para, /not reviewed|no review|has not reviewed/i);
  assert.match(para, /later update|future update|every update/i);
  assert.match(para, /Pinned install/);
});

test("choosing 'local development' at the warning is explained, not just instructed", () => {
  const at = readme.indexOf("I am using this for local development");
  assert.ok(at >= 0);
  const sentence = readme.slice(at, readme.indexOf("\n\n", at));
  assert.match(sentence, /because|since|that is how|this means/i);
});
