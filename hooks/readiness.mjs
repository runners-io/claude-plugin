#!/usr/bin/env node
// Setup checks: whether this machine is ready to run the plugin, and what to offer when it is not.
//
//   node readiness.mjs check            every local check and what GitHub last answered, as a ready / NOT READY table
//   node readiness.mjs decline <id>...  records the user's no, so those fixes are not offered again for 7 days
//
// Three callers share this one module, so a check reads the same wherever it is shown:
//   - the SessionStart hook (session-start.mjs) runs the LAUNCH checks at every launch. They are local: programs on
//     PATH, gh's stored login, git in the session's folder, the environment, the plugin's own folders. No network.
//   - the channel records what GITHUB ANSWERS on its calls (a refused login, a missing scope, a single sign-on
//     refusal, a certificate that does not verify) in a small file, which the next launch reads. The file holds kinds,
//     counts and times only: no token, no repository or organisation name, no response body.
//   - the channel's `status` command, which the doctor skill runs, prints every check with one live GitHub call.
//
// A check answers with a row: ready, not_ready (with its effect, one sentence for the user, and the fix Claude should
// OFFER, asking first), unknown, or skipped. `blocks` means the plugin cannot read CI at all, `degrades` that part of
// it works, `info` that there is nothing to fix.
//
// Dependency-free plain JavaScript, Node 20.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findProgram } from "./programs.mjs";
import { nodeProxiesItself, proxyFor, readsGitHubCom, sendRefusal } from "./proxy.mjs";

/** `1` turns the offers off: nothing is offered, and only a blocker's one-line notice is still shown. */
export const OPT_OUT = "RUNNERS_IO_NO_SETUP_CHECKS";
/** After the user says no to a fix, it is not offered again for this long. */
export const DECLINE_FOR_MS = 7 * 24 * 60 * 60_000;
/** What GitHub answered is believed this long; an older record says nothing about the login as it is now. */
export const FIRST_CALL_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"];
const ENTERPRISE_TOKEN_VARS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const RANK = { blocks: 0, degrades: 1, info: 2 };

// ---- where things are ---------------------------------------------------------------------------------------------

function home(env) {
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
}

/**
 * The plugin's state folder: $XDG_STATE_HOME/runners-io, else ~/.local/state/runners-io. The same folder the
 * claude-gh answer is kept in, and never CLAUDE_PLUGIN_DATA: the hook, the channel and a command Claude runs must all
 * find the same files, and only some of them are given that variable. null when there is no absolute path to use.
 */
export function stateRoot(env = process.env) {
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, "runners-io");
  const h = home(env);
  return h && isAbsolute(h) ? join(h, ".local", "state", "runners-io") : null;
}

/** The folder the channel shares its GitHub reads in (shared.ts). */
function cacheRoot(env) {
  return join(env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home(env), ".cache"), "runners-io");
}

/** A project folder as 16 hex characters: what a per-project answer is filed under, so no file names a folder. */
export function projectKey(dir) {
  return createHash("sha256").update(resolve(String(dir))).digest("hex").slice(0, 16);
}

/** The GitHub host whose login the channel uses: github.com, or the host of RUNNERS_IO_GITHUB_API. */
export function loginHost(env = process.env) {
  try {
    const host = new URL(env.RUNNERS_IO_GITHUB_API || "https://api.github.com").host;
    return host === "api.github.com" ? "github.com" : host;
  } catch {
    return "github.com";
  }
}

/** The host as it may be put into a sentence or a command: a name GitHub could have, or plain github.com. */
function sayable(host) {
  return /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? host : "github.com";
}

/** A path for one line of text: no control character, and not endless. */
function onOneLine(path) {
  return String(path).replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
}

/** The variable whose token the channel uses in place of gh's login, or null: the channel's own rule (github.ts). */
export function tokenVariable(env = process.env, host = loginHost(env)) {
  const names = host === "github.com" ? TOKEN_VARS : (env.GH_HOST ?? "").trim().toLowerCase() === host.toLowerCase() ? ENTERPRISE_TOKEN_VARS : [];
  return names.find((n) => (env[n] ?? "").trim()) ?? null;
}

/** A program's absolute path from PATH's absolute folders, or null (programs.mjs). Nothing is run. */
export const which = findProgram;

/** One command, no shell, a fixed argv and a short limit. `said`: whether it printed anything; the text is not kept. */
function run(file, args, { env, timeoutMs = 2500, keep = true } = {}) {
  return new Promise((done) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      const text = String(stdout ?? "").trim();
      done({ ok: !error, timedOut: Boolean(error && error.killed), said: text !== "", stdout: keep ? text : "" });
    });
  });
}

// ---- git remotes --------------------------------------------------------------------------------------------------

const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** `owner/name` for a github.com remote, else null. */
export function githubRepo(url) {
  const m = GITHUB_REMOTE.exec(String(url ?? "").trim());
  return m && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : null;
}

/** The host a remote URL names, lower case, or null for a local path. */
export function remoteHost(url) {
  const text = String(url ?? "").trim();
  const m =
    /^(?!file:)[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]{2,253})(?::\d+)?(?:\/|$)/i.exec(text) ??
    /^(?:[^@/\s:]+@)?([A-Za-z0-9.-]{2,253}):(?!\/\/|\\)/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

const NOT_GITHUB = /gitlab|bitbucket|gitea|codeberg|azure|visualstudio\.com|sourceforge|(^|\.)sr\.ht$/;

/**
 * Whether a host that is not github.com is a GitHub Enterprise one the USER has set up: gh is signed in to it, GH_HOST
 * names it, or the plugin is already set to read it. Never because the host's own name says so. The remote is text
 * the repository chose, and this answer decides whether Claude offers to point the plugin's API setting, and a
 * `gh auth login`, at that host: a clone of a stranger's repository must not be able to ask for that.
 */
function looksEnterprise(host, env, ghHosts) {
  if (NOT_GITHUB.test(host)) return false;
  return ghHosts.includes(host) || (env.GH_HOST ?? "").trim().toLowerCase() === host || loginHost(env).toLowerCase() === host;
}

// ---- gh's own list of accounts ------------------------------------------------------------------------------------

