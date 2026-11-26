#!/usr/bin/env node
// Checks the plugin's own promises, which `claude plugin validate` cannot know:
// the names a user types (`plugin:runners-io@runners-io`), the channel bound to
// a server that exists and no other server (nothing of runners.io's is installed), a bundle that is really there,
// a bundle that never declares the permission relay and offers only the four
// subscription tools, a channel that reads GitHub and names no runners.io API but its telemetry endpoint, and both
// hooks pointing at scripts that exist and run through the wrapper that says so when there is no Node.js. And one version: every field that names the plugin's version names the
// same one, and, with --against, a plugin that changed since <git ref> carries a newer version than it had there,
// because an installed copy is cached by its version and a release that keeps the old one is a release nobody can
// tell apart from the last.
//
//   node scripts/check-plugin.mjs [plugin-root] [--against <git ref>]
//
// Runs with no dependencies on Node 20 or later (and git, for --against). Exit 1 names every failure.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const failures = [];
let rootArg;
let against;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--against") {
    against = process.argv[++i];
    if (!against || against.startsWith("-")) failures.push("--against needs a git ref after it");
  } else if (a.startsWith("-")) failures.push(`unknown option ${a}`);
  else if (rootArg === undefined) rootArg = a;
  else failures.push(`more than one plugin root: ${rootArg} and ${a}`);
}
const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const check = (ok, what) => {
  if (!ok) failures.push(what);
};
const json = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const plugin = json(".claude-plugin/plugin.json");
const market = json(".claude-plugin/marketplace.json");

check(plugin.name === "runners-io", `plugin.json name is "${plugin.name}", not runners-io`);
check(market.name === "runners-io", `marketplace.json name is "${market.name}", not runners-io: the README's plugin:runners-io@runners-io would not resolve`);
const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
check(entry, "marketplace.json lists no plugin named like plugin.json");
check(entry?.source === "./", `the marketplace entry's source is ${JSON.stringify(entry?.source)}, not "./" (the repository root)`);
check(plugin.version && /^\d+\.\d+\.\d+$/.test(plugin.version), "plugin.json has no x.y.z version");

// ONE VERSION. plugin.json's is the one Claude Code installs and caches by; the others must say the same, or the
// channel reports one version in its log and `version` command while the plugin was installed as another. The
// channel's VERSION is a literal in its source (esbuild inlines it into the bundle, and CI requires the committed
// bundle to equal a fresh build), so the source is what is checked here.
const pkg = json("channel/package.json");
const lock = json("channel/package-lock.json");
const mainSrc = readFileSync(join(root, "channel/src/main.ts"), "utf8");
const mainVersion = mainSrc.match(/^export const VERSION = "([^"]*)";$/m)?.[1];
check(mainVersion !== undefined, 'channel/src/main.ts has no `export const VERSION = "x.y.z";` line');
const versions = [
  ...(entry && "version" in entry ? [["the marketplace entry's version", entry.version]] : []),
  ["channel/package.json version", pkg.version],
  ["channel/package-lock.json version", lock.version],
  ['channel/package-lock.json packages[""].version', lock.packages?.[""]?.version],
  ...(mainVersion !== undefined ? [["channel/src/main.ts VERSION", mainVersion]] : []),
];
for (const [field, v] of versions) {
  check(v === plugin.version, `${field} is ${v ?? "missing"}, not ${plugin.version} as in .claude-plugin/plugin.json: every version field must name the same version`);
}

// A RELEASE IS A NEW VERSION. With --against <ref>: when anything under the plugin differs from the ref (a tracked
// file changed, added or removed, or a new untracked file), plugin.json's version must be newer than at the ref.
// A ref git cannot resolve is a failure, never a pass: a shallow checkout that lacks the base would otherwise
// prove nothing.
if (against && !against.startsWith("-")) {
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const prefix = git("rev-parse", "--show-prefix");
  const base = git("rev-parse", "--verify", "--quiet", `${against}^{commit}`);
  if (prefix.status !== 0) {
    failures.push(`--against ${against}: ${root} is not in a git repository`);
  } else if (base.status !== 0) {
    failures.push(`--against ${against}: git cannot resolve ${against} to a commit here (in CI, a checkout deep enough to hold it, such as fetch-depth: 0)`);
  } else {
    const diff = git("diff", "--name-only", against, "--", ".");
    const untracked = git("ls-files", "--others", "--exclude-standard", "--", ".");
    if (diff.status !== 0 || untracked.status !== 0) {
      failures.push(`--against ${against}: git could not list what changed: ${(diff.stderr + untracked.stderr).trim()}`);
    } else {
      const changed = [...new Set(`${diff.stdout}${untracked.stdout}`.split("\n").filter(Boolean))].sort();
      const before = git("show", `${against}:${prefix.stdout.trim()}.claude-plugin/plugin.json`);
      // No plugin.json at the ref: the plugin is new there, so any version is a new one.
      const was = before.status === 0 ? JSON.parse(before.stdout).version : undefined;
      if (changed.length && was !== undefined) {
        const shown = changed.slice(0, 10).join(", ") + (changed.length > 10 ? `, and ${changed.length - 10} more` : "");
        check(
          newer(plugin.version, was),
          `${changed.length} file(s) under the plugin changed since ${against} (${shown}), but its version is ${plugin.version}, not newer than ${was} there: a release must be a new version, so raise every version field`,
        );
      }
    }
  }
}

