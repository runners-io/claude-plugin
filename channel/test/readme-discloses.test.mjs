// The README is the user's only account of what installing this plugin does. Each test here holds one thing a reader
// relies on to the code or the manifest: that nothing of runners.io's is installed and no account is needed, what the
// development-channels flag risks, every read from GitHub, every file written, and the whole of the telemetry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const flat = readme.replace(/\s+/g, " ");

/** The text of one `## ` section, by its heading's start. */
function section(start) {
  const at = readme.indexOf(`\n## ${start}`);
  assert.ok(at >= 0, `no section "## ${start}"`);
  const next = readme.indexOf("\n## ", at + 4);
  return readme.slice(at, next < 0 ? undefined : next);
}

// The plugin installs no server of runners.io's, so no session connects to runners.io unasked. The MCP server is an
// extra for customers, added by one command after a yes. The README says so, and nowhere says the opposite.
test("the README says no runners.io account is needed, up front, and that the plugin does not install the MCP server", () => {
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.mcpServers), ["runners-io"], "the manifest installs the channel only");
  const top = readme.slice(0, readme.indexOf("\n## Install"));
  assert.match(top, /\*\*No runners\.io account is needed\.\*\*/);
  assert.match(top, /any repository\s+that uses GitHub Actions/);
  const optional = section("For runners.io customers: the MCP server (optional)");
  assert.match(optional, /\*\*The plugin does not install it, and nothing above needs it\.\*\*/);
  assert.ok(optional.includes("\nclaude mcp add --transport http --scope user runnersio https://mcp.runners.io/mcp\n"), "the one command that adds it");
  assert.match(optional, /only with your yes/);
  assert.match(optional, /at the start of every session/, "what adding it means: a connection at every session start");
  assert.match(optional, /claude mcp remove runnersio --scope user/, "and how to take it out");
  assert.match(optional, /`runners-io-mcp`[\s\S]*sign\s+in once more/, "a customer updating from 0.4.1 is told how to get it back");
  for (const stale of [/the MCP server the plugin also installs/i, /plugin bundles four things/i, /whether or not you use runners\.io\. Before you sign in/i, /turn it off in `\/mcp` \(the server is `runners-io-mcp`\)/i])
    assert.doesNotMatch(flat, stale, "the README still describes the bundled server");
});

test("the optional MCP server's write tools are named, and that they do nothing unless switched on", () => {
  const optional = section("For runners.io customers: the MCP server (optional)");
  assert.match(optional, /cancel_job/);
  assert.match(optional, /delete_cache_entry/);
  assert.match(optional, /organisation/i);
  assert.match(optional, /confirm/);
});