/** gh's settings folder, the way gh picks it. */
export function ghConfigDir(env = process.env, platform = process.platform) {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh");
  const appData = env.APPDATA ?? env.AppData;
  if (platform === "win32" && appData) return join(appData, "GitHub CLI");
  return join(home(env), ".config", "gh");
}

/**
 * The hosts gh is signed in to, and each one's accounts, from the text of gh's hosts.yml. Only names are read: a
 * token an older gh kept in the file is never looked at. The file is small and regular, so this reads its
 * indentation and needs no YAML parser.
 */
export function ghAccounts(text) {
  const hosts = {};
  let host = null;
  let inUsers = false;
  let usersIndent = 0;
  let childIndent = -1;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^\s*([A-Za-z0-9._:-]+?):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (indent === 0) {
      host = { users: [], active: null };
      hosts[m[1].toLowerCase()] = host;
      inUsers = false;
      continue;
    }
    if (!host) continue;
    if (inUsers && indent > usersIndent) {
      if (childIndent < 0) childIndent = indent;
      if (indent === childIndent && /^[A-Za-z0-9_-]{1,60}$/.test(m[1])) host.users.push(m[1]);
      continue;
    }
    inUsers = false;
    if (m[1] === "users" && m[2] === "") {
      inUsers = true;
      usersIndent = indent;
      childIndent = -1;
    } else if (m[1] === "user") {
      const name = m[2].replace(/^["']|["']$/g, "");
      if (/^[A-Za-z0-9_-]{1,60}$/.test(name)) host.active = name;
    }
  }
  return hosts;
}

function readGhHosts(env, platform) {
  const file = join(ghConfigDir(env, platform), "hosts.yml");
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return { hosts: {}, changedAt: null };
    return { hosts: ghAccounts(readFileSync(file, "utf8")), changedAt: st.mtimeMs };
  } catch {
    return { hosts: {}, changedAt: null };
  }
}

// ---- the plugin's own folders -------------------------------------------------------------------------------------

/** A real folder (not a symlink) owned by this user. */
function ownFolder(dir) {
  const st = lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid());
}

/** Whether a file can be written in the folder: it is made if missing, a file is written and taken away again. */
function writable(dir) {
  const probe = join(dir, `.writable-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "", { mode: 0o600 });
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readJson(root, name) {
  try {
    if (!root || !ownFolder(root)) return null;
    const st = lstatSync(join(root, name));
    if (!st.isFile() || st.size > 256 * 1024 || (process.getuid !== undefined && st.uid !== process.getuid())) return null;
    const value = JSON.parse(readFileSync(join(root, name), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A 0600 file in a 0700 folder of this user's, replaced in one step, never through a symlink. false: not written. */
function writeJson(root, name, value) {
  if (!root) return false;
  const tmp = join(root, `.${name}.${process.pid}`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!ownFolder(root)) return false;
    const file = join(root, name);
    try {
      if (lstatSync(file).isSymbolicLink()) rmSync(file);
    } catch {}
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

// ---- what GitHub answered: written by the channel, read at the next launch ----------------------------------------

const FIRST_CALL_FILE = "first-call.json";
/** `ok` is a good answer; the rest are refusals. `fork` is about one project, so it is filed under the project's key. */
export const FIRST_CALL_KINDS = ["ok", "token_rejected", "cert_error", "no_repo_scope", "sso", "forbidden", "fork"];
const PER_PROJECT = new Set(["fork"]);
const KEY = /^[0-9a-f]{16}$/;
const MAX_PROJECTS = 100;
const MAX_OWNERS = 20;

function entryOf(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const { n, first, last, source, owners } = raw;
  if (![n, first, last].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  if (last - now > 60_000 || now - last > FIRST_CALL_MAX_AGE_MS) return null;
  return {
    n: Math.max(1, Math.floor(n)),
    first,
    last,
    ...(source === "env" || source === "gh" ? { source } : {}),
    ...(Array.isArray(owners) ? { owners: owners.filter((o) => typeof o === "string" && KEY.test(o)).slice(0, MAX_OWNERS) } : {}),
  };
}

function kindsOf(raw, now, allowed) {
  const out = {};
  for (const kind of FIRST_CALL_KINDS) {
    if (!allowed(kind)) continue;
    const e = entryOf(raw?.[kind], now);
    if (e) out[kind] = e;
  }
  return out;
}

/** The record as it stands: only known kinds, only numbers and the two source words, nothing older than a week. */
export function readFirstCall(env = process.env, now = Date.now()) {
  const raw = readJson(stateRoot(env), FIRST_CALL_FILE);
  const projects = {};
  for (const [key, value] of Object.entries(raw?.projects && typeof raw.projects === "object" ? raw.projects : {})) {
    if (!KEY.test(key)) continue;
    const kinds = kindsOf(value, now, (k) => PER_PROJECT.has(k));
    if (Object.keys(kinds).length) projects[key] = kinds;
  }
  return { kinds: kindsOf(raw?.kinds, now, (k) => !PER_PROJECT.has(k)), projects };
}

function writeFirstCall(env, record) {
  const keep = Object.entries(record.projects)
    .sort((a, b) => Math.max(...Object.values(b[1]).map((e) => e.last)) - Math.max(...Object.values(a[1]).map((e) => e.last)))
    .slice(0, MAX_PROJECTS);
  return writeJson(stateRoot(env), FIRST_CALL_FILE, { v: 1, kinds: record.kinds, projects: Object.fromEntries(keep) });
}

/** An organisation or user name as 16 hex characters: enough to tell two apart, and not the name. */
export function ownerKey(owner) {
  return createHash("sha256").update(String(owner).toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * Notes one answer from GitHub. `source` is where the token came from (`env` or `gh`); `owner` is an ownerKey, for a
 * refusal that is about one organisation; `project` a projectKey, for the per-project kinds. false: not written.
 */
export function recordFirstCall(env, kind, { source, owner, project, now = Date.now() } = {}) {
  if (!FIRST_CALL_KINDS.includes(kind)) return false;
  const record = readFirstCall(env, now);
  let slot = record.kinds;
  if (PER_PROJECT.has(kind)) {
    if (!project || !KEY.test(project)) return false;
    record.projects[project] ??= {};
    slot = record.projects[project];
  }
  const was = slot[kind];
  const owners = [...new Set([...(was?.owners ?? []), ...(owner && KEY.test(owner) ? [owner] : [])])].slice(-MAX_OWNERS);
  slot[kind] = {
    n: (was?.n ?? 0) + 1,
    first: was?.first ?? now,
    last: now,
    ...(source === "env" || source === "gh" ? { source } : {}),
    ...(owners.length ? { owners } : {}),
  };
  return writeFirstCall(env, record);
}

/**
 * Takes kinds off the record, because GitHub has since answered well. With `owner`, a kind that lists owners loses
 * only that one, and goes when none is left. false: nothing changed, or not written.
 */
export function clearFirstCall(env, kinds, { owner, project, now = Date.now() } = {}) {
  const record = readFirstCall(env, now);
  let changed = false;
  for (const kind of kinds) {
    const slot = PER_PROJECT.has(kind) ? record.projects[project ?? ""] : record.kinds;
    const was = slot?.[kind];
    if (!was) continue;
    if (owner && was.owners?.length) {
      if (!was.owners.includes(owner)) continue;
      const left = was.owners.filter((o) => o !== owner);
      if (left.length) slot[kind] = { ...was, owners: left };
      else delete slot[kind];
    } else {
      delete slot[kind];
    }
    changed = true;
  }
  for (const [key, value] of Object.entries(record.projects)) if (!Object.keys(value).length) delete record.projects[key];
  return changed ? writeFirstCall(env, record) : false;
}

// ---- the checks ---------------------------------------------------------------------------------------------------

const ready = (id, label) => ({ id, label, state: "ready" });
const skipped = (id, label, why) => ({ id, label, state: "skipped", why });
const unknown = (id, label, why) => ({ id, label, state: "unknown", why });
const found = (id, label, effect, line, fix, more = {}) => ({ id, label, state: "not_ready", effect, line, fix, ...more });

const FORK_LABEL = "a fork's pull request on the repository it was forked from is found";

const USERS_COMMAND = "is the user's own command: ask them to type it in the prompt with a leading `!`, so it runs in this session";

function installHint(what, platform) {
  const gh = what === "gh";
  if (platform === "darwin") {
    return gh
      ? "on macOS `brew install gh` when Homebrew is there (`brew --version`), else the installer at https://cli.github.com"
      : "on macOS `xcode-select --install` (it opens a dialog, so it is the user's to run as `! xcode-select --install`), or `brew install git`";
  }
  if (platform === "win32") return gh ? "on Windows `winget install --id GitHub.cli`" : "on Windows `winget install --id Git.Git`";
  return gh
    ? "on Debian or Ubuntu the apt steps at https://github.com/cli/cli/blob/trunk/docs/install_linux.md, on Fedora or RHEL `sudo dnf install gh`; " +
        "both need sudo, so they are the user's to run as `! <command>`"
    : "on Debian or Ubuntu `sudo apt-get install git`, on Fedora or RHEL `sudo dnf install git`; both need sudo, so they are the user's to run as `! <command>`";
}

function signInFix(host) {
  return (
    "Signing in opens a browser and asks for a one-time code, so it " +
    `${USERS_COMMAND}: \`! gh auth login --hostname ${host} --web --scopes repo\`. Never ask for a token, and never put one on a command line.`
  );
}