// THE PLUGIN NEEDS NO runners.io ACCOUNT, so what it installs connects to nothing of runners.io's: the one server in
// the manifest is the channel, a local process. The runners.io MCP server is for runners.io customers, and the sign-in
// skill adds it with the user's yes; installed for everybody, every session of every user would connect to it.
const servers = plugin.mcpServers ?? {};
const others = Object.keys(servers).filter((name) => name !== "runners-io");
check(others.length === 0, `the manifest installs a server other than the channel: ${others.join(", ")}`);
check(!JSON.stringify(servers).includes("mcp.runners.io"), "the manifest names mcp.runners.io: the sign-in skill adds that server, with the user's yes");

const channels = plugin.channels ?? [];
check(channels.length === 1, `expected one channel, found ${channels.length}`);
const channel = channels[0] ?? {};
check(channel.server === "runners-io", `the channel binds to "${channel.server}", not runners-io (the <channel source> name)`);
const local = servers[channel.server];
check(local, `the channel's server "${channel.server}" is not in mcpServers`);
check(local?.command === "node", "the channel server is not started with node");
const arg = local?.args?.[0] ?? "";
check(arg.startsWith("${CLAUDE_PLUGIN_ROOT}/"), "the channel server's path does not start with ${CLAUDE_PLUGIN_ROOT}/");
const bundlePath = join(root, arg.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
check(existsSync(bundlePath), `the channel bundle ${bundlePath} does not exist`);
check(local?.env?.RUNNERS_IO_AUTO_SUBSCRIBE === "${user_config.auto_subscribe}", "the channel's env does not pass the auto_subscribe option as RUNNERS_IO_AUTO_SUBSCRIBE");
check(local?.env?.RUNNERS_IO_REVIEW_REQUESTS === "${user_config.review_requests}", "the channel's env does not pass the review_requests option as RUNNERS_IO_REVIEW_REQUESTS");
const requests = channel.userConfig?.review_requests;
check(JSON.stringify(requests?.options) === JSON.stringify(["off", "on"]) && requests?.default === "off", "the channel's review_requests option is not off|on with default off");
const auto = channel.userConfig?.auto_subscribe;
check(JSON.stringify(auto?.options) === JSON.stringify(["pr", "off"]) && auto?.default === "pr", "the channel's auto_subscribe option is not pr|off with default pr");
// The telemetry setting: one switch for the hooks and the channel. Claude Code hands a hook every saved plugin setting
// as CLAUDE_PLUGIN_OPTION_<NAME>; the channel gets it only if the manifest passes it, under the same name.
const telemetrySetting = plugin.userConfig?.telemetry;
check(
  telemetrySetting?.type === "string" && JSON.stringify(telemetrySetting?.options) === JSON.stringify(["on", "off"]) && telemetrySetting?.default === "on",
  "the manifest has no telemetry setting that is on|off with default on (userConfig.telemetry)",
);
check(local?.env?.CLAUDE_PLUGIN_OPTION_TELEMETRY === "${user_config.telemetry}", "the manifest does not pass the telemetry setting to the channel as CLAUDE_PLUGIN_OPTION_TELEMETRY");
for (const [k, v] of Object.entries(local?.env ?? {})) {
  check(!/token|secret|password/i.test(k) && !/token|secret/i.test(String(v)), `the channel's env carries something secret-shaped: ${k}`);
}

if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, "utf8");
  check(bundle.startsWith("#!/usr/bin/env node"), "the bundle has no node shebang");
  check(bundle.includes('"claude/channel"'), "the bundle does not declare claude/channel");
  // The permission relay would let a CI event approve a tool call. The string must not appear at all.
  check(!bundle.includes("claude/channel/permission"), "the bundle mentions claude/channel/permission");
  check(!/\bimport\s+[^;]*from\s+["'](?!node:)[^"']+["']/.test(bundle), "the bundle imports a package: it must be self-contained");
  for (const tool of ["subscribe", "unsubscribe", "list_subscriptions", "ci_status", "mute", "unmute"]) check(bundle.includes(`"${tool}"`), `the bundle does not offer the ${tool} tool`);
  check(!bundle.includes('"reply"'), "the bundle mentions a reply tool: the channel is one way");
  // The channel reads GitHub with the user's own login. The one runners.io address it may name is the telemetry
  // endpoint (hooks/telemetry.mjs: an install ping and reports of the plugin's own faults), written out in full, so
  // that no other runners.io API, and no address put together at run time, can pass.
  const TELEMETRY = "https://www.runners.io/api/plugin/telemetry";
  const apis = bundle.match(/[A-Za-z0-9.:/_-]*runners\.io\/api\/[A-Za-z0-9/_.-]*/g) ?? [];
  check(bundle.includes("api.github.com") && !bundle.includes("authorization_code"), "the bundle does not read GitHub directly");
  check(apis.every((a) => a === TELEMETRY), `the bundle names a runners.io API other than its telemetry endpoint: ${[...new Set(apis.filter((a) => a !== TELEMETRY))].join(", ")}`);
  check(bundle.includes(`TELEMETRY_URL = "${TELEMETRY}"`), "the bundle does not hold the telemetry endpoint as the one constant a message is sent to");
  // A Sentry key in a public plugin is a key anybody can post events against: reports go to runners.io only.
  check(!/sentry\.io|@sentry\/|\bdsn\b/i.test(bundle), "the bundle mentions Sentry or a DSN: fault reports go to runners.io's endpoint only");
  // Each way of turning telemetry off must be in the bundle that is shipped.
  for (const name of ["RUNNERS_IO_TELEMETRY", "DO_NOT_TRACK", "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_PLUGIN_OPTION_TELEMETRY"]) check(bundle.includes(name), `the bundle does not read ${name}, which turns telemetry off`);
  // The doctor skill runs the bundle's `status`, which must print the setup checks.
  check(bundle.includes("setup checks (/runners-io:doctor):"), "the bundle's status command does not print the setup checks");
}