// The badge the open-source programme asks of a project: its image, linked to runners.io, in the title block. The rule
// is the first 40 lines or before the second heading; this README does both.
test("the title block carries the runners.io badge with its link, a CI badge, the release and the licence, before the second heading", () => {
  const BADGE = "[![Runs on runners.io](https://www.runners.io/badge/oss.svg)](https://www.runners.io/?utm_source=github&utm_medium=badge&utm_campaign=oss_badge)";
  const lines = readme.split("\n");
  const at = lines.indexOf(BADGE);
  assert.ok(at >= 0 && at < 40, `the badge is on line ${at + 1}`);
  const headings = lines.flatMap((l, i) => (/^#{1,6} |<h[1-6]\b/.test(l) ? [i] : []));
  assert.ok(headings.length >= 2 && at < headings[1], "before the second heading");
  const block = lines.slice(0, headings[1]).join("\n");
  assert.ok(block.includes("https://github.com/runners-io/claude-plugin/actions/workflows/ci.yml/badge.svg"), "the repository's CI status");
  assert.match(block, /img\.shields\.io\/github\/v\/release\/runners-io\/claude-plugin/);
  assert.match(block, /licence-MIT/);
  for (const link of ["(#install)", "(#what-it-does)", "(#telemetry)", "(#security)", "(https://www.runners.io/claude-code)"]) assert.ok(block.includes(link), link);
  // Every in-page link in the README lands on a heading that exists.
  const anchors = new Set(lines.filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, "").toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")));
  for (const m of readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(anchors.has(m[1]), `#${m[1]} names no heading`);
  // And both logo files it draws are there.
  for (const m of block.matchAll(/(?:src|srcset)="(assets\/[^"]+)"/g)) assert.ok(readFileSync(join(root, m[1])).length > 0, m[1]);
});

// What works with no flag comes first; the development flag is presented as what it is.
test("the README leads with what works without the channel flag, and calls the flag an opt-in to a research preview", () => {
  const does = section("What it does");
  const without = does.indexOf("### Without any flag");
  const withFlag = does.indexOf("### With live events");
  assert.ok(without >= 0 && withFlag > without, "what needs no flag is said first");
  assert.match(does.slice(without, withFlag), /`ci_status`/);
  assert.match(does.slice(withFlag), /research preview/);
  assert.match(does.slice(withFlag), /Anthropic has not reviewed this channel/);
});

// A failure is offered, not fixed: the README's account and its example are the channel's own words.
test("the README says Claude asks before fixing a failure, and its example event is what the channel sends", async () => {
  const { toMessage } = await import("../src/format.ts");
  const does = section("What it does");
  assert.match(does, /\*\*A failure is never fixed unasked\.\*\*/);
  assert.match(does, /starts only with your consent/);
  assert.doesNotMatch(flat, /fix it without being asked|skill now to fix the cause/);
  const run = { id: 4242, name: "CI", status: "completed", conclusion: "failure", htmlUrl: "https://github.com/acme/widgets/actions/runs/4242", runAttempt: 1, event: "pull_request", triggeringActor: "octocat" };
  const snapshot = { repo: "acme/widgets", pr: 123, state: "open", headSha: "3f2a9c1e0b7d4c559a516c8e2f0d4b1100000000", headRef: "fix-login", mergeableState: "clean", prUrl: "https://github.com/acme/widgets/pull/123", runs: [run], author: "octocat", headRepo: "acme/widgets" };
  const sent = toMessage({ kind: "ci.workflow_failed", snapshot, run, failedJobs: ["lint", "test-unit"] }, "octocat").content;
  assert.ok(readme.includes(`\n${sent}\n`), `the example is not what the channel sends:\n${sent}`);
});

// Every file the plugin writes is in one table.
test("'What it writes' lists every file the plugin writes, and where the three folders are", () => {
  const writes = section("What it writes");
  for (const file of [
    "requests/<Claude Code's process id>/<hash>.json",
    "claude-gh.json",
    "claude-gh-declined.json",
    "setup-checks.json",
    "first-call.json",
    "telemetry/install-id",
    "telemetry/ping-<version>",
    "telemetry/fault-<day>-<version>-<fingerprint>",
    "telemetry/slot-<day>-<n>",
    "telemetry/gone-<version>",
    "scopes/<hash of the project folder>.json",
    ".writable-<process id>",
    "<rc file>.before-runners-io",
    "runners-io-events/<UTC date>.jsonl",
  ]) assert.ok(writes.includes(`\`${file}\``), `the table leaves out ${file}`);
  assert.match(writes, /# >>> runners\.io claude channel >>>/);
  assert.match(writes, /410 Gone/);
  for (const folder of ["`~/.cache/runners-io`", "`$XDG_CACHE_HOME/runners-io`", "`~/.local/state/runners-io`", "`$XDG_STATE_HOME/runners-io`", "`CLAUDE_PLUGIN_DATA`"]) assert.ok(writes.includes(folder), folder);
  // The names are the code's own.
  const sources = ["hooks/telemetry.mjs", "hooks/readiness.mjs", "skills/setup-github/claude-gh.mjs", "hooks/pr-created.mjs", "channel/src/scopes.ts"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  for (const name of ["install-id", "ping-", "gone-", "fault-", "slot-", "claude-gh.json", "claude-gh-declined.json", "setup-checks.json", "first-call.json", ".writable-", ".before-runners-io", '"requests"', '"scopes"']) assert.ok(sources.includes(name), `the code no longer writes ${name}`);
});

// The hook that runs after every Bash call: said plainly, with what it reads and that it sends nothing.
test("the README says the hook runs after every Bash call, reads the output for pull-request links only, and sends nothing", () => {
  const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
  assert.match(hooks.hooks.PostToolUse[0].matcher, /Bash/);
  assert.match(flat, /\*\*After every Bash call, and after a `create_pull_request` tool of an MCP server, a hook of the plugin's runs\.\*\*/);
  assert.match(flat, /reads it for one thing, links to pull requests on github\.com, and sends nothing anywhere: it makes no network request/);
  const hook = readFileSync(join(root, "hooks", "pr-created.mjs"), "utf8");
  assert.doesNotMatch(hook, /\bfetch\(|node:https?|node:net/, "the hook makes a network request after all");
});

test("the licence section ties the copyright holder to runners.io, and Development gives the verify-the-bundle recipe", () => {
  const licence = section("Licence");
  const holder = /Copyright \(c\) \d{4}(?:-\d{4})? (.+)/.exec(readFileSync(join(root, "LICENSE"), "utf8"))?.[1]?.trim();
  assert.ok(holder, "the LICENSE names a copyright holder");
  assert.ok(licence.includes(holder), `the README does not name ${holder}`);
  assert.match(licence, /runs \[runners\.io\]\(https:\/\/www\.runners\.io\)/);
  const dev = section("Development");
  assert.ok(dev.includes("\nnpm ci --ignore-scripts && npm run build && git diff --exit-code dist/\n"), "the recipe, on a line of its own");
  assert.doesNotMatch(dev, /\bnpm ci\n/, "an npm ci that would run install scripts");
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
test("'Telemetry' lists the plugin's two messages to runners.io: every field, the limits, what is never sent and how to turn it off", async () => {
  const { INTERNAL_CODES, MAX_BODY_BYTES, MAX_FRAMES, MAX_REPORTS_PER_DAY, SEND_TIMEOUT_MS, SETTING_ENV, TELEMETRY_URL, errorReport, installPing, telemetryLine, telemetrySwitch } = await import("../../hooks/telemetry.mjs");
  const sent = section("Telemetry");
  assert.doesNotMatch(readme, /sends nothing to runners\.io|\*\*To runners\.io, by the channel:\*\* nothing/, "the README still says nothing is sent");
  assert.ok(sent.includes(`\`${TELEMETRY_URL}\``), "the one address the messages go to");
  assert.match(sent, /from version 0\.4\.0/i);

  // The fields, read from what the plugin's own builders produce: a field added there must be named here.
  const id = "3f2a9c1e-0b7d-4c55-9a51-6c8e2f0d4b11";
  const ping = installPing({ installId: id, version: "0.4.1", previousVersion: "0.4.0", platform: "linux", nodeVersion: "22.1.0" });
  const fault = new TypeError("x");
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

  // The plugin's own setting: in the manifest, in the section with what Claude Code saves, and obeyed by the switch.
  const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(manifest.userConfig.telemetry.options, ["on", "off"]);
  assert.equal(manifest.userConfig.telemetry.default, "on");
  assert.ok(sent.includes('"runners-io@runners-io": { "options": { "telemetry": "off" } }'), "the setting as it is saved");
  assert.equal(telemetrySwitch({ [SETTING_ENV]: "off" }).on, false);
  assert.ok(sent.includes(`\`${telemetryLine({ [SETTING_ENV]: "off" })}\``), "the doctor's line for the setting, word for word");
  assert.match(sent, /\*\*On by default\. One setting turns it off\.\*\*/);
  assert.match(sent, /no notice at first launch/);

  // The limits, as the code holds them.
  assert.equal(MAX_BODY_BYTES, 1024);
  assert.match(sent, /Under 1 KB/);
  assert.equal(SEND_TIMEOUT_MS, 2000);
  assert.match(sent, /\| \*\*Time limit\*\* \| 2 seconds/);
  assert.match(sent, /\| \*\*Retried\*\* \| Never/);
  assert.match(sent, new RegExp(`up to ${MAX_FRAMES} lines`));
  assert.match(sent, /redirect is never followed/i);

  // The two example messages are what the builders make: the same fields, in the same order, with the same values.
  const examples = [...sent.matchAll(/```json\n(\{\n {2}"kind"[\s\S]*?\n\})\n```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(examples.length, 2, "one example of each message");
  const [examplePing, exampleReport] = examples;
  assert.deepEqual(
    JSON.stringify(installPing({ installId: examplePing.install_id, version: examplePing.version, previousVersion: examplePing.previous_version, platform: examplePing.os, nodeVersion: `${examplePing.node_major}.11.0` })),
    JSON.stringify(examplePing),
  );
  const shown = new TypeError("x");
  shown.stack = `TypeError: x\n    at holdScope (file://${root}/channel/dist/runners-io-channel.mjs:2213:19)\n    at async Poller.tick (file://${root}/channel/dist/runners-io-channel.mjs:3050:7)\n    at node:internal/timers:500:1`;
  const built = errorReport(shown, { installId: exampleReport.install_id, version: exampleReport.version, component: exampleReport.component, root, platform: exampleReport.os, nodeVersion: `${exampleReport.node_major}.11.0` });
  assert.deepEqual(JSON.stringify(built), JSON.stringify(exampleReport));
  assert.equal(examplePing.version, manifest.version, "the examples name this release");

  // The install ID is described as what it is: random, made here, stable, and arriving with an IP address.
  const idPart = sent.slice(sent.indexOf("### The install ID, honestly"), sent.indexOf("### Turning it off"));
  assert.match(idPart, /random UUID/);
  assert.match(idPart, /\*\*It stays the same\*\*/);
  assert.match(idPart, /\*\*it arrives with your IP address\*\*/);
  assert.match(idPart, /deleted after 13 months/);
  assert.match(idPart, /for as long as runners\.io\s+supports the plugin/);
  assert.doesNotMatch(sent, /tied to nothing/, "an ID that arrives with an IP address is not tied to nothing");
});
