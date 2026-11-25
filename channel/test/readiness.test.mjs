// The setup checks (hooks/readiness.mjs): each one against a machine that fakes its condition. A "machine" here is a
// folder: a PATH that holds only what the case allows (a fake gh, the real git), and a home, state, cache and gh
// settings folder of its own, so nothing reads or writes this user's real ones.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DECLINE_FOR_MS,
  FIRST_CALL_MAX_AGE_MS,
  clearFirstCall,
  findings,
  firstCallRows,
  ghAccounts,
  launchChecks,
  mergeRows,
  ownerKey,
  projectKey,
  readFirstCall,
  readSetupState,
  recordDecline,
  recordFirstCall,
  remoteHost,
  renderTable,
  setupFor,
  setupNotice,
  stateRoot,
} from "../../hooks/readiness.mjs";
import { fakeMachine, project } from "./fake-machine.mjs";

const READINESS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "readiness.mjs");
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const machine = (options) => {
  const m = fakeMachine(options);
  roots.push(m.root);
  return m;
};

async function check(m, dir, more = {}) {
  return launchChecks({ env: m.env, projectDir: dir, platform: "linux", ...more });
}
const one = (rows, id) => rows.find((r) => r.id === id);
const notReady = (rows) => findings(rows).map((r) => r.id);

// ---- the launch checks -------------------------------------------------------------------------------------------

test("a machine that is ready: every check is ready, nothing is found, and it takes well under a second", async () => {
  const m = machine();
  const dir = project(m);
  const begin = Date.now();
  const rows = await check(m, dir);
  const took = Date.now() - begin;
  assert.deepEqual(notReady(rows), []);
  assert.ok(rows.length >= 9, `expected a row per check, got ${rows.length}`);
  for (const r of rows) assert.equal(r.state, "ready", `${r.id}: ${r.state} ${r.why ?? ""}`);
  assert.ok(took < 3000, `the launch checks took ${took} ms`);
});