// ---- live CI events that cannot arrive --------------------------------------------------------------------------

/**
 * Where Claude Code does not deliver channel events at all. Its documentation (Channels): channels "require Anthropic
 * authentication through claude.ai or a Console API key, and are not available on Amazon Bedrock, Google Cloud's
 * Agent Platform, or Microsoft Foundry". These are the variables that switch Claude Code to one of those (its
 * environment variables reference). An API key is no reason: a Console API key takes channels.
 */
const PROVIDERS = [
  ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
  ["CLAUDE_CODE_USE_MANTLE", "Amazon Bedrock"],
  ["CLAUDE_CODE_USE_VERTEX", "Google Cloud's Agent Platform (Vertex AI)"],
  ["CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry"],
];
/** How Claude Code reads an on/off variable: these four words, in any case. */
const ON = new Set(["1", "true", "yes", "on"]);

/** The provider this session's Claude Code is set to that takes no channels, with the variable that says so, or null. */
export function liveEventsBlocker(env = process.env) {
  for (const [variable, provider] of PROVIDERS) if (ON.has((env[variable] ?? "").trim().toLowerCase())) return { variable, provider };
  return null;
}

/**
 * The folder an organisation's managed Claude Code settings file is in, as Claude Code's documentation gives it for
 * each system. RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR is the tests' own: a folder of theirs, so the real machine's
 * settings are never read by a test.
 */
