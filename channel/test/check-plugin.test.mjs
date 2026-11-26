// The plugin check's version rules (scripts/check-plugin.mjs): every field that names the plugin's version names
// the same one, and, with --against <ref>, a plugin that changed since that ref carries a newer version than it had
// there. Each case runs the real check as a subprocess against a copy of this plugin, so it tests the command a CI
// step or a release runs, not a function in isolation.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK = join(PLUGIN, "scripts", "check-plugin.mjs");
const MAIN_VERSION = /^export const VERSION = "([^"]*)";$/m;

// git with no inherited GIT_DIR or GIT_WORK_TREE (a hook or a CI step can set them), no signing, no hooks, and no
// background maintenance: newer git (Apple Git 2.54) packs a fresh repository in a detached process after a commit,
// which wrote into .git/objects while withTemp was removing the folder and failed a test with ENOTEMPTY.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};
const git = (dir, ...args) =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { env: GIT_ENV, encoding: "utf8" },
  );

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const writeJson = (root, rel, value) => writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`);

/** Every version field this plugin carries, as the check must read them. */
function versionsIn(root) {
  const plugin = readJson(root, ".claude-plugin/plugin.json");
  const market = readJson(root, ".claude-plugin/marketplace.json");
  const entry = (market.plugins ?? []).find((p) => p.name === plugin.name);
  const lock = readJson(root, "channel/package-lock.json");
  const main = readFileSync(join(root, "channel/src/main.ts"), "utf8").match(MAIN_VERSION);
  return {
    ".claude-plugin/plugin.json": plugin.version,
    ...(entry && "version" in entry ? { "marketplace entry": entry.version } : {}),
    "channel/package.json": readJson(root, "channel/package.json").version,
    "channel/package-lock.json version": lock.version,
    'channel/package-lock.json packages[""].version': lock.packages?.[""]?.version,
    "channel/src/main.ts VERSION": main?.[1],
  };
}

/**
 * Sets every version field to `version`, then `odd` (one field's name, see FIELDS) to `oddVersion`. The marketplace
 * entry gets a version only when it is the odd one or `marketEntry` is true: today it carries none.
 */
function setVersions(root, version, { odd, oddVersion, marketEntry = false } = {}) {
  const v = (field) => (field === odd ? oddVersion : version);
  const plugin = readJson(root, ".claude-plugin/plugin.json");
  plugin.version = v("plugin.json");
  writeJson(root, ".claude-plugin/plugin.json", plugin);
  const market = readJson(root, ".claude-plugin/marketplace.json");
  const entry = market.plugins.find((p) => p.name === plugin.name);
  if (odd === "marketplace" || marketEntry) entry.version = v("marketplace");
  else delete entry.version;
  writeJson(root, ".claude-plugin/marketplace.json", market);
  const pkg = readJson(root, "channel/package.json");
  pkg.version = v("package.json");
  writeJson(root, "channel/package.json", pkg);
  const lock = readJson(root, "channel/package-lock.json");
  lock.version = v("lock");
  lock.packages[""].version = v("lock packages");
  writeJson(root, "channel/package-lock.json", lock);
  const mainPath = join(root, "channel/src/main.ts");
  const main = readFileSync(mainPath, "utf8");
  assert.match(main, MAIN_VERSION, "channel/src/main.ts no longer has an `export const VERSION = \"...\";` line");
  writeFileSync(mainPath, main.replace(MAIN_VERSION, `export const VERSION = "${v("main.ts")}";`));
}

// Each field, and the words the check's refusal must use to name it.
const FIELDS = [
  ["plugin.json", ".claude-plugin/plugin.json"],
  ["marketplace", "marketplace"],
  ["package.json", "channel/package.json"],
  ["lock", "channel/package-lock.json version"],
  ["lock packages", 'packages[""].version'],
  ["main.ts", "channel/src/main.ts"],
];