test("gh is not on PATH: CI cannot be read, and Claude is to offer the install, asking first", async () => {
  const m = machine({ gh: null });
  const r = one(await check(m, project(m)), "gh_missing");
  assert.equal(r.state, "not_ready");
  assert.equal(r.effect, "blocks");
  assert.equal(r.line, "the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.");
  assert.match(r.fix, /Offer to install the GitHub CLI, asking first/);
  assert.match(r.fix, /\/runners-io:setup-github/);
  assert.match(r.fix, /sudo.*the user's to run as `! <command>`/, "on Linux the install needs sudo, which is the user's");
});

test("the install offered is the one for the system: Homebrew on macOS, winget on Windows", async () => {
  const m = machine({ gh: null });
  const dir = project(m);
  assert.match(one(await check(m, dir, { platform: "darwin" }), "gh_missing").fix, /brew install gh/);
  // Windows reads PATH with ; between folders, so this machine's PATH names nothing there: gh and git are both missing.
  const win = await check(m, dir, { platform: "win32" });
  assert.match(one(win, "gh_missing").fix, /winget install --id GitHub\.cli/);
  assert.match(one(win, "git_missing").fix, /winget install --id Git\.Git/);
});

test("gh is missing but a token variable is set: CI is still read, so it only degrades, and the variable is named", async () => {
  const m = machine({ gh: null, env: { GITHUB_TOKEN: "ghp_x" } });
  const r = one(await check(m, project(m)), "gh_missing");
  assert.equal(r.effect, "degrades");
  assert.match(r.line, /isn't installed: CI is read with the token in GITHUB_TOKEN/);
  assert.equal(r.line.includes("ghp_x"), false);
});

test("gh is installed and signed out: the sign-in is the user's own command, and no token is ever asked for", async () => {
  const m = machine({ gh: "signed-out" });
  const rows = await check(m, project(m));
  assert.equal(one(rows, "gh_missing").state, "ready");
  const r = one(rows, "gh_signed_out");
  assert.equal(r.effect, "blocks");
  assert.equal(r.line, "the GitHub CLI isn't signed in to github.com, so CI can't be read. Ask me to help you sign in.");
  assert.ok(r.fix.includes("`! gh auth login --hostname github.com --web --scopes repo`"), r.fix);
  assert.match(r.fix, /Never ask for a token/);
  assert.match(readFileSync(m.ghLog, "utf8"), /^auth token --hostname github\.com$/m, "asked by gh auth token, for github.com");
});

test("gh is signed out but GH_TOKEN is set: the channel has a login, so nothing is found", async () => {
  const m = machine({ gh: "signed-out", env: { GH_TOKEN: "ghp_x" } });
  const rows = await check(m, project(m));
  assert.deepEqual(notReady(rows), []);
  assert.equal(one(rows, "gh_signed_out").state, "skipped");
});

test("git is not on PATH: it blocks, and what needs a repository is skipped, not guessed", async () => {
  const m = machine({ git: false });
  const dir = join(m.root, "project");
  mkdirSync(dir);
  const rows = await check(m, dir);
  const r = one(rows, "git_missing");
  assert.equal(r.effect, "blocks");
  assert.match(r.line, /^git isn't installed, so the plugin can't tell which repository and branch you are on/);
  assert.match(r.fix, /Offer to install git, asking first/);
  assert.match(r.fix, /sudo apt-get install git/);
  assert.equal(one(rows, "not_a_repo").state, "skipped");
  assert.deepEqual(notReady(rows), ["git_missing"]);
});

test("the folder is not a git repository: information, with nothing to fix", async () => {
  const m = machine();
  const r = one(await check(m, project(m, { repo: false })), "not_a_repo");
  assert.equal(r.effect, "info");
  assert.match(r.line, /^this folder isn't a git repository, so there is no pull request to watch here; CI on request still works/);
  assert.match(r.fix, /^Nothing to fix/);
});

test("origin is on GitLab, or there is no origin: information that the plugin reads GitHub Actions only", async () => {
  const lab = machine();
  const r = one(await check(lab, project(lab, { origin: "git@gitlab.com:acme/widgets.git" })), "no_github_remote");
  assert.equal(r.effect, "info");
  assert.equal(r.line, "this repository's origin isn't on GitHub, and the plugin reads GitHub Actions only.");
  assert.match(r.fix, /^Nothing to fix/);
  const none = machine();
  const rows = await check(none, project(none, { origin: null }));
  assert.match(one(rows, "no_github_remote").line, /has no origin remote/);
  assert.equal(one(rows, "no_workflows").state, "skipped", "no workflows is not said of a repository that is not on GitHub");
});

test("origin is a GitHub Enterprise host: it degrades, and the fix names the host's own sign-in and the API setting", async () => {
  const m = machine();
  const rows = await check(m, project(m, { origin: "https://github.acme.example/team/widgets.git" }));
  const r = one(rows, "enterprise_host");
  assert.equal(r.effect, "degrades");
  assert.match(r.line, /^this repository is on GitHub Enterprise \(github\.acme\.example\)/);
  assert.ok(r.fix.includes("`! gh auth login --hostname github.acme.example --web`"), r.fix);
  assert.match(r.fix, /RUNNERS_IO_GITHUB_API/);
  assert.match(r.fix, /asking first/);
  assert.equal(one(rows, "no_github_remote"), undefined, "one row for the remote, not two");
});

test("a host gh is signed in to is an Enterprise host, whatever it is called", async () => {
  const m = machine({ hosts: "git.corp.example:\n    users:\n        ada:\n    user: ada\n" });
  assert.equal(one(await check(m, project(m, { origin: "git@git.corp.example:team/widgets.git" })), "enterprise_host").effect, "degrades");
});

test("GH_TOKEN or GITHUB_TOKEN set over gh's own login: it degrades, names which, and gh is never handed the variable", async () => {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const m = machine({ env: { [name]: "ghp_secretValue" } });
    const r = one(await check(m, project(m)), "token_env");
    assert.equal(r.effect, "degrades", name);
    assert.equal(r.line, `${name} is set, so GitHub is read with that token and not with gh's own login.`);
    assert.ok(r.fix.includes(`env -u ${name} claude`), r.fix);
    assert.match(r.fix, /never print its value/);
    assert.equal(JSON.stringify(r).includes("ghp_secretValue"), false, "the token's value is in no row");
    assert.equal(readFileSync(m.ghLog, "utf8").includes("saw a token variable"), false, "gh was asked for its own stored login");
  }
});

test("gh holds several accounts: it degrades, and says how many and which is active", async () => {
  const hosts = "github.com:\n    users:\n        ada:\n        ada-work:\n    git_protocol: https\n    user: ada-work\n";
  const m = machine({ hosts });
  const r = one(await check(m, project(m)), "several_accounts");
  assert.equal(r.effect, "degrades");
  assert.match(r.line, /^gh holds 2 accounts for github\.com, and the plugin reads CI as the active one \(ada-work\)/);
  assert.match(r.fix, /after a yes run `gh auth switch --hostname github\.com`/);
  const single = machine({ hosts: "github.com:\n    users:\n        ada:\n    user: ada\n" });
  assert.equal(one(await check(single, project(single)), "several_accounts").state, "ready");
});

test("gh's list of accounts is read by name only: an old file's token is never taken for one", () => {
  const hosts = ghAccounts("github.com:\n    oauth_token: gho_oldStyleToken\n    user: ada\n    git_protocol: ssh\ngit.corp.example:\n  users:\n    bo:\n      oauth_token: gho_x\n    cy:\n  user: cy\n");
  assert.deepEqual(hosts["github.com"], { users: [], active: "ada" });
  assert.deepEqual(hosts["git.corp.example"], { users: ["bo", "cy"], active: "cy" });
  assert.equal(JSON.stringify(hosts).includes("gho_"), false);
});

test("the repository has no workflow file: information that there is no CI to watch here", async () => {
  const m = machine();
  const r = one(await check(m, project(m, { workflows: false })), "no_workflows");
  assert.equal(r.effect, "info");
  assert.equal(r.line, "this repository has no GitHub Actions workflows (.github/workflows), so there is no CI to watch here yet.");
  assert.match(r.fix, /^Nothing to fix/);
});

test("an upstream remote on GitHub: information that the upstream's pull requests are not watched by themselves", async () => {
  const m = machine();
  const r = one(await check(m, project(m, { upstream: "https://github.com/upstream-org/widgets.git" })), "fork");
  assert.equal(r.effect, "info");
  assert.match(r.line, /^this clone has an upstream remote, so it looks like a fork/);
  assert.match(r.fix, /subscribe tool with that repository and the pull request's number/);
  const same = machine();
  assert.equal(one(await check(same, project(same, { upstream: "git@github.com:acme/widgets.git" })), "fork").state, "ready", "an upstream that is origin is no fork");
});

test("HTTPS_PROXY or https_proxy set: it degrades and says the channel does not use the proxy yet", async () => {
  for (const name of ["HTTPS_PROXY", "https_proxy"]) {
    const m = machine({ env: { [name]: "http://proxy.corp.example:3128" } });
    const r = one(await check(m, project(m)), "proxy");
    assert.equal(r.effect, "degrades", name);
    assert.equal(r.line, `${name} is set, and the plugin's channel doesn't use the proxy yet, so behind it CI may not arrive.`);
    assert.match(r.fix, /NODE_USE_ENV_PROXY=1/);
    assert.equal(JSON.stringify(r).includes("proxy.corp.example"), false, "the proxy's address is not repeated");
  }
  const told = machine({ env: { HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "1" } });
  assert.equal(one(await check(told, project(told)), "proxy").state, "ready", "Node was told to use the proxy");
});

test("the plugin's data folder cannot be written: it degrades, names the folder, and says what is off", async () => {
  const m = machine();
  writeFileSync(join(m.root, "a-file"), "");
  m.env.XDG_STATE_HOME = join(m.root, "a-file", "state"); // a folder under a file can never be made
  const r = one(await check(m, project(m)), "data_dir");
  assert.equal(r.effect, "degrades");
  assert.ok(r.line.startsWith(`the plugin can't write its data folder (${join(m.root, "a-file", "state", "runners-io")})`), r.line);
  assert.match(r.line, /reading CI still works/);
  assert.match(r.fix, /repository scopes/);
  assert.match(r.fix, /RUNNERS_IO_NO_SETUP_CHECKS=1/);
});

test("on Windows: a note that the launch cannot be read and claude-gh cannot be set up, with no offer of claude-gh", async () => {
  const m = machine();
  const r = one(await check(m, project(m), { platform: "win32" }), "windows");
  assert.equal(r.effect, "degrades");
  assert.match(r.line, /^on Windows the plugin can't tell whether live CI events are on/);
  assert.match(r.fix, /do not offer claude-gh/);
  assert.equal(one(await check(m, join(m.root, "project")), "windows"), undefined, "said nowhere else");
});

test("a remote's host is read from every form git takes, and a local path names none", () => {
  assert.equal(remoteHost("git@GitLab.com:acme/w.git"), "gitlab.com");
  assert.equal(remoteHost("https://user@github.acme.example:8443/team/w.git"), "github.acme.example");
  assert.equal(remoteHost("ssh://git@bitbucket.org/acme/w.git"), "bitbucket.org");
  assert.equal(remoteHost("/srv/git/w.git"), null);
  assert.equal(remoteHost("file:///srv/git/w.git"), null);
  assert.equal(remoteHost("C:\\repos\\w"), null);
});

// ---- what GitHub answered, recorded by the channel and read at the next launch -----------------------------------

const T0 = 1_800_000_000_000;

test("no repo scope, recorded: private repositories cannot be seen, and the refresh is the user's own command", () => {
  const m = machine();
  assert.equal(recordFirstCall(m.env, "no_repo_scope", { source: "gh", now: T0 }), true);
  const r = one(firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: m.root }), "no_repo_scope");
  assert.equal(r.effect, "degrades");
  assert.equal(r.line, "gh's login has no repo scope, so pull requests in private repositories can't be seen; public ones work.");
  assert.ok(r.fix.includes("`! gh auth refresh --hostname github.com --scopes repo`"), r.fix);
});

test("single sign-on not authorised, recorded: the user opens the organisation's link, and the organisation is not kept", () => {
  const m = machine();
  recordFirstCall(m.env, "sso", { source: "gh", owner: ownerKey("Secret-Org"), now: T0 });
  const r = one(firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: m.root }), "sso");
  assert.equal(r.effect, "degrades");
  assert.match(r.line, /isn't authorised for an organisation's single sign-on \(SSO\)/);
  assert.match(r.fix, /authorisation link/);
  assert.equal(readFileSync(join(stateRoot(m.env), "first-call.json"), "utf8").toLowerCase().includes("secret-org"), false);
});

