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

// From version 0.4.0 the plugin itself sends runners.io two kinds of message (hooks/telemetry.mjs). The README is the
// user's account of them: the address, every field by its name, what is never sent, how often, and how to turn it off.
test("'What is sent' lists the plugin's two messages to runners.io: every field, the limits, what is never sent and how to turn it off", async () => {
  const { INTERNAL_CODES, MAX_REPORTS_PER_DAY, TELEMETRY_URL, errorReport, installPing, telemetrySwitch } = await import("../../hooks/telemetry.mjs");
  const sent = section("What is sent");
  assert.doesNotMatch(readme, /sends nothing to runners\.io|\*\*To runners\.io, by the channel:\*\* nothing/, "the README still says nothing is sent");
  assert.ok(sent.includes(`\`${TELEMETRY_URL}\``), "the one address the messages go to");
  assert.match(sent, /from version 0\.4\.0/i);

  // The fields, read from what the plugin's own builders produce: a field added there must be named here.
  const id = "3f2a9c1e-0b7d-4c55-9a51-6c8e2f0d4b11";
  const ping = installPing({ installId: id, version: "0.4.1", previousVersion: "0.4.0", platform: "linux", nodeVersion: "22.1.0" });
  const fault = new TypeError("x");
  const root = "/plugin";
  fault.stack = `TypeError: x\n    at holdScope (file://${root}/channel/dist/runners-io-channel.mjs:2213:19)`;
  const report = errorReport(fault, { installId: id, version: "0.4.1", component: "channel", code: INTERNAL_CODES[0], root, platform: "linux", nodeVersion: "22.1.0" });
  assert.ok(ping && report, "the builders made both messages");
  const fields = [...new Set([...Object.keys(ping), ...Object.keys(report)])];
  assert.equal(fields.length, 11, `the plugin's messages hold ${fields.join(", ")}`);
  for (const field of fields) assert.ok(sent.includes(`\`${field}\``), `the README does not name the field ${field}`);
  assert.ok(sent.includes(`\`${report.frames[0]}\``), "an example of a frame, as one is sent");

  assert.match(sent, /once after the plugin is installed and once more when its version changes/);
  assert.match(sent, new RegExp(`at\\s+most ${MAX_REPORTS_PER_DAY} a day`));
  assert.match(sent, /never sends the error's message, a file path, your username, your machine's name/);
  assert.match(sent, /A failure that is not the plugin's own is not reported at all/);
  assert.match(sent, /IP address/);
  assert.match(sent, /no Sentry key/i);
  assert.match(sent, /https:\/\/www\.runners\.io\/privacy/);

  // How to turn it off: the two settings of its own, and Claude Code's two, each of which the plugin obeys.
  for (const [name, value] of [["RUNNERS_IO_TELEMETRY", "off"], ["DO_NOT_TRACK", "1"], ["DISABLE_TELEMETRY", "1"], ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"]]) {
    assert.ok(sent.includes(`\`${name}${name.startsWith("RUNNERS") || name === "DO_NOT_TRACK" ? `=${value}` : ""}\``), `the README does not name ${name}`);
    assert.equal(telemetrySwitch({ [name]: value }).on, false, `${name} does not turn it off`);
  }
  assert.match(section("Settings in the environment"), /\| `RUNNERS_IO_TELEMETRY` \| on \| `off`: the plugin sends runners\.io nothing/);
});
