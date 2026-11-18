#!/usr/bin/env node
// Checks the plugin's own promises, which `claude plugin validate` cannot know:
// the names a user types (`plugin:runners-io@runners-io`), the channel bound to
// a server that exists, the remote MCP address, a bundle that is really there,
// a bundle that never declares the permission relay and offers only the four
// subscription tools, a channel that reads GitHub and not runners.io, and the
// PR hook pointing at a script that exists.
//
//   node scripts/check-plugin.mjs [plugin-root]
//
// Runs with no dependencies on Node 20 or later. Exit 1 names every failure.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const failures = [];
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

const servers = plugin.mcpServers ?? {};
const remote = servers["runners-io-mcp"];
check(remote?.type === "http" && remote?.url === "https://mcp.runners.io/mcp", "the remote MCP server is not https://mcp.runners.io/mcp over http");

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
const auto = channel.userConfig?.auto_subscribe;
check(JSON.stringify(auto?.options) === JSON.stringify(["pr", "off"]) && auto?.default === "pr", "the channel's auto_subscribe option is not pr|off with default pr");
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
  for (const tool of ["subscribe", "unsubscribe", "list_subscriptions", "ci_status"]) check(bundle.includes(`"${tool}"`), `the bundle does not offer the ${tool} tool`);
  check(!bundle.includes('"reply"'), "the bundle mentions a reply tool: the channel is one way");
  // The channel reads GitHub with the user's own login, and calls no runners.io API.
  check(bundle.includes("api.github.com") && !bundle.includes("authorization_code") && !/runners\.io\/api\//.test(bundle), "the bundle does not read GitHub directly, or calls a runners.io API");
}

const hooksFile = join(root, "hooks", "hooks.json");
check(existsSync(hooksFile), "hooks/hooks.json is missing: nothing prompts Claude to subscribe to a PR it opens");
if (existsSync(hooksFile)) {
  const post = JSON.parse(readFileSync(hooksFile, "utf8")).hooks?.PostToolUse ?? [];
  const cmds = post.flatMap((h) => (h.hooks ?? []).map((x) => ({ matcher: h.matcher ?? "", command: x.command ?? "" })));
  const pr = cmds.find((c) => c.command.includes("${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs"));
  check(pr, "no PostToolUse hook runs ${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs");
  check(pr && /Bash/.test(pr.matcher), "the PR hook does not match Bash, where gh pr create runs");
  check(existsSync(join(root, "hooks", "pr-created.mjs")), "hooks/pr-created.mjs does not exist");
}

const skills = join(root, "skills");
for (const name of readdirSync(skills)) {
  const file = join(skills, name, "SKILL.md");
  check(existsSync(file), `skills/${name} has no SKILL.md`);
  if (existsSync(file)) check(/^---\n(?:.*\n)*?description: .{20,}\n(?:.*\n)*?---\n/.test(readFileSync(file, "utf8")), `skills/${name}/SKILL.md has no description`);
}
for (const name of ["fix-failing-ci", "watch-this-pr", "sign-in", "setup-github"]) check(existsSync(join(skills, name, "SKILL.md")), `the ${name} skill is missing`);

if (failures.length) {
  console.error(`check-plugin: ${failures.length} problem(s):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`check-plugin: ${root} is consistent (plugin ${plugin.name} ${plugin.version}, channel ${channel.server})`);