test("a refused login, recorded: it blocks; gh's is signed in again, a variable's token is named and replaced", () => {
  const m = machine();
  recordFirstCall(m.env, "token_rejected", { source: "gh", now: T0 });
  let r = one(firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: m.root }), "token_rejected");
  assert.equal(r.effect, "blocks");
  assert.equal(r.line, "GitHub refused gh's login (expired or revoked), so CI can't be read. Ask me to help you sign in again.");
  assert.ok(r.fix.includes("`! gh auth login --hostname github.com --web --scopes repo`"), r.fix);

  const v = machine({ env: { GH_TOKEN: "ghp_x" } });
  recordFirstCall(v.env, "token_rejected", { source: "env", now: T0 });
  r = one(firstCallRows(readFirstCall(v.env, T0), { env: v.env, projectDir: v.root }), "token_rejected");
  assert.equal(r.line, "GitHub refused the token in GH_TOKEN (expired or revoked), so CI can't be read.");
  assert.ok(r.fix.includes("env -u GH_TOKEN claude"), r.fix);
});

test("a refused gh login is not said once gh has been signed in again since", () => {
  const m = machine({ hosts: "github.com:\n    users:\n        ada:\n    user: ada\n" });
  recordFirstCall(m.env, "token_rejected", { source: "gh", now: T0 });
  utimesSync(join(m.root, "gh", "hosts.yml"), (T0 + 60_000) / 1000, (T0 + 60_000) / 1000);
  assert.equal(one(firstCallRows(readFirstCall(m.env, T0 + 120_000), { env: m.env, projectDir: m.root }), "token_rejected").state, "unknown");
});

