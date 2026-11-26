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

test("a host is not GitHub Enterprise because its name says github: the API setting is never offered for a host only the repository names", async () => {
  // The remote is the repository's own text. Offering to point the plugin's API setting at whatever host it names
  // would send the user's login for that host, or one they are then asked to make, to an address a stranger chose.
  for (const origin of ["https://github.evil.example/team/widgets.git", "git@ghe.evil.example:team/widgets.git", "https://evil-github.example/team/widgets.git", "ssh://git@github-ghe.example/team/widgets.git"]) {
    const m = machine();
    const rows = await check(m, project(m, { origin }));
    assert.equal(one(rows, "enterprise_host"), undefined, origin);
    const r = one(rows, "no_github_remote");
    assert.equal(r.effect, "info", origin);
    assert.equal(r.line, "this repository's origin isn't on GitHub, and the plugin reads GitHub Actions only.");
    assert.equal(/RUNNERS_IO_GITHUB_API|evil|gh auth login/.test(JSON.stringify(rows)), false, `${origin}: neither the host nor the setting is put to Claude`);
  }
});

test("origin is a GitHub Enterprise host GH_HOST names: it degrades, and the fix names the host's own sign-in and the API setting", async () => {
  const m = machine({ env: { GH_HOST: "github.acme.example" } });
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
  // A host the plugin is already set to read is the user's own choice too: the row says where it stands, and names no new address.
  const set = machine({ env: { RUNNERS_IO_GITHUB_API: "https://git.corp.example/api/v3" } });
  assert.equal(one(await check(set, project(set, { origin: "git@git.corp.example:team/widgets.git" })), "enterprise_host").effect, "degrades");
});

test("a github.com repository while the plugin is set to another host: said once, and its pull requests are not looked up there", async () => {
  const m = machine({ env: { RUNNERS_IO_GITHUB_API: "https://ghe.corp.example/api/v3" } });
  const rows = await check(m, project(m));
  const r = one(rows, "host_mismatch");
  assert.equal(r.state, "not_ready");
  assert.equal(r.effect, "degrades");
  assert.equal(r.once, true);
  assert.equal(r.label, "the repository's origin is on the GitHub host the plugin reads");
  assert.equal(
    r.line,
    "this repository is on github.com, but the plugin is set to read ghe.corp.example (RUNNERS_IO_GITHUB_API), so its pull requests are not looked up: a repository is only ever asked of its own host.",
  );
  assert.match(r.fix, /^Nothing to install\./);
  assert.match(r.fix, /starts Claude Code without `RUNNERS_IO_GITHUB_API`/);
  assert.match(r.fix, /Never suggest pointing the variable at another address/);
  assert.equal(one(rows, "no_github_remote"), undefined, "one row for the remote, not two");
  assert.equal(one(rows, "no_workflows").state, "skipped");
  assert.equal(one(rows, "fork").state, "skipped");
  // The control: the same repository with the setting unset, or naming github.com's own API, is simply ready.
  for (const env of [{}, { RUNNERS_IO_GITHUB_API: "https://api.github.com" }]) {
    const plain = machine({ env });
    const ok = await check(plain, project(plain));
    assert.equal(one(ok, "host_mismatch"), undefined);
    assert.equal(one(ok, "no_github_remote").state, "ready");
  }
});