/** A copy of this plugin at `dir`, without installed packages or git metadata. */
function copyPlugin(dir) {
  cpSync(PLUGIN, dir, { recursive: true, filter: (src) => !["node_modules", ".git"].includes(basename(src)) });
  return dir;
}

function check(root, ...args) {
  const r = spawnSync(process.execPath, [CHECK, root, ...args], { env: GIT_ENV, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "check-plugin-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A git repository with the plugin in a subdirectory (as in a larger repository that holds it) and one file
 * outside it, every version at 1.2.3, committed. Returns the plugin's directory and the repository's.
 */
function repoWithPlugin(dir) {
  const repo = join(dir, "repo");
  const plugin = copyPlugin(join(repo, "plugin"));
  setVersions(plugin, "1.2.3");
  writeFileSync(join(repo, "outside.txt"), "not part of the plugin\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, plugin };
}

test("every version field in this tree names the same version", () => {
  const versions = versionsIn(PLUGIN);
  const plugin = versions[".claude-plugin/plugin.json"];
  assert.match(plugin ?? "", /^\d+\.\d+\.\d+$/, "plugin.json has no x.y.z version");
  for (const [field, v] of Object.entries(versions)) assert.equal(v, plugin, `${field} is ${v}, but plugin.json is ${plugin}`);
});

test("the check passes a plugin whose version fields all agree, with or without a version on the marketplace entry", () => {
  withTemp((dir) => {
    const root = copyPlugin(join(dir, "plugin"));
    setVersions(root, "1.2.3");
    const without = check(root);
    assert.equal(without.status, 0, without.out);
    setVersions(root, "1.2.3", { marketEntry: true });
    const withEntry = check(root);
    assert.equal(withEntry.status, 0, withEntry.out);
  });
});

test("the check refuses a plugin when any one version field disagrees with the rest, and names that field", () => {
  withTemp((dir) => {
    const root = copyPlugin(join(dir, "plugin"));
    for (const [odd, named] of FIELDS) {
      setVersions(root, "1.2.3", { odd, oddVersion: "1.2.4" });
      const r = check(root);
      assert.equal(r.status, 1, `${odd} at 1.2.4 and the rest at 1.2.3 passed:\n${r.out}`);
      assert.ok(r.out.includes(named) && r.out.includes("1.2.4"), `the refusal for ${odd} does not name ${named} and 1.2.4:\n${r.out}`);
    }
  });
});

test("--against: a plugin that changed since the ref with its version unchanged is refused", () => {
  withTemp((dir) => {
    const { plugin } = repoWithPlugin(dir);
    appendFileSync(join(plugin, "README.md"), "\nA change.\n");
    const r = check(plugin, "--against", "HEAD");
    assert.equal(r.status, 1, `a changed plugin still at 1.2.3 passed:\n${r.out}`);
    assert.match(r.out, /a release must be a new version/, r.out);
    assert.match(r.out, /README\.md/, "the refusal does not name the changed file");
  });
});

test("--against: a new file in the plugin counts as a change", () => {
  withTemp((dir) => {
    const { plugin } = repoWithPlugin(dir);
    writeFileSync(join(plugin, "NEW.txt"), "new\n");
    const r = check(plugin, "--against", "HEAD");
    assert.equal(r.status, 1, `an untracked new file with the version unchanged passed:\n${r.out}`);
    assert.match(r.out, /a release must be a new version/, r.out);
  });
});

test("--against: a lowered version is refused, never taken for a new one", () => {
  withTemp((dir) => {
    const { plugin } = repoWithPlugin(dir);
    setVersions(plugin, "1.2.2");
    const r = check(plugin, "--against", "HEAD");
    assert.equal(r.status, 1, `1.2.3 lowered to 1.2.2 passed:\n${r.out}`);
    assert.match(r.out, /a release must be a new version/, r.out);
  });
});

test("--against: a changed plugin with a newer version passes, and so do no change and a change outside the plugin", () => {
  withTemp((dir) => {
    const { repo, plugin } = repoWithPlugin(dir);
    const unchanged = check(plugin, "--against", "HEAD");
    assert.equal(unchanged.status, 0, `nothing changed, and it was refused:\n${unchanged.out}`);

    appendFileSync(join(repo, "outside.txt"), "changed\n");
    const outside = check(plugin, "--against", "HEAD");
    assert.equal(outside.status, 0, `only a file outside the plugin changed, and it was refused:\n${outside.out}`);

    appendFileSync(join(plugin, "README.md"), "\nA change.\n");
    setVersions(plugin, "1.2.4");
    const bumped = check(plugin, "--against", "HEAD");
    assert.equal(bumped.status, 0, `a change released as 1.2.4 over 1.2.3 was refused:\n${bumped.out}`);

    setVersions(plugin, "1.10.0");
    const numeric = check(plugin, "--against", "HEAD");
    assert.equal(numeric.status, 0, `1.10.0 over 1.2.3 was refused: versions compare as numbers, not text:\n${numeric.out}`);
  });
});

test("--against a ref that does not exist is refused, never a pass", () => {
  withTemp((dir) => {
    const { plugin } = repoWithPlugin(dir);
    const r = check(plugin, "--against", "no-such-ref");
    assert.equal(r.status, 1, `an unknown ref passed:\n${r.out}`);
    assert.match(r.out, /no-such-ref/, r.out);
  });
});

test("--against with no ref after it is refused", () => {
  withTemp((dir) => {
    const root = copyPlugin(join(dir, "plugin"));
    setVersions(root, "1.2.3");
    const r = check(root, "--against");
    assert.equal(r.status, 1, `--against with no ref passed:\n${r.out}`);
  });
});

// Both hooks go through hooks/node.sh, which is what tells a machine with no Node.js so; and the doctor skill and the
// setup checks' module are part of the plugin.
test("the check refuses a hook that does not run through the Node.js wrapper, a missing wrapper, and a missing doctor skill", () => {
  withTemp((root) => {
    const plugin = join(root, "plugin");
    cpSync(PLUGIN, plugin, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
    assert.equal(spawnSync(process.execPath, [CHECK, plugin], { encoding: "utf8" }).status, 0, "the copy passes as it is");

    const hooks = readJson(plugin, "hooks/hooks.json");
    const bare = structuredClone(hooks);
    bare.hooks.SessionStart[0].hooks[0].command = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"';
    bare.hooks.PostToolUse[0].hooks[0].command = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pr-created.mjs"';
    writeJson(plugin, "hooks/hooks.json", bare);
    let r = spawnSync(process.execPath, [CHECK, plugin], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no SessionStart hook runs hooks\/session-start\.mjs through hooks\/node\.sh/);
    assert.match(r.stderr, /the PR hook does not run through hooks\/node\.sh as quiet/);

    writeJson(plugin, "hooks/hooks.json", hooks);
    rmSync(join(plugin, "hooks", "node.sh"));
    rmSync(join(plugin, "skills", "doctor"), { recursive: true });
    r = spawnSync(process.execPath, [CHECK, plugin], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hooks\/node\.sh does not exist/);
    assert.match(r.stderr, /the doctor skill is missing/);
  });
});

// The plugin works with no runners.io account, so what it installs connects to nothing of runners.io's: the one server
// in the manifest is the channel, which is a local process. The runners.io MCP server is added by the sign-in skill,
// with the user's yes. And the telemetry setting must reach both the hooks and the channel, or it turns off half.
test("the check refuses a manifest that installs a remote server, loses the telemetry setting, or leaves the hook's matcher open", () => {
  withTemp((root) => {
    const plugin = join(root, "plugin");
    cpSync(PLUGIN, plugin, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
    const run = () => spawnSync(process.execPath, [CHECK, plugin], { encoding: "utf8" });
    assert.equal(run().status, 0, "the copy passes as it is");
    const manifest = readJson(plugin, ".claude-plugin/plugin.json");
    assert.deepEqual(Object.keys(manifest.mcpServers), ["runners-io"], "this tree's manifest installs the channel and nothing else");

    const remote = structuredClone(manifest);
    remote.mcpServers["runners-io-mcp"] = { type: "http", url: "https://mcp.runners.io/mcp" };
    writeJson(plugin, ".claude-plugin/plugin.json", remote);
    let r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /installs a server other than the channel: runners-io-mcp/);

    const noSetting = structuredClone(manifest);
    delete noSetting.userConfig;
    writeJson(plugin, ".claude-plugin/plugin.json", noSetting);
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no telemetry setting that is on\|off with default on/);

    const notPassed = structuredClone(manifest);
    delete notPassed.mcpServers["runners-io"].env.CLAUDE_PLUGIN_OPTION_TELEMETRY;
    writeJson(plugin, ".claude-plugin/plugin.json", notPassed);
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not pass the telemetry setting to the channel/);

    writeJson(plugin, ".claude-plugin/plugin.json", manifest);
    const hooks = readJson(plugin, "hooks/hooks.json");
    hooks.hooks.PostToolUse[0].matcher = "Bash|mcp__.*create_pull_request";
    writeJson(plugin, "hooks/hooks.json", hooks);
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the PR hook's matcher is not anchored/);
  });
});

// The matcher is a regular expression tested anywhere in a tool's name, so an open one also fires for any tool whose
// name merely contains "Bash" or ends with more after create_pull_request.
test("the PR hook's matcher takes Bash and a create_pull_request tool of any server, whole names only", () => {
  const matcher = new RegExp(readJson(PLUGIN, "hooks/hooks.json").hooks.PostToolUse[0].matcher);
  for (const tool of ["Bash", "mcp__github__create_pull_request", "mcp__plugin_github_github__create_pull_request"]) assert.equal(matcher.test(tool), true, tool);
  for (const tool of ["BashOutput", "NotBash", "mcp__x__create_pull_request_review", "mcp____create_pull_request", "xmcp__a__create_pull_request", "Edit"]) assert.equal(matcher.test(tool), false, tool);
});

// The bundle may name one runners.io address, the telemetry endpoint, and holds no Sentry key: a public key is one
// anybody can post events against. Each way of turning telemetry off must be in the bundle that ships.
test("the check refuses a bundle that names another runners.io API, repoints the telemetry endpoint, mentions Sentry, or drops an opt-out", () => {
  withTemp((root) => {
    const plugin = join(root, "plugin");
    cpSync(PLUGIN, plugin, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
    const file = join(plugin, "channel", "dist", "runners-io-channel.mjs");
    const bundle = readFileSync(file, "utf8");
    const withBundle = (text) => {
      writeFileSync(file, text);
      return spawnSync(process.execPath, [CHECK, plugin], { encoding: "utf8" });
    };
    assert.equal(withBundle(bundle).status, 0, "the copy passes as it is");
    assert.ok(bundle.includes('"https://www.runners.io/api/plugin/telemetry"'), "the bundle holds the endpoint");

    let r = withBundle(`${bundle}\nfetch("https://www.runners.io/api/another/path");\n`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /names a runners\.io API other than its telemetry endpoint: https:\/\/www\.runners\.io\/api\/another\/path/);

    r = withBundle(bundle.replace('"https://www.runners.io/api/plugin/telemetry"', '"https://evil.runners.io/api/plugin/telemetry"'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /names a runners\.io API other than its telemetry endpoint/);
    assert.match(r.stderr, /does not hold the telemetry endpoint as the one constant/);

    r = withBundle(`${bundle}\nconst dsn = "https://abc@o1.ingest.sentry.io/2";\n`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mentions Sentry or a DSN/);

    for (const name of ["RUNNERS_IO_TELEMETRY", "DO_NOT_TRACK", "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
      r = withBundle(bundle.replaceAll(name, "SOMETHING_ELSE"));
      assert.equal(r.status, 1, name);
      if (name !== "DISABLE_TELEMETRY") assert.match(r.stderr, new RegExp(`does not read ${name}, which turns telemetry off`));
    }
  });
});