test("a certificate that does not verify, recorded: it blocks, and the fix is NODE_EXTRA_CA_CERTS, never switching checks off", () => {
  const m = machine();
  recordFirstCall(m.env, "cert_error", { source: "gh", now: T0 });
  const r = one(firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: m.root }), "cert_error");
  assert.equal(r.effect, "blocks");
  assert.match(r.line, /^GitHub's certificate couldn't be verified/);
  assert.match(r.fix, /NODE_EXTRA_CA_CERTS/);
  assert.match(r.fix, /Never suggest turning certificate checks off/);
  assert.equal(r.fix.includes("NODE_TLS_REJECT_UNAUTHORIZED"), false);
});

test("a fork, recorded for one project: information there, and nothing in another project", () => {
  const m = machine();
  recordFirstCall(m.env, "fork", { project: projectKey("/work/fork"), now: T0 });
  const record = readFirstCall(m.env, T0);
  const r = one(firstCallRows(record, { env: m.env, projectDir: "/work/fork" }), "fork");
  assert.equal(r.effect, "info");
  assert.match(r.line, /^this repository is a fork on GitHub/);
  assert.equal(one(firstCallRows(record, { env: m.env, projectDir: "/work/other" }), "fork"), undefined);
});

test("reads refused with a variable's token: the token variable is no longer a once-only note, and wins over the launch's row", async () => {
  const m = machine({ env: { GH_TOKEN: "ghp_x" } });
  const dir = project(m);
  recordFirstCall(m.env, "forbidden", { source: "env", owner: ownerKey("acme"), now: T0 });
  const rows = mergeRows(await check(m, dir), firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: dir }));
  const r = one(rows, "token_env");
  assert.equal(r.once, undefined);
  assert.equal(r.line, "GitHub refused some CI reads made with the token in GH_TOKEN; gh's own login is not being used.");
  assert.equal(rows.filter((x) => x.id === "token_env").length, 1);
});

