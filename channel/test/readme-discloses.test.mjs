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

// The default install follows main, so every later push reaches the user, together with the development flag. The
// install the README leads with is the one that installs exactly a release the user has read.
test("Install leads with the pinned install: the first command names a release tag", () => {
  const install = section("Install");
  const first = /claude plugin marketplace add (\S+)/.exec(install);
  assert.ok(first, "an install command");
  assert.match(first[1], /^runners-io\/claude-plugin#v\d+\.\d+\.\d+$/, `the first install is ${first[1]}`);
  assert.match(install, /follows? `main`/, "the unpinned install is still offered, and says what it follows");
});

// GH_ENTERPRISE_TOKEN names no host, and the tests' switch is an environment variable anyone setting the environment
// can set. The README says what each does with a token.
test("Security says an Enterprise token goes only to GH_HOST, and what the tests' switch does with a token", () => {
  const security = section("Security");
  assert.match(security, /GH_ENTERPRISE_TOKEN[^.]*only when `GH_HOST`/);
  assert.match(security, /RUNNERS_IO_TEST_FAKE_GITHUB/);
  assert.match(security, /RUNNERS_IO_TEST_GITHUB_TOKEN/);
});

// The list of what the channel reads from GitHub is the user's account of what their login is used for: every read.
test("'What is sent' names every read the channel makes from GitHub", () => {
  const sent = section("What is sent");
  const para = sent.slice(sent.indexOf("**From your machine to GitHub"), sent.indexOf("\n\n", sent.indexOf("**From your machine to GitHub")));
  for (const [what, pattern] of [
    ["the signed-in login (/user)", /`\/user`/],
    ["the branch's open pull request", /open pull request for (the|your) (current )?branch/i],
    ["jobs of runs that have not finished", /jobs of (each|every|a) (workflow )?run that has not finished/i],
    ["a failed job's annotations", /annotations/i],
    ["the base branch's runs", /base branch/i],
    ["reviews through GraphQL", /GraphQL[^.]*review|review[^.]*GraphQL/i],
    ["review requests, when on", /review requests?/i],
  ]) assert.match(para, pattern, what);
  assert.match(para, /Nothing is written to GitHub/);
});

// claude-gh.mjs asks bash twice (a login bash reads .bashrc only when told to), and the stop on its background work
// reaches only the shell's own process group.
test("Security says how often the shell is started, and that only its own process group is stopped", () => {
  const sec = section("Security");
  const at = sec.indexOf("**What the plugin runs on your machine.**");
  assert.ok(at >= 0);
  const para = sec.slice(at, sec.indexOf("\n\n", at));
  assert.doesNotMatch(para, /\bonce at the start of a session\b/, "bash is started twice, not once");
  assert.match(para, /bash[^.]*(twice|second time)/i);
  assert.match(para, /process group/);
  assert.doesNotMatch(para, /whatever it started in the background is stopped/, "not whatever: only the group");
});