test("NODE_TLS_REJECT_UNAUTHORIZED=0: it blocks, since the login is not sent with certificate checks off, and the fix is to unset it", async () => {
  const m = machine({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
  const rows = await check(m, project(m));
  const r = one(rows, "tls_checks_off");
  assert.equal(r.state, "not_ready");
  assert.equal(r.effect, "blocks");
  assert.equal(r.label, "certificate checks are on");
  assert.equal(r.line, "NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, so the plugin doesn't send your GitHub login and CI can't be read.");
  assert.match(r.fix, /^Nothing to install\./);
  assert.match(r.fix, /unsets `NODE_TLS_REJECT_UNAUTHORIZED`/);
  assert.match(r.fix, /`NODE_EXTRA_CA_CERTS` set to the company's root certificate file/);
  assert.match(r.fix, /Never suggest leaving certificate checks off/);
  assert.match(renderTable(rows), /NOT READY {2}certificate checks are on \[blocks; tls_checks_off\]: NODE_TLS_REJECT_UNAUTHORIZED=0 turns/);
  // A blocker is shown at every launch, whatever was declined.
  const notice = setupNotice(rows, { state: { declined: { tls_checks_off: 1000 }, said: {} }, now: 2000 });
  assert.equal(notice.line, `runners.io: ${r.line}`);
  // The controls: unset, or any other value, is ready; so is the tests' own fake GitHub, which has no certificate.
  for (const env of [{}, { NODE_TLS_REJECT_UNAUTHORIZED: "1" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0", RUNNERS_IO_TEST_FAKE_GITHUB: "1", RUNNERS_IO_GITHUB_API: "http://127.0.0.1:8790" }]) {
    const fine = machine({ env });
    assert.equal(one(await check(fine, project(fine)), "tls_checks_off").state, "ready", JSON.stringify(env));
  }
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

test("an upstream remote on GitHub: nothing to say at launch, since the pull request on the upstream repository is watched too; the doctor says so", async () => {
  const m = machine();
  const rows = await check(m, project(m, { upstream: "https://github.com/upstream-org/widgets.git" }));
  const r = one(rows, "fork");
  assert.equal(r.state, "ready");
  assert.equal(r.label, "a fork's pull request on the repository it was forked from is found");
  assert.match(r.why, /^this clone has an upstream remote on GitHub: the branch's pull request is looked for there first/);
  assert.deepEqual(notReady(rows), [], "a fork is nothing to tell the user about any more");
  assert.equal(JSON.stringify(r).includes("upstream-org"), false, "the upstream repository is not named");
  const same = machine();
  const plain = one(await check(same, project(same, { upstream: "git@github.com:acme/widgets.git" })), "fork");
  assert.equal(plain.state, "ready", "an upstream that is origin is no fork");
  assert.equal(plain.why, undefined);
});

test("HTTPS_PROXY or https_proxy set: nothing to say at launch, since the channel goes through the proxy; the doctor names its host and port, never its login", async () => {
  for (const name of ["HTTPS_PROXY", "https_proxy"]) {
    const m = machine({ env: { [name]: "http://ada:s3cr3t-pa55@proxy.corp.example:3128" } });
    const rows = await check(m, project(m));
    const r = one(rows, "proxy");
    assert.equal(r.state, "ready", name);
    assert.equal(r.label, "GitHub is reached directly, or through a proxy the channel can use");
    assert.equal(r.why, `through proxy.corp.example:3128, from ${name}`);
    assert.deepEqual(notReady(rows), []);
    assert.equal(/s3cr3t|ada/.test(JSON.stringify(rows)), false, "the proxy's login is in no row");
    assert.match(renderTable(rows), /ready {6}GitHub is reached directly, or through a proxy the channel can use \(through proxy\.corp\.example:3128, from /);
  }
  const none = machine();
  const plain = one(await check(none, project(none)), "proxy");
  assert.equal(plain.state, "ready");
  assert.equal(plain.why, undefined, "with no proxy variable there is nothing to add");
});

test("NODE_USE_ENV_PROXY=1 on a Node.js that reads the proxy variables itself: the doctor says Node.js does the proxying", async () => {
  const m = machine({ env: { HTTPS_PROXY: "http://proxy.corp.example:3128", NODE_USE_ENV_PROXY: "1" } });
  const dir = project(m);
  assert.equal(one(await check(m, dir, { nodeVersion: "24.16.0" }), "proxy").why, "through proxy.corp.example:3128, from HTTPS_PROXY, by Node.js itself (NODE_USE_ENV_PROXY=1)");
  assert.equal(one(await check(m, dir, { nodeVersion: "20.19.0" }), "proxy").why, "through proxy.corp.example:3128, from HTTPS_PROXY");
});

test("NO_PROXY naming GitHub's host: the doctor says GitHub is asked directly", async () => {
  const m = machine({ env: { HTTPS_PROXY: "http://proxy.corp.example:3128", NO_PROXY: "localhost,.github.com" } });
  const r = one(await check(m, project(m)), "proxy");
  assert.equal(r.state, "ready");
  assert.equal(r.why, "directly: NO_PROXY names GitHub's host");
  // The list is read for the host the channel asks: GitHub Enterprise's, when the plugin is set to one.
  const ghe = machine({ env: { https_proxy: "http://proxy.corp.example:3128", no_proxy: "ghe.corp.example", RUNNERS_IO_GITHUB_API: "https://ghe.corp.example/api/v3" } });
  assert.equal(one(await check(ghe, project(ghe)), "proxy").why, "directly: no_proxy names GitHub's host");
  const other = machine({ env: { https_proxy: "http://proxy.corp.example:3128", no_proxy: "ghe.corp.example" } });
  assert.equal(one(await check(other, project(other)), "proxy").why, "through proxy.corp.example:3128, from https_proxy");
});

test("a proxy the plugin cannot use (SOCKS, or no address at all): it blocks, since no request is made rather than one around the proxy, and the value is never repeated", async () => {
  for (const value of ["socks5://ada:s3cr3t-pa55@proxy.corp.example:1080", "http://"]) {
    const m = machine({ env: { HTTPS_PROXY: value } });
    const r = one(await check(m, project(m)), "proxy");
    assert.equal(r.effect, "blocks", value);
    assert.equal(r.once, undefined, "a blocker is said at every launch until it is fixed");
    assert.equal(r.line, "HTTPS_PROXY names a proxy the plugin can't use (it uses http:// and https:// proxies only), so it makes no request and CI can't be read.");
    assert.match(r.fix, /^Nothing to install\./);
    assert.match(r.fix, /never goes around a proxy it was told to use/);
    assert.match(r.fix, /sets the variable to their proxy's http:\/\/ or https:\/\/ address, or names GitHub's host in `NO_PROXY`/);
    assert.match(r.fix, /Never print the variable's value/);
    assert.equal(/s3cr3t|ada|proxy\.corp/.test(JSON.stringify(r)), false);
  }
  // Named in NO_PROXY, GitHub's host is asked directly: the user's own instruction, and nothing to fix.
  const named = machine({ env: { HTTPS_PROXY: "socks5://proxy.corp.example:1080", NO_PROXY: "api.github.com" } });
  assert.equal(one(await check(named, project(named)), "proxy").why, "directly: NO_PROXY names GitHub's host");
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

test("a fork GitHub reported, recorded for one project: the doctor says its pull request is looked for on the parent, there and in no other project", async () => {
  const m = machine();
  recordFirstCall(m.env, "fork", { project: projectKey("/work/fork"), now: T0 });
  const record = readFirstCall(m.env, T0);
  const r = one(firstCallRows(record, { env: m.env, projectDir: "/work/fork" }), "fork");
  assert.equal(r.state, "ready");
  assert.match(r.why, /^GitHub says this repository is a fork: the branch's pull request is looked for on the repository it was forked from first/);
  assert.equal(one(firstCallRows(record, { env: m.env, projectDir: "/work/other" }), "fork"), undefined);
  // Beside the launch's own plain "ready", the row that says why is the one shown.
  const dir = project(m);
  recordFirstCall(m.env, "fork", { project: projectKey(dir), now: T0 });
  const rows = mergeRows(await check(m, dir), firstCallRows(readFirstCall(m.env, T0), { env: m.env, projectDir: dir }));
  assert.equal(rows.filter((x) => x.id === "fork").length, 1);
  assert.match(one(rows, "fork").why, /^GitHub says this repository is a fork/);
  assert.deepEqual(notReady(rows), []);
});

test("of two ready rows for one check, the one that says why is kept; a NOT READY row still wins over both", () => {
  const plain = { id: "x", label: "x", state: "ready" };
  const why = { id: "x", label: "x", state: "ready", why: "because" };
  const bad = { id: "x", label: "x", state: "not_ready", effect: "info", line: "l", fix: "f" };
  assert.deepEqual(mergeRows([plain], [why]), [why]);
  assert.deepEqual(mergeRows([why], [plain]), [why]);
  assert.deepEqual(mergeRows([why], [bad]), [bad]);
  assert.deepEqual(mergeRows([bad], [why]), [bad]);
});

// ---- live CI events that cannot arrive, whatever flag the session is started with ---------------------------------

test("Claude Code on Amazon Bedrock, Google Cloud or Microsoft Foundry: live CI events are not available there, said once per project, with nothing to install", async () => {
  for (const [name, provider] of [
    ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
    ["CLAUDE_CODE_USE_MANTLE", "Amazon Bedrock"],
    ["CLAUDE_CODE_USE_VERTEX", "Google Cloud's Agent Platform (Vertex AI)"],
    ["CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry"],
  ]) {
    const m = machine({ env: { [name]: "1" } });
    const r = one(await check(m, project(m)), "live_events");
    assert.equal(r.effect, "info", name);
    assert.equal(r.line, `Claude Code is set to use ${provider} (${name}), where live CI events are not available; CI on request (ci_status) still works.`);
    assert.match(r.fix, /^Nothing to install\./);
    assert.match(r.fix, /a claude\.ai account or a Claude Console API key/);
    assert.match(r.fix, /Do not offer the channel flag or claude-gh/);
  }
  for (const on of ["true", "TRUE", "yes", "on"]) {
    const m = machine({ env: { CLAUDE_CODE_USE_BEDROCK: on } });
    assert.equal(one(await check(m, project(m)), "live_events").state, "not_ready", on);
  }
  for (const off of ["0", "false", "", "no", "off"]) {
    const m = machine({ env: { CLAUDE_CODE_USE_BEDROCK: off } });
    assert.equal(one(await check(m, project(m)), "live_events").state, "ready", `"${off}" is off`);
  }
});

test("an API key is no reason: Claude Code takes channels with a Console API key as with a claude.ai login", async () => {
  const m = machine({ env: { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key", ANTHROPIC_AUTH_TOKEN: "x" } });
  const rows = await check(m, project(m));
  assert.equal(one(rows, "live_events").state, "ready");
  assert.deepEqual(notReady(rows), []);
  assert.equal(JSON.stringify(rows).includes("sk-ant"), false);
});

test("started with the channel flag where live events cannot arrive: no longer a once-only note, since it blocks what the user is trying to use", async () => {
  const m = machine({ env: { CLAUDE_CODE_USE_VERTEX: "1" } });
  const dir = project(m);
  const on = one(await check(m, dir, { launchState: "on" }), "live_events");
  assert.equal(on.effect, "degrades");
  assert.match(on.line, /^Claude Code is set to use Google Cloud's Agent Platform \(Vertex AI\) \(CLAUDE_CODE_USE_VERTEX\), where live CI events are not available, so this session's channel flag brings none;/);
  for (const state of ["off", "unknown", undefined]) assert.equal(one(await check(m, dir, { launchState: state }), "live_events").effect, "info", String(state));
  // At launch: said at every start with the flag, and once only without it.
  const first = await setupFor({ cwd: dir }, m.env, { platform: "linux", now: T0, launchState: "on" });
  const second = await setupFor({ cwd: dir }, m.env, { platform: "linux", now: T0 + 1000, launchState: "on" });
  assert.match(first.line, /^runners\.io: Claude Code is set to use Google Cloud/);
  assert.equal(second.line, first.line);
  const other = machine({ env: { CLAUDE_CODE_USE_VERTEX: "1" } });
  const otherDir = project(other);
  assert.match((await setupFor({ cwd: otherDir }, other.env, { platform: "linux", now: T0, launchState: "off" })).line, /live CI events are not available; CI on request/);
  assert.equal(await setupFor({ cwd: otherDir }, other.env, { platform: "linux", now: T0 + 1000, launchState: "off" }), null, "said once in the project");
});

test("an organisation's managed settings file that does not switch channels on: said once, as probable, with who can change it", async () => {
  const m = machine();
  const dir = project(m);
  const managed = m.env.RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR;
  assert.equal(one(await check(m, dir), "live_events").state, "ready", "no managed settings on the machine: nothing to say");
  writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }));
  const r = one(await check(m, dir), "live_events");
  assert.equal(r.effect, "info");
  assert.equal(
    r.line,
    "this machine has Claude Code settings managed by an organisation, and they do not switch channels on (channelsEnabled), so live CI events are probably blocked here; CI on request (ci_status) still works.",
  );
  assert.match(r.fix, /^Nothing for the user to install\./);
  assert.match(r.fix, /Owner/);
  assert.match(r.fix, /cannot be read from here/);
  // Started with the channel flag it is still a note: Claude Code says so itself at start when channels are blocked.
  assert.equal(one(await check(m, dir, { launchState: "on" }), "live_events").effect, "info");
  writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({ channelsEnabled: true }));
  assert.equal(one(await check(m, dir), "live_events").state, "ready");
});

test("managed settings are read as Claude Code reads them: the file first, then each drop-in in name order, and only what is plainly there", async () => {
  const m = machine();
  const dir = project(m);
  const managed = m.env.RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR;
  const state = async () => one(await check(m, dir), "live_events").state;
  mkdirSync(join(managed, "managed-settings.d"));
  writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({ channelsEnabled: false }));
  writeFileSync(join(managed, "managed-settings.d", "10-channels.json"), JSON.stringify({ channelsEnabled: true }));
  assert.equal(await state(), "ready", "a drop-in sets the key after the file");
  writeFileSync(join(managed, "managed-settings.d", "20-off.json"), JSON.stringify({ channelsEnabled: false }));
  assert.equal(await state(), "not_ready", "the later drop-in wins");
  writeFileSync(join(managed, "managed-settings.d", "20-off.json"), JSON.stringify({ model: "x" }));
  assert.equal(await state(), "ready", "a drop-in that does not set the key leaves it as it was");
  writeFileSync(join(managed, "managed-settings.d", ".30-hidden.json"), JSON.stringify({ channelsEnabled: false }));
  writeFileSync(join(managed, "managed-settings.d", "40-notes.txt"), JSON.stringify({ channelsEnabled: false }));
  assert.equal(await state(), "ready", "hidden files and files that are not .json are not read");
  // A file that cannot be understood is no reading at all: nothing is claimed from it.
  rmSync(join(managed, "managed-settings.d"), { recursive: true });
  writeFileSync(join(managed, "managed-settings.json"), "{ not json");
  assert.equal(await state(), "ready");
  writeFileSync(join(managed, "managed-settings.json"), JSON.stringify(["channelsEnabled"]));
  assert.equal(await state(), "ready");
});

test("a provider where channels are not available is said, not the managed settings as well: one reason is enough", async () => {
  const m = machine({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
  writeFileSync(join(m.env.RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR, "managed-settings.json"), JSON.stringify({}));
  const rows = await check(m, project(m));
  assert.equal(rows.filter((r) => r.id === "live_events").length, 1);
  assert.match(one(rows, "live_events").line, /Amazon Bedrock/);
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