test("with no answer on record a first-call check is unknown, and ready only once GitHub has answered well", () => {
  const m = machine();
  assert.equal(one(firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: m.root }), "token_rejected").state, "unknown");
  recordFirstCall(m.env, "ok", { source: "gh", now: T0 });
  for (const id of ["token_rejected", "cert_error", "no_repo_scope", "sso"]) {
    assert.equal(one(firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: m.root }), id).state, "ready", id);
  }
});

test("the record holds kinds, counts and times only; a good answer clears a refusal, per organisation; a week-old one is dropped", () => {
  const m = machine();
  recordFirstCall(m.env, "token_rejected", { source: "gh", now: T0 });
  recordFirstCall(m.env, "token_rejected", { source: "gh", now: T0 + 1000 });
  recordFirstCall(m.env, "sso", { source: "gh", owner: ownerKey("org-a"), now: T0 });
  recordFirstCall(m.env, "sso", { source: "gh", owner: ownerKey("org-b"), now: T0 });
  const file = join(stateRoot(m.env), "first-call.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(raw.kinds.token_rejected, { n: 2, first: T0, last: T0 + 1000, source: "gh" });
  assert.deepEqual(Object.keys(raw).sort(), ["kinds", "projects", "v"]);
  assert.equal(/gho_|ghp_|org-a|org-b|acme/.test(readFileSync(file, "utf8")), false);

  assert.equal(clearFirstCall(m.env, ["token_rejected"], { now: T0 + 2000 }), true);
  assert.equal(clearFirstCall(m.env, ["sso"], { owner: ownerKey("org-a"), now: T0 + 2000 }), true);
  assert.deepEqual(Object.keys(readFirstCall(m.env, T0 + 2000).kinds), ["sso"], "org-b's refusal stands");
  assert.equal(clearFirstCall(m.env, ["sso"], { owner: ownerKey("org-b"), now: T0 + 2000 }), true);
  assert.deepEqual(readFirstCall(m.env, T0 + 2000).kinds, {});

  recordFirstCall(m.env, "cert_error", { source: "gh", now: T0 });
  assert.deepEqual(readFirstCall(m.env, T0 + FIRST_CALL_MAX_AGE_MS + 1).kinds, {}, "older than a week");
  assert.equal(recordFirstCall(m.env, "made_up_kind", { now: T0 }), false);
});

test("a record that is not the channel's is not believed: other text, other kinds, a symlink", () => {
  const m = machine();
  const root = stateRoot(m.env);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "first-call.json"), JSON.stringify({ kinds: { token_rejected: { n: "many", first: 1, last: 2 }, run_this: { n: 1, first: T0, last: T0 } } }));
  assert.deepEqual(readFirstCall(m.env, T0), { kinds: {}, projects: {} });
  writeFileSync(join(root, "first-call.json"), "not json");
  assert.deepEqual(readFirstCall(m.env, T0), { kinds: {}, projects: {} });
  rmSync(join(root, "first-call.json"));
  writeFileSync(join(m.root, "elsewhere.json"), JSON.stringify({ kinds: { cert_error: { n: 1, first: T0, last: T0 } } }));
  symlinkSync(join(m.root, "elsewhere.json"), join(root, "first-call.json"));
  assert.deepEqual(readFirstCall(m.env, T0), { kinds: {}, projects: {} });
});