const hooksFile = join(root, "hooks", "hooks.json");
check(existsSync(hooksFile), "hooks/hooks.json is missing: nothing prompts Claude to subscribe to a PR it opens");
if (existsSync(hooksFile)) {
  const post = JSON.parse(readFileSync(hooksFile, "utf8")).hooks?.PostToolUse ?? [];
  const cmds = post.flatMap((h) => (h.hooks ?? []).map((x) => ({ matcher: h.matcher ?? "", command: x.command ?? "" })));
  const pr = cmds.find((c) => c.command.includes("${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs"));
  check(pr, "no PostToolUse hook runs ${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs");
  check(pr && /Bash/.test(pr.matcher), "the PR hook does not match Bash, where gh pr create runs");
  // A matcher is a regular expression tested anywhere in the tool's name: unanchored, it also fires for every tool
  // whose name only contains one of these.
  check(pr && pr.matcher.startsWith("^(") && pr.matcher.endsWith(")$"), "the PR hook's matcher is not anchored (^(...)$), so it fires for any tool whose name contains a match");
  check(existsSync(join(root, "hooks", "pr-created.mjs")), "hooks/pr-created.mjs does not exist");
  // The launch hook: it says what the machine is missing (hooks/readiness.mjs), which the channel cannot do in a
  // session started without its flag. Both hooks go through hooks/node.sh, or a machine with no Node.js hears nothing.
  const starts = (JSON.parse(readFileSync(hooksFile, "utf8")).hooks?.SessionStart ?? []).flatMap((h) => (h.hooks ?? []).map((x) => x.command ?? ""));
  const wrapper = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/node.sh" ';
  check(starts.some((c) => c === `${wrapper}session-start "\${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"`), "no SessionStart hook runs hooks/session-start.mjs through hooks/node.sh as session-start");
  check(pr && pr.command === `${wrapper}quiet "\${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs"`, "the PR hook does not run through hooks/node.sh as quiet");
  for (const name of ["node.sh", "session-start.mjs", "readiness.mjs", "proxy.mjs", "launch.mjs", "telemetry.mjs", "programs.mjs"]) check(existsSync(join(root, "hooks", name)), `hooks/${name} does not exist`);
}

const skills = join(root, "skills");
for (const name of readdirSync(skills)) {
  const file = join(skills, name, "SKILL.md");
  check(existsSync(file), `skills/${name} has no SKILL.md`);
  if (existsSync(file)) check(/^---\n(?:.*\n)*?description: .{20,}\n(?:.*\n)*?---\n/.test(readFileSync(file, "utf8")), `skills/${name}/SKILL.md has no description`);
}
for (const name of ["fix-failing-ci", "watch-this-pr", "sign-in", "setup-github", "doctor"]) check(existsSync(join(skills, name, "SKILL.md")), `the ${name} skill is missing`);

/** True when x.y.z version `now` is greater than `was`, comparing each part as a number (1.10.0 > 1.2.3). */
function newer(now, was) {
  const parts = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v.split(".").map(Number) : undefined);
  const a = parts(now);
  const b = parts(was);
  if (!a || !b) return a !== undefined && now !== was;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

if (failures.length) {
  console.error(`check-plugin: ${failures.length} problem(s):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`check-plugin: ${root} is consistent (plugin ${plugin.name} ${plugin.version}, channel ${channel.server}${against ? `, a new version since ${against} or no change` : ""})`);