function managedSettingsDir(env, platform) {
  if (env.RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR && isAbsolute(env.RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR)) return env.RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR;
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

function settingsFile(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What the machine's managed settings FILES say of `channelsEnabled`: true, false, "unset" when there are such files
 * and none sets it, or null when there is no file to read (or none that can be understood). Read as Claude Code
 * reads them: managed-settings.json first, then each *.json in managed-settings.d in name order, hidden files left
 * out, a later file's value over an earlier one's.
 *
 * Only the files are read. An organisation can also deliver settings from the claude.ai admin console or by device
 * management, which rank above the files and cannot be read from here, so a "not switched on" from the files is
 * probable, never certain.
 */
export function managedChannels(env = process.env, platform = process.platform) {
  const dir = managedSettingsDir(env, platform);
  const files = [join(dir, "managed-settings.json")];
  try {
    for (const name of readdirSync(join(dir, "managed-settings.d")).sort()) if (!name.startsWith(".") && name.endsWith(".json")) files.push(join(dir, "managed-settings.d", name));
  } catch {}
  let read = 0;
  let value = "unset";
  for (const file of files) {
    const settings = settingsFile(file);
    if (!settings) continue;
    read++;
    if (typeof settings.channelsEnabled === "boolean") value = settings.channelsEnabled;
  }
  return read ? value : null;
}

/**
 * Whether Claude Code can deliver live CI events here at all. Two things say no, and neither is fixed by the channel
 * flag: a provider that takes no channels (certain: said at every launch when the session was started with the flag,
 * `launchState` "on", since it blocks what the user is trying to use; otherwise once per project), and an
 * organisation's managed settings that do not switch channels on (probable: once per project). What cannot be read
 * from this machine is never claimed: a claude.ai Team or Enterprise organisation that has not switched channels on
 * in its admin console looks, from here, like any other login. Claude Code says so itself at start.
 */
function liveEventsRow(env, platform, launchState) {
  const id = "live_events";
  const label = "Claude Code can deliver live CI events here";
  const blocker = liveEventsBlocker(env);
  if (blocker) {
    const flagOn = launchState === "on";
    return found(
      id,
      label,
      flagOn ? "degrades" : "info",
      `Claude Code is set to use ${blocker.provider} (${blocker.variable}), where live CI events are not available` +
        `${flagOn ? ", so this session's channel flag brings none" : ""}; CI on request (ci_status) still works.`,
      "Nothing to install. Claude Code delivers a channel's events only when it is signed in to Anthropic itself (a claude.ai account or a Claude Console API key), and not on Amazon Bedrock, " +
        "Google Cloud's Agent Platform (Vertex AI) or Microsoft Foundry. Do not offer the channel flag or claude-gh here: neither brings live events. " +
        "When the user asks about CI, read it with the runners-io ci_status tool.",
    );
  }
  if ([false, "unset"].includes(managedChannels(env, platform))) {
    return found(
      id,
      label,
      "info",
      "this machine has Claude Code settings managed by an organisation, and they do not switch channels on (channelsEnabled), so live CI events are probably blocked here; CI on request (ci_status) still works.",
      "Nothing for the user to install. Channels are switched on for an organisation by an Owner (in the claude.ai admin console: Organization settings, Claude Code, Channels) or by " +
        "`channelsEnabled: true` in its managed settings. Settings an organisation delivers from the admin console or by device management cannot be read from here and rank above this " +
        "machine's settings file, so this may already be done: when channels are blocked, Claude Code says so in a notice at start. Meanwhile read CI with the runners-io ci_status tool when asked.",
    );
  }
  return ready(id, label);
}

/**
 * The LAUNCH checks: local, no network call, well under a second (each command has a 2.5 s limit of its own, and
 * they run side by side). One row per check, in the order they are listed to the user.
 */
export async function launchChecks({ env = process.env, projectDir = env.CLAUDE_PROJECT_DIR || process.cwd(), platform = process.platform, launchState, nodeVersion = process.versions.node } = {}) {
  const rows = [];
  const host = loginHost(env);
  const hostOk = sayable(host) === host;
  const gh = which("gh", env, platform);
  const git = which("git", env, platform);
  const tokenVar = tokenVariable(env, host);
  // gh's own stored login, asked with the token variables taken away: with one set, gh would only say it back.
  const bare = Object.fromEntries(Object.entries(env).filter(([k]) => !TOKEN_VARS.includes(k) && !ENTERPRISE_TOKEN_VARS.includes(k)));
  const inFolder = (args) => (git ? run(git, ["-C", projectDir, ...args], { env }) : Promise.resolve(null));
  const [stored, top, origin, upstream] = await Promise.all([
    gh && hostOk ? run(gh, ["auth", "token", "--hostname", host], { env: bare, keep: false }) : Promise.resolve(null),
    inFolder(["rev-parse", "--show-toplevel"]),
    inFolder(["remote", "get-url", "origin"]),
    inFolder(["remote", "get-url", "upstream"]),
  ]);
  const signedIn = stored ? stored.ok && stored.said : false;
  const gho = gh ? readGhHosts(env, platform) : { hosts: {}, changedAt: null };

  // 1. the GitHub CLI
  const ghLabel = "the GitHub CLI (gh) is installed";
  if (gh) rows.push(ready("gh_missing", ghLabel));
  else if (tokenVar) {
    rows.push(
      found(
        "gh_missing",
        ghLabel,
        "degrades",
        `the GitHub CLI (gh) isn't installed: CI is read with the token in ${tokenVar}, but Claude reads a failed job's log with gh.`,
        `Offer to install the GitHub CLI, asking first, by the /runners-io:setup-github skill's step 2 (${installHint("gh", platform)}).`,
      ),
    );
  } else {
    rows.push(
      found(
        "gh_missing",
        ghLabel,
        "blocks",
        "the GitHub CLI isn't installed, so CI can't be read. Ask me to set it up.",
        `Offer to install the GitHub CLI, asking first, by the /runners-io:setup-github skill's step 2 (${installHint("gh", platform)}). ` +
          "Then the user signs in (the skill's step 3).",
      ),
    );
  }

  // 2. gh's login
  const loginLabel = `gh is signed in to ${sayable(host)}`;
  if (!gh) rows.push(skipped("gh_signed_out", loginLabel, "gh is not installed"));
  else if (stored?.timedOut) rows.push(unknown("gh_signed_out", loginLabel, "gh did not answer in time"));
  else if (signedIn) rows.push(ready("gh_signed_out", loginLabel));
  else if (tokenVar) rows.push(skipped("gh_signed_out", loginLabel, `the token in ${tokenVar} is used`));
  else {
    rows.push(
      found("gh_signed_out", loginLabel, "blocks", `the GitHub CLI isn't signed in to ${sayable(host)}, so CI can't be read. Ask me to help you sign in.`, signInFix(sayable(host))),
    );
  }

  // 3. a token variable in place of gh's own login
  const tokenLabel = "no token variable takes the place of gh's login";
  if (tokenVar && signedIn) {
    rows.push(
      found(
        "token_env",
        tokenLabel,
        "degrades",
        `${tokenVar} is set, so GitHub is read with that token and not with gh's own login.`,
        `Say which variable is in use (${tokenVar}; never print its value). Nothing needs doing while CI is read without trouble. If a private ` +
          "repository is not found or CI reads are refused, the token lacks access: the user either starts Claude Code without the variable " +
          `(\`env -u ${tokenVar} claude\`), or gives the token read access to the repository's Actions and pull requests.`,
        { once: true, tokenVar },
      ),
    );
  } else rows.push(ready("token_env", tokenLabel));

  // 4. several gh accounts
  const accountsLabel = "gh holds one account for the host";
  const accounts = gho.hosts[host.toLowerCase()] ?? { users: [], active: null };
  if (!gh) rows.push(skipped("several_accounts", accountsLabel, "gh is not installed"));
  else if (accounts.users.length > 1) {
    rows.push(
      found(
        "several_accounts",
        accountsLabel,
        "degrades",
        `gh holds ${accounts.users.length} accounts for ${sayable(host)}, and the plugin reads CI as the active one` +
          `${accounts.active ? ` (${accounts.active})` : ""}, which may not be the one your pull requests belong to.`,
        `Nothing needs doing when the active account is the right one. To change it, after a yes run \`gh auth switch --hostname ${sayable(host)}\` ` +
          "(with `--user <login>` when there are more than two), then check with `gh auth status`.",
        { once: true },
      ),
    );
  } else rows.push(ready("several_accounts", accountsLabel));

  // 5. git, and where the session is
  const gitLabel = "git is installed";
  const repoLabel = "the session's folder is a git repository";
  const remoteLabel = "the repository's origin is on github.com";
  const workflowsLabel = "the repository has GitHub Actions workflows";
  const forkLabel = FORK_LABEL;
  if (!git) {
    rows.push(
      found(
        "git_missing",
        gitLabel,
        "blocks",
        "git isn't installed, so the plugin can't tell which repository and branch you are on. Ask me to set it up.",
        `Offer to install git, asking first: ${installHint("git", platform)}. Confirm with \`git --version\`.`,
      ),
    );
    for (const [id, label] of [["not_a_repo", repoLabel], ["no_github_remote", remoteLabel], ["no_workflows", workflowsLabel], ["fork", forkLabel]]) {
      rows.push(skipped(id, label, "git is not installed"));
    }
  } else {
    rows.push(ready("git_missing", gitLabel));
    const onGitHubCom = origin?.ok ? githubRepo(origin.stdout) : null;
    // A github.com repository is looked up only while the plugin reads github.com (proxy.mjs readsGitHubCom).
    const repo = readsGitHubCom(env) ? onGitHubCom : null;
    if (!top?.ok) {
      rows.push(
        top?.timedOut
          ? unknown("not_a_repo", repoLabel, "git did not answer in time")
          : found(
              "not_a_repo",
              repoLabel,
              "info",
              "this folder isn't a git repository, so there is no pull request to watch here; CI on request still works for a repository you name.",
              "Nothing to fix. The runners-io ci_status and subscribe tools take a repository and a pull request by name.",
            ),
      );
      for (const [id, label] of [["no_github_remote", remoteLabel], ["no_workflows", workflowsLabel], ["fork", forkLabel]]) rows.push(skipped(id, label, "not a git repository"));
    } else {
      rows.push(ready("not_a_repo", repoLabel));
      const originHost = origin?.ok ? remoteHost(origin.stdout) : null;
      if (repo) rows.push(ready("no_github_remote", remoteLabel));
      else if (onGitHubCom) {
        rows.push(
          found(
            "host_mismatch",
            "the repository's origin is on the GitHub host the plugin reads",
            "degrades",
            `this repository is on github.com, but the plugin is set to read ${sayable(host)} (RUNNERS_IO_GITHUB_API), so its pull requests are not looked up: a repository is only ever asked of its own host.`,
            "Nothing to install. To watch this repository, the user starts Claude Code without `RUNNERS_IO_GITHUB_API` in its environment, so that the plugin reads github.com. " +
              `While the variable is set, the plugin reads ${sayable(host)} and nothing else: a repository and pull request there are named to the runners-io subscribe and ci_status tools. ` +
              "Never suggest pointing the variable at another address.",
            { once: true },
          ),
        );
      } else if (originHost && looksEnterprise(originHost, env, Object.keys(gho.hosts))) {
        rows.push(
          found(
            "enterprise_host",
            remoteLabel,
            "degrades",
            `this repository is on GitHub Enterprise (${originHost}), where the plugin doesn't find your branch's pull request by itself.`,
            `Offer to set it up, asking first: the user sets \`RUNNERS_IO_GITHUB_API\` to the server's https API address (usually https://${originHost}/api/v3) ` +
              `in the environment Claude Code starts from, and signs gh in to it, which ${USERS_COMMAND}: \`! gh auth login --hostname ${originHost} --web\`. ` +
              "Say plainly that the branch's pull request is still not found automatically there: name the repository and pull request to the runners-io subscribe and ci_status tools.",
          ),
        );
      } else {
        rows.push(
          found(
            "no_github_remote",
            remoteLabel,
            "info",
            origin?.ok
              ? "this repository's origin isn't on GitHub, and the plugin reads GitHub Actions only."
              : "this repository has no origin remote, so there is no GitHub repository to watch here yet.",
            "Nothing to fix. The plugin reads CI from GitHub Actions and from nowhere else; once the repository has a github.com origin it is watched without a restart.",
          ),
        );
      }
      if (!repo) {
        const why = onGitHubCom ? "the plugin is set to read another GitHub host" : "no github.com origin";
        rows.push(skipped("no_workflows", workflowsLabel, why), skipped("fork", forkLabel, why));
      } else {
        let workflows = 0;
        try {
          workflows = readdirSync(join(top.stdout, ".github", "workflows")).filter((f) => /\.ya?ml$/i.test(f)).length;
        } catch {}
        rows.push(
          workflows
            ? ready("no_workflows", workflowsLabel)
            : found(
                "no_workflows",
                workflowsLabel,
                "info",
                "this repository has no GitHub Actions workflows (.github/workflows), so there is no CI to watch here yet.",
                "Nothing to fix. Once a workflow file is pushed, its runs on a pull request are reported as they finish.",
              ),
        );
        // A fork is nothing to tell the user about: the channel looks for the branch's pull request on the repository
        // the clone was forked from first (channel/src/forks.ts). The doctor says that it does, and why.
        const parent = upstream?.ok ? githubRepo(upstream.stdout) : null;
        rows.push(
          parent && parent.toLowerCase() !== repo.toLowerCase()
            ? { ...ready("fork", forkLabel), why: "this clone has an upstream remote on GitHub: the branch's pull request is looked for there first, then in the clone's own repository" }
            : ready("fork", forkLabel),
        );
      }
    }
  }

  // 6. a proxy between this machine and GitHub: the channel goes through it, as gh does (proxy.mjs)
  const proxyLabel = "GitHub is reached directly, or through a proxy the channel can use";
  const api = env.RUNNERS_IO_GITHUB_API || "https://api.github.com";
  const route = proxyFor(env, api);
  if (route.kind === "unusable") {
    // Fail closed: with a proxy named that cannot be used, a request sent straight to GitHub would go around it.
    rows.push(
      found(
        "proxy",
        proxyLabel,
        "blocks",
        `${route.variable} names a proxy the plugin can't use (it uses http:// and https:// proxies only), so it makes no request and CI can't be read.`,
        "Nothing to install. The plugin sends its requests through the http:// or https:// proxy named in `HTTPS_PROXY` (or `https_proxy`), as gh does; it cannot use a SOCKS proxy or a " +
          "proxy configuration (PAC) file, and it never goes around a proxy it was told to use. The user sets the variable to their proxy's http:// or https:// address, or names GitHub's host in " +
          "`NO_PROXY` to reach it directly, in the environment Claude Code starts from, then restarts Claude Code. Never print the variable's value: it can hold a password.",
      ),
    );
  } else if (route.kind === "proxy") {
    // The proxy's host and port only: the variable can also hold the proxy's login, which is never shown.
    const byNode = nodeProxiesItself(env, nodeVersion) ? ", by Node.js itself (NODE_USE_ENV_PROXY=1)" : "";
    rows.push({ ...ready("proxy", proxyLabel), why: `through ${route.proxy.display}, from ${route.variable}${byNode}` });
  } else if (route.why === "no_proxy") {
    rows.push({ ...ready("proxy", proxyLabel), why: `directly: ${route.variable} names GitHub's host` });
  } else rows.push(ready("proxy", proxyLabel));

  // 6b. certificate checks: with them off, whoever answers as GitHub would be handed the login, so it is not sent
  const tlsLabel = "certificate checks are on";
  if (sendRefusal(env, api)?.why === "tls_checks_off") {
    rows.push(
      found(
        "tls_checks_off",
        tlsLabel,
        "blocks",
        "NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, so the plugin doesn't send your GitHub login and CI can't be read.",
        "Nothing to install. With certificate checks off, anything on the network could answer as GitHub and be handed the login, so the plugin makes no GitHub request. " +
          "The user unsets `NODE_TLS_REJECT_UNAUTHORIZED` in the environment Claude Code starts from, then restarts Claude Code. If it was set because a company network inspects HTTPS, " +
          "the fix that keeps the checks on is `NODE_EXTRA_CA_CERTS` set to the company's root certificate file (PEM; their IT team has it). Never suggest leaving certificate checks off.",
      ),
    );
  } else rows.push(ready("tls_checks_off", tlsLabel));

  // 7. the plugin's own folders
  const dataLabel = "the plugin's data folders can be written";
  const pluginData = env.CLAUDE_PLUGIN_DATA && isAbsolute(env.CLAUDE_PLUGIN_DATA) ? [env.CLAUDE_PLUGIN_DATA] : [];
  const folders = [stateRoot(env), cacheRoot(env), ...pluginData].filter(Boolean);
  const refused = folders.filter((dir) => !writable(dir));
  if (refused.length) {
    rows.push(
      found(
        "data_dir",
        dataLabel,
        "degrades",
        `the plugin can't write its data folder (${onOneLine(refused[0])}), so what it remembers between sessions is off; reading CI still works.`,
        `Say which folder it is (${refused.map(onOneLine).join(", ")}) and what is off without it: repository scopes, GitHub reads shared between sessions, and remembered answers such as a no to an offer. ` +
          `Making the folder writable is the user's to do. While it is not, a no cannot be remembered: \`${OPT_OUT}=1\` in the environment turns these offers off.`,
        { folders: refused },
      ),
    );
  } else rows.push(ready("data_dir", dataLabel));

  // 8. live CI events that cannot arrive, whatever flag the session is started with
  rows.push(liveEventsRow(env, platform, launchState));

  // 9. Windows
  if (platform === "win32") {
    rows.push(
      found(
        "windows",
        "the launch can be read, and claude-gh can be set up",
        "degrades",
        "on Windows the plugin can't tell whether live CI events are on, and can't set up the claude-gh command.",
        "Nothing to install. Give the user the plain relaunch command from the launch notice (the one that starts `claude` with the channel flag); do not offer claude-gh here.",
        { once: true },
      ),
    );
  }
  return rows;
}

/**
 * Rows for what GitHub last answered (the FIRST CALL checks), from the record the channel keeps. A check is ready only
 * when GitHub has answered well since; with no answer on record it is unknown, never a guess.
 */
export function firstCallRows(record, { env = process.env, projectDir = env.CLAUDE_PROJECT_DIR || process.cwd(), platform = process.platform } = {}) {
  const host = sayable(loginHost(env));
  const kinds = record?.kinds ?? {};
  const mine = record?.projects?.[projectKey(projectDir)] ?? {};
  const answered = Boolean(kinds.ok);
  const rest = (id, label) => (answered ? ready(id, label) : unknown(id, label, "GitHub has not been asked yet"));
  const rows = [];

  // A refusal older than gh's last sign-in was of the login before it.
  const rejected = kinds.token_rejected;
  const signedInSince = rejected?.source === "gh" && (readGhHosts(env, platform).changedAt ?? 0) > rejected.last;
  const tokenVar = tokenVariable(env, host);
  if (rejected && !signedInSince) {
    const fromEnv = rejected.source === "env" && tokenVar;
    rows.push(
      found(
        "token_rejected",
        "GitHub accepts the login",
        "blocks",
        fromEnv
          ? `GitHub refused the token in ${tokenVar} (expired or revoked), so CI can't be read.`
          : "GitHub refused gh's login (expired or revoked), so CI can't be read. Ask me to help you sign in again.",
        fromEnv
          ? `The token in ${tokenVar} was refused (never print it). The user replaces it, or starts Claude Code without the variable (\`env -u ${tokenVar} claude\`) so gh's own login is used.`
          : signInFix(host),
      ),
    );
  } else rows.push(rest("token_rejected", "GitHub accepts the login"));

  rows.push(
    kinds.cert_error
      ? found(
          "cert_error",
          "GitHub's certificate verifies",
          "blocks",
          "GitHub's certificate couldn't be verified (a network that inspects HTTPS, most likely), so CI can't be read.",
          "A company network that inspects HTTPS signs with its own root certificate, which Node does not know. The user sets `NODE_EXTRA_CA_CERTS` to that certificate's file " +
            "(PEM; their IT team has it) in the environment Claude Code starts from, then restarts Claude Code. Never suggest turning certificate checks off.",
        )
      : rest("cert_error", "GitHub's certificate verifies"),
  );

  rows.push(
    kinds.no_repo_scope
      ? found(
          "no_repo_scope",
          "gh's login can see private repositories (the repo scope)",
          "degrades",
          "gh's login has no repo scope, so pull requests in private repositories can't be seen; public ones work.",
          `Adding the scope opens a browser, so it ${USERS_COMMAND}: \`! gh auth refresh --hostname ${host} --scopes repo\`.`,
        )
      : rest("no_repo_scope", "gh's login can see private repositories (the repo scope)"),
  );

  rows.push(
    kinds.sso
      ? found(
          "sso",
          "the login is authorised for the organisation's single sign-on",
          "degrades",
          "GitHub refused a read because the login isn't authorised for an organisation's single sign-on (SSO).",
          "The user authorises the login for that organisation in a browser. gh prints the organisation's authorisation link when a read is refused: run a gh read in that " +
            "repository (for example `gh pr list`) and give the user the link it prints to open. Never ask for a token.",
        )
      : rest("sso", "the login is authorised for the organisation's single sign-on"),
  );

  if (kinds.forbidden && kinds.forbidden.source === "env" && tokenVar) {
    rows.push(
      found(
        "token_env",
        "the token variable's token can read CI",
        "degrades",
        `GitHub refused some CI reads made with the token in ${tokenVar}; gh's own login is not being used.`,
        `The token in ${tokenVar} lacks access (never print it). The user either starts Claude Code without the variable (\`env -u ${tokenVar} claude\`), so gh's own login is used, ` +
          "or gives the token read access to the repository's Actions and pull requests.",
      ),
    );
  }

  if (mine.fork) {
    rows.push({
      ...ready("fork", FORK_LABEL),
      why: "GitHub says this repository is a fork: the branch's pull request is looked for on the repository it was forked from first, then in this one",
    });
  }
  return rows;
}

/**
 * One row per check id: a recorded answer adds to a launch check, never repeats it. A not_ready row wins over any
 * other, and of two not_ready rows the one that is not once-only (GitHub refused something) over the one that is. Of
 * two ready rows, the one that says why is kept: it is the one with something to tell.
 */
export function mergeRows(...lists) {
  const out = new Map();
  for (const row of lists.flat()) {
    const was = out.get(row.id);
    const stronger = was && row.state === "not_ready" && (was.state !== "not_ready" || (was.once === true && row.once !== true));
    const saysWhy = was && row.state === "ready" && was.state === "ready" && row.why !== undefined && was.why === undefined;
    if (!was || stronger) out.set(row.id, row);
    // In the first row's place, so the table keeps its order.
    else if (saysWhy) out.set(row.id, row);
  }
  return [...out.values()];
}

/** The rows that need saying, the most serious first. */
export function findings(rows) {
  return rows.filter((r) => r.state === "not_ready").sort((a, b) => RANK[a.effect] - RANK[b.effect]);
}

/**
 * Every check on a line of its own: what the doctor skill and the channel's `status` command print. A NOT READY line
 * carries its effect and the check's id, which is what `decline` takes.
 */
export function renderTable(rows) {
  const word = { ready: "ready    ", not_ready: "NOT READY", unknown: "unknown  ", skipped: "skipped  " };
  return rows
    .map((r) => {
      if (r.state === "not_ready") return `  ${word.not_ready}  ${r.label} [${r.effect}; ${r.id}]: ${r.line} Fix: ${r.fix}`;
      return `  ${word[r.state]}  ${r.label}${r.why ? ` (${r.why})` : ""}`;
    })
    .join("\n");
}

// ---- what has been said, and what was declined --------------------------------------------------------------------

const SETUP_FILE = "setup-checks.json";
const CHECK_ID = /^[a-z][a-z_]{1,40}$/;
const MAX_SAID_PROJECTS = 200;

function times(raw) {
  const out = {};
  for (const [id, at] of Object.entries(raw && typeof raw === "object" ? raw : {})) if (CHECK_ID.test(id) && typeof at === "number" && Number.isFinite(at)) out[id] = at;
  return out;
}

/** `declined`: check id to when the user said no. `said`: per project key, check id to when it was said. */
export function readSetupState(env = process.env) {
  const raw = readJson(stateRoot(env), SETUP_FILE);
  const said = {};
  for (const [key, value] of Object.entries(raw?.said && typeof raw.said === "object" ? raw.said : {})) if (KEY.test(key)) said[key] = times(value);
  return { declined: times(raw?.declined), said };
}

function writeSetupState(env, state) {
  const said = Object.entries(state.said)
    .sort((a, b) => Math.max(0, ...Object.values(b[1])) - Math.max(0, ...Object.values(a[1])))
    .slice(0, MAX_SAID_PROJECTS);
  return writeJson(stateRoot(env), SETUP_FILE, { v: 1, declined: state.declined, said: Object.fromEntries(said) });
}

/** Records the user's no to these checks' fixes (the time only). false: nothing valid, or not written. */
export function recordDecline(env = process.env, ids = [], now = Date.now()) {
  const valid = ids.filter((id) => CHECK_ID.test(id));
  if (!valid.length) return false;
  const state = readSetupState(env);
  for (const id of valid) state.declined[id] = now;
  return writeSetupState(env, state);
}

/** Records that these once-only items were said in this project. */
export function markSaid(env, project, ids, now = Date.now()) {
  if (!KEY.test(project) || !ids.length) return false;
  const state = readSetupState(env);
  state.said[project] = { ...(state.said[project] ?? {}), ...Object.fromEntries(ids.filter((id) => CHECK_ID.test(id)).map((id) => [id, now])) };
  return writeSetupState(env, state);
}

/** One POSIX shell word: bare when safe, else single-quoted. */
function word(s) {
  const text = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * What a launch says about these rows, or null when there is nothing to say: `line` for the user (one line, the most
 * serious problem), `context` for Claude (every problem and the fix to offer), `said` the once-only ids just said.
 *
 * No nagging: an `info` item, and any item marked `once`, is said once per project. A fix the user said no to is not
 * offered again for DECLINE_FOR_MS, and neither is its line, except a blocker's, which is always shown. With
 * `optOut`, nothing is offered and only a blocker's line is shown. When nothing can be remembered (`canRemember`
 * false: the state folder cannot be written), a once-only item is left unsaid rather than said at every launch.
 */
export function setupNotice(rows, { state = { declined: {}, said: {} }, optOut = false, canRemember = true, pluginRoot, project = "", now = Date.now() } = {}) {
  const declined = (id) => {
    const at = state.declined?.[id];
    return typeof at === "number" && now - at >= 0 && now - at < DECLINE_FOR_MS;
  };
  const onceOnly = (f) => f.effect === "info" || f.once === true;
  const shown = findings(rows).filter((f) => {
    if (f.effect === "blocks") return true;
    if (optOut || declined(f.id)) return false;
    if (onceOnly(f)) return canRemember && state.said?.[project]?.[f.id] === undefined;
    return true;
  });
  if (!shown.length) return null;
  const offered = optOut ? [] : shown.filter((f) => !declined(f.id));
  const more = shown.length - 1;
  const line = `runners.io: ${shown[0].line}${more > 0 ? ` (${more} more: /runners-io:doctor lists ${more === 1 ? "it" : "them"}.)` : ""}`;
  if (!offered.length) {
    return {
      line,
      context:
        `${line} The user has been shown this line. Offers are off (${optOut ? `${OPT_OUT}=1` : "the user said no earlier"}): do not offer a fix and do not repeat the line ` +
        "unless the user asks. /runners-io:doctor lists every check.",
      said: [],
    };
  }
  const items = offered.map((f) => `- [${f.effect}] (${f.id}) ${f.line} ${f.effect === "info" ? "No action:" : "Fix to offer:"} ${f.fix}`);
  const fixable = offered.filter((f) => f.effect !== "info" && f.once !== true);
  const decline = pluginRoot
    ? `run \`node ${word(`${pluginRoot}/hooks/readiness.mjs`)} decline <the ids in brackets>\`, which records it so the fix is not offered again for 7 days, and `
    : "";
  const context = [
    `runners.io plugin setup checks: ${offered.length === 1 ? "one thing" : `${offered.length} things`} on this machine ${offered.length === 1 ? "needs" : "need"} attention. ` +
      `The user has been shown this line only: "${line}"`,
    ...items,
    fixable.length
      ? "How to offer: once in this session, early and at a natural moment (never in the middle of a task), offer the fix for the first item that has one, and say that the others exist. " +
        "Ask first, and change nothing without a yes. Installs follow the /runners-io:setup-github skill's rules. A command that needs sudo, an administrator prompt, a browser or a " +
        "one-time code is the user's to run: give it to them to type in the prompt as `! <command>`. Never ask for a token, never print one, and never put one on a command line. " +
        "After a fix, run /runners-io:doctor and confirm that its line now reads ready. " +
        `If the user says no, ${decline}do not offer it again in this session.`
      : "None of these needs a fix: mention one only where it explains something the user is asking about, and do not repeat it.",
  ].join("\n");
  return { line, context, said: canRemember ? offered.filter(onceOnly).map((f) => f.id) : [] };
}

/**
 * The SessionStart hook's whole path: the launch checks, what GitHub last answered, what was already said or declined.
 * null on a machine that is ready, and whenever there is nothing new to say.
 */
export async function setupFor(input, env = process.env, { platform = process.platform, now = Date.now(), pluginRoot = env.CLAUDE_PLUGIN_ROOT, launchState } = {}) {
  const cwd = input && typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR && isAbsolute(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : cwd;
  const launch = await launchChecks({ env, projectDir, platform, launchState });
  const rows = mergeRows(launch, firstCallRows(readFirstCall(env, now), { env, projectDir, platform }));
  if (!findings(rows).length) return null;
  const root = stateRoot(env);
  const canRemember = root !== null && !launch.some((r) => r.id === "data_dir" && r.folders?.includes(root));
  const project = projectKey(projectDir);
  const notice = setupNotice(rows, { state: canRemember ? readSetupState(env) : undefined, optOut: env[OPT_OUT] === "1", canRemember, pluginRoot, project, now });
  if (!notice) return null;
  if (notice.said.length) markSaid(env, project, notice.said, now);
  return { line: notice.line, context: notice.context };
}

async function main(argv) {
  const command = argv[0];
  if (command === "decline") {
    const ids = argv.slice(1);
    if (!recordDecline(process.env, ids)) {
      process.stderr.write("could not record the no (no check id given, or the state folder cannot be written); the offer will come again\n");
      return 3;
    }
    process.stdout.write(`recorded: ${ids.join(", ")} will not be offered again for 7 days\n`);
    return 0;
  }
  if (command === "check") {
    const rows = mergeRows(await launchChecks(), firstCallRows(readFirstCall()));
    process.stdout.write(`${renderTable(rows)}\n`);
    return 0;
  }
  process.stderr.write("usage: readiness.mjs check | decline <check id>...\n");
  return 64;
}

let invoked = "";
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
} catch {}
// The name is checked as well as the path: bundled into the channel, this module's own URL is the bundle's.
if (basename(invoked) === "readiness.mjs" && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