// ---- what a launch says ------------------------------------------------------------------------------------------

const ROOT = "/Users/me/.claude/plugins/cache/runners-io/runners-io/0.3.14";
const blocker = { id: "gh_missing", label: "l", state: "not_ready", effect: "blocks", line: "the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.", fix: "Offer to install the GitHub CLI, asking first." };
const degrade = { id: "enterprise_host", label: "l", state: "not_ready", effect: "degrades", line: "this repository is on GitHub Enterprise (h).", fix: "Offer to set it up." };
const info = { id: "no_workflows", label: "l", state: "not_ready", effect: "info", line: "this repository has no GitHub Actions workflows.", fix: "Nothing to fix." };

test("nothing found: a launch says nothing", () => {
  assert.equal(setupNotice([{ id: "gh_missing", label: "l", state: "ready" }, { id: "x_y", label: "l", state: "unknown" }]), null);
});

test("the user sees one line naming the most serious problem; Claude gets every problem, its fix, and the rules for offering", () => {
  const n = setupNotice([info, degrade, blocker], { pluginRoot: ROOT, project: "0123456789abcdef" });
  assert.equal(n.line, "runners.io: the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up. (2 more: /runners-io:doctor lists them.)");
  assert.equal(n.line.includes("\n"), false);
  const c = n.context;
  assert.ok(c.indexOf("(gh_missing)") < c.indexOf("(enterprise_host)") && c.indexOf("(enterprise_host)") < c.indexOf("(no_workflows)"), "most serious first");
  assert.match(c, /Fix to offer: Offer to install the GitHub CLI, asking first\./);
  assert.match(c, /Ask first, and change nothing without a yes/);
  assert.match(c, /\/runners-io:setup-github skill's rules/);
  assert.match(c, /sudo, an administrator prompt, a browser or a one-time code is the user's to run.*`! <command>`/);
  assert.match(c, /Never ask for a token, never print one, and never put one on a command line/);
  assert.match(c, /After a fix, run \/runners-io:doctor and confirm that its line now reads ready/);
  assert.ok(c.includes(`node ${ROOT}/hooks/readiness.mjs decline`), c);
  assert.deepEqual(n.said, ["no_workflows"]);
});

test("information is said once per project and never again; in another project it is said once there", () => {
  const state = { declined: {}, said: { aaaaaaaaaaaaaaaa: { no_workflows: T0 } } };
  assert.equal(setupNotice([info], { state, project: "aaaaaaaaaaaaaaaa", now: T0 + 400 * 24 * 60 * 60_000 }), null);
  const other = setupNotice([info], { state, project: "bbbbbbbbbbbbbbbb", now: T0 });
  assert.equal(other.line, "runners.io: this repository has no GitHub Actions workflows.");
  assert.match(other.context, /None of these needs a fix/);
});

test("a fix the user said no to is not offered, and its line not shown, for 7 days; then once more", () => {
  const state = { declined: { enterprise_host: T0 }, said: {} };
  assert.equal(setupNotice([degrade], { state, now: T0 + DECLINE_FOR_MS - 1 }), null);
  assert.match(setupNotice([degrade], { state, now: T0 + DECLINE_FOR_MS }).context, /Fix to offer/);
});

test("a blocker the user said no to still shows its one line, and Claude is told not to offer", () => {
  const n = setupNotice([blocker, degrade], { state: { declined: { gh_missing: T0, enterprise_host: T0 }, said: {} }, now: T0 + 1000, pluginRoot: ROOT });
  assert.equal(n.line, "runners.io: the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.");
  assert.match(n.context, /do not offer a fix/);
  assert.equal(n.context.includes("Fix to offer"), false);
});

test("RUNNERS_IO_NO_SETUP_CHECKS=1: nothing is offered; a blocker's line still shows, anything less says nothing", () => {
  assert.equal(setupNotice([degrade, info], { optOut: true }), null);
  const n = setupNotice([blocker, degrade], { optOut: true, pluginRoot: ROOT });
  assert.equal(n.line, "runners.io: the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.");
  assert.match(n.context, /RUNNERS_IO_NO_SETUP_CHECKS=1/);
  assert.equal(n.context.includes("Fix to offer"), false);
  assert.deepEqual(n.said, []);
});

test("when nothing can be remembered, a once-only item is left unsaid rather than said at every launch", () => {
  assert.equal(setupNotice([info, { ...degrade, once: true }], { canRemember: false }), null);
  assert.match(setupNotice([info, degrade], { canRemember: false }).line, /GitHub Enterprise/);
});

test("the hook's path on a ready machine: nothing, and nothing is written about it", async () => {
  const m = machine();
  const dir = project(m);
  assert.equal(await setupFor({ cwd: dir }, m.env, { platform: "linux", pluginRoot: ROOT }), null);
  assert.equal(existsSync(join(stateRoot(m.env), "setup-checks.json")), false);
});

test("the hook's path with gh missing: the line and the offer, at every launch until it is fixed", async () => {
  const m = machine({ gh: null });
  const dir = project(m);
  for (let launch = 0; launch < 2; launch++) {
    const out = await setupFor({ cwd: dir }, m.env, { platform: "linux", pluginRoot: ROOT });
    assert.equal(out.line, "runners.io: the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.");
    assert.match(out.context, /\(gh_missing\).*Fix to offer: Offer to install the GitHub CLI, asking first/);
  }
});

test("the hook's path with only information to give: said at the first launch in the project, silent at the next", async () => {
  const m = machine();
  const dir = project(m, { workflows: false });
  const first = await setupFor({ cwd: dir }, m.env, { platform: "linux", pluginRoot: ROOT, now: T0 });
  assert.match(first.line, /no GitHub Actions workflows/);
  assert.equal(await setupFor({ cwd: dir }, m.env, { platform: "linux", pluginRoot: ROOT, now: T0 + 1000 }), null);
  assert.deepEqual(readSetupState(m.env).said[projectKey(dir)], { no_workflows: T0 });
});

test("a no, recorded by the command the offer names, silences that fix for 7 days and no other", async () => {
  const m = machine({ gh: "signed-out" });
  const dir = project(m, { origin: "https://github.acme.example/team/widgets.git" });
  const r = spawnSync(process.execPath, [READINESS, "decline", "enterprise_host"], { env: m.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /enterprise_host will not be offered again for 7 days/);
  const out = await setupFor({ cwd: dir }, m.env, { platform: "linux", pluginRoot: ROOT });
  assert.match(out.context, /\(gh_signed_out\)/);
  assert.equal(out.context.includes("(enterprise_host)"), false);
  assert.equal(recordDecline(m.env, ["rm -rf ~"]), false, "only a check's id is recorded");
  assert.equal(spawnSync(process.execPath, [READINESS, "decline"], { env: m.env, encoding: "utf8" }).status, 3);
});

test("the table lists every check on a line: ready, NOT READY with its effect, line and fix, or why it is unknown", async () => {
  const m = machine({ gh: "signed-out" });
  const dir = project(m);
  const rows = mergeRows(await check(m, dir), firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: dir }));
  const table = renderTable(rows);
  assert.match(table, /^ {2}ready {6}the GitHub CLI \(gh\) is installed$/m);
  assert.match(table, /^ {2}NOT READY {2}gh is signed in to github\.com \[blocks; \w+\]: the GitHub CLI isn't signed in.* Fix: .*gh auth login/m);
  assert.match(table, /^ {2}unknown {4}GitHub accepts the login \(GitHub has not been asked yet\)$/m);
  assert.equal(table.split("\n").length, rows.length);
});

test("readiness.mjs check prints that table, as the doctor skill runs it without the channel", () => {
  const m = machine({ gh: null });
  const dir = project(m);
  const r = spawnSync(process.execPath, [READINESS, "check"], { env: { ...m.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NOT READY {2}the GitHub CLI \(gh\) is installed \[blocks; gh_missing\]/);
  assert.match(r.stdout, /ready {6}git is installed/);
});
