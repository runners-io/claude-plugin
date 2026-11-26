#!/usr/bin/env node
// claude-gh: a separate command that starts Claude Code with the runners.io CI channel on. The setup-github skill offers it; this script writes it, so the edit is the same every time.
//
//   node claude-gh.mjs show     the shell, the rc file and the exact lines; changes nothing
//   node claude-gh.mjs add      writes the lines between the markers (again: replaces them in place)
//   node claude-gh.mjs remove   takes them out, leaving the file as it was
//   node claude-gh.mjs decline  records the user's no, so the offer is not made again for 7 days
//   --shell zsh|bash|fish       instead of $SHELL;  --rc <file>  instead of the shell's usual rc file
//
// It never redefines `claude`, and refuses to write over a claude-gh the user defined themselves. The command
// names claude by its absolute path when it can find it, so it does not depend on what is on PATH later.
// Dependency-free plain JavaScript, Node 20.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { channelFlags, shellWord } from "../../hooks/launch.mjs";
import { findProgram } from "../../hooks/programs.mjs";

export const BEGIN = "# >>> runners.io claude channel >>>";
export const END = "# <<< runners.io claude channel <<<";
const SHELLS = ["zsh", "bash", "fish"];
// Only a block carrying this line is ours to replace or remove: someone may write their own claude-gh between
// the same markers (a hand-made alias, say), and an add or an undo must not destroy it.
export const SIGNATURE = "# written by the runners.io plugin's setup-github skill (claude-gh.mjs)";

/** The lines for one shell. `claude` is its absolute path, or null to use `command claude`. */
export function blockFor(shell, pluginRoot, claude) {
  const exe = claude ? shellWord(claude, shell) : "command claude";
  const words = [exe, ...channelFlags(pluginRoot, shell)].join(" ");
  const about = [
    SIGNATURE,
    "# claude-gh starts Claude Code with live CI events from the runners.io plugin's channel; `claude` is unchanged.",
    "# Until the channel is on Claude Code's approved list it uses the development flag, which shows a",
    "# confirmation screen at every launch. To remove: delete from the first marker to the last, or run the",
    "# runners.io setup-github skill's undo.",
  ];
  const body =
    shell === "fish"
      ? ["function claude-gh --description 'Claude Code with the runners.io CI channel on'", `    ${words} $argv`, "end"]
      : [`claude-gh() { ${words} "$@"; }`];
  return `${[BEGIN, ...about, ...body, END].join("\n")}\n`;
}

function span(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return null;
  const endAt = text.indexOf(END, start);
  if (endAt < 0) throw new Error(`the file has "${BEGIN}" and no "${END}" after it: fix it by hand`);
  let stop = endAt + END.length;
  if (text[stop] === "\n") stop++;
  if (!text.slice(start, stop).includes(SIGNATURE)) {
    throw new Error("the file has a runners.io block that was not written by this script: it is left as it is");
  }
  return { start, stop };
}

/** The file's text with the block in it: replaced in place when present, else appended. */
/** A claude-gh the user defined themselves, in any of the three shells. */
const DEFINES = /^\s*(alias\s+claude-gh\b|claude-gh\s*\(\)|function\s+claude-gh\b)/m;

export function addBlock(text, block) {
  const at = span(text);
  const outside = at ? text.slice(0, at.start) + text.slice(at.stop) : text;
  if (DEFINES.test(outside)) {
    throw new Error("the file already defines claude-gh outside the runners.io markers: it is left as it is");
  }
  if (at) return text.slice(0, at.start) + block + text.slice(at.stop);
  // Exactly one "\n" before the block (a blank line when the file ended with a newline, a line break when it
  // did not), which is what removeBlock takes back off, so a remove restores the file byte for byte.
  return text === "" ? block : `${text}\n${block}`;
}

/** The file's text without the block: exactly as it was before addBlock when the block is still last. */
export function removeBlock(text) {
  const at = span(text);
  if (!at) return text;
  const before = text.slice(0, at.start);
  const after = text.slice(at.stop);
  return (after === "" && before.endsWith("\n") ? before.slice(0, -1) : before) + after;
}

/**
 * The rc file a shell reads for an interactive session. Always an absolute path: an empty or relative HOME (and no
 * absolute ZDOTDIR or XDG_CONFIG_HOME) is refused, where join() would quietly name a file in the current folder.
 */
export function rcFor(shell, env = process.env) {
  if (!SHELLS.includes(shell)) throw new Error(`claude-gh can be set up for zsh, bash or fish, not ${shell}: add it to your shell by hand`);
  const home = env.HOME ?? "";
  const base = (dir) => {
    if (dir && isAbsolute(dir)) return dir;
    if (isAbsolute(home)) return null;
    throw new Error(`HOME is ${home ? `not an absolute path (${home})` : "empty"}, so there is no rc file to write: pass --rc <file>`);
  };
  if (shell === "zsh") return join(base(env.ZDOTDIR) ?? home, ".zshrc");
  if (shell === "bash") return join(base("") ?? home, ".bashrc");
  return join(base(env.XDG_CONFIG_HOME) ?? join(home, ".config"), "fish", "config.fish");
}

/**
 * Replaces an rc file in one step: the new text goes to a temporary file beside the real one, which is renamed over
 * it, so a crash or a full disk never leaves a half-written rc file. A symlink (dotfiles kept in a repository) is
 * followed and stays a symlink; the file keeps its mode.
 */
export function writeRc(file, text) {
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : null;
  const tmp = join(dirname(target), `.${basename(target)}.runners-io-${process.pid}`);
  try {
    writeFileSync(tmp, text, { mode: mode ?? 0o644, flag: "wx" });
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The absolute paths /etc/shells lists, one per line, comments and blank lines left out. */
export function listedShells(text) {
  return new Set(
    String(text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("/")),
  );
}

function readListedShells() {
  try {
    return listedShells(readFileSync("/etc/shells", "utf8"));
  } catch {
    return new Set();
  }
}

/**
 * Whether the user has a `claude-gh`, asked of their own shell the way their terminal starts it: `$SHELL -lic`, so
 * an alias or function counts wherever it is defined (the rc file, .zprofile or .bash_profile, a file they source).
 * bash is asked a second time without -l, because a login bash does not read .bashrc unless told to.
 *
 * true or false only when the shell answered; null, so no offer, on Windows, for a shell other than zsh, bash or
 * fish (the setup skill cannot write for it), and when the shell failed, hung (4 s) or could not start. The
 * command and its arguments are fixed: nothing from the environment but the shell's own path goes into them.
 */
export async function claudeGhPresent(env = process.env, { platform = process.platform, run = runShell, timeoutMs = 4000, shells } = {}) {
  if (platform === "win32") return null;
  const shellPath = env.SHELL ?? "";
  const shell = basename(shellPath);
  if (!shellPath.startsWith("/") || !SHELLS.includes(shell)) return null;
  // SHELL is run with -lic, so it must be a login shell this machine lists, not any program a variable points at.
  if (!(shells ?? readListedShells()).has(shellPath)) return null;
  if (findProgram("claude-gh", env, platform)) return true;
  const ask = shell === "fish" ? "type -q claude-gh" : "command -v claude-gh >/dev/null 2>&1";
  const tries = shell === "bash" ? [["-lic", ask], ["-ic", ask]] : [["-lic", ask]];
  let answered = false;
  for (const args of tries) {
    const status = await run(shellPath, args, env, timeoutMs);
    if (status === 0) return true;
    if (status === 1) answered = true;
    else return null;
  }
  return answered ? false : null;
}

/** After the user says no, the offer is not made again for this long; then once more. */
export const DECLINE_FOR_MS = 7 * 24 * 60 * 60_000;

/**
 * The plugin's state folder: $XDG_STATE_HOME/runners-io, else ~/.local/state/runners-io. Kept apart from the cache,
 * which is deleted freely. null when neither gives an absolute path: a no is then not remembered, never written
 * into the current folder.
 */
export function stateRootFor(env = process.env) {
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, "runners-io");
  return env.HOME && isAbsolute(env.HOME) ? join(env.HOME, ".local", "state", "runners-io") : null;
}

const DECLINED = "claude-gh-declined.json";

/** Whether the user said no less than DECLINE_FOR_MS ago: only from a real file, in a real folder of this user's. */
function declined(env, now) {
  const root = stateRootFor(env);
  if (!root) return false;
  try {
    if (!ownFolder(root)) return false;
    const st = lstatSync(join(root, DECLINED));
    if (!st.isFile() || (process.getuid !== undefined && st.uid !== process.getuid())) return false;
    const { at } = JSON.parse(readFileSync(join(root, DECLINED), "utf8"));
    return typeof at === "number" && now - at >= 0 && now - at < DECLINE_FOR_MS;
  } catch {
    return false;
  }
}

/**
 * Records the user's no (the time only): a 0600 file in a 0700 folder, never through a symlink or into another
 * user's folder. false when it could not be written, so the offer simply comes again.
 */
export function recordDecline(env = process.env, now = Date.now()) {
  const root = stateRootFor(env);
  if (!root) return false;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!ownFolder(root)) return false;
    const file = join(root, DECLINED);
    try {
      if (lstatSync(file).isSymbolicLink()) rmSync(file);
    } catch {}
    const tmp = join(root, `.${DECLINED}.${process.pid}`);
    writeFileSync(tmp, JSON.stringify({ at: now }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The shell's answer, found or missing, is believed this long before the shell is asked again. */
const REMEMBER_FOR_MS = 24 * 60 * 60_000;
const SEEN = "claude-gh.json";

/** The plugin's cache folder, the same one the channel shares its GitHub reads in. */
export function cacheRootFor(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "runners-io");
}

/** The remembered answer, or null: only from a plain file of this user's, in a plain folder of this user's. */
function readSeen(cacheRoot) {
  try {
    if (!ownFolder(cacheRoot)) return null;
    const st = lstatSync(join(cacheRoot, SEEN));
    if (!st.isFile() || st.size > 4096 || (process.getuid !== undefined && st.uid !== process.getuid())) return null;
    const seen = JSON.parse(readFileSync(join(cacheRoot, SEEN), "utf8"));
    return seen && typeof seen === "object" && !Array.isArray(seen) ? seen : null;
  } catch {
    return null;
  }
}

/** Remembers an answer: a 0600 file in a 0700 folder of this user's, replaced in one step, never through a symlink. */
function writeSeen(cacheRoot, value) {
  const tmp = join(cacheRoot, `.${SEEN}.${process.pid}`);
  try {
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    if (!ownFolder(cacheRoot)) return false;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    // A rename replaces whatever has the name, a symlink included, and never writes to what a symlink points at.
    renameSync(tmp, join(cacheRoot, SEEN));
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/**
 * Forgets the remembered answer, so the next launch asks the shell. `add` and `remove` call it: the user has just
 * changed whether there is a claude-gh, and an answer from before would be wrong for the rest of its day.
 */
export function forgetClaudeGh(env = process.env, cacheRoot = cacheRootFor(env)) {
  try {
    if (ownFolder(cacheRoot)) rmSync(join(cacheRoot, SEEN), { force: true });
  } catch {}
}

/**
 * What the shell's usual rc file looked like when it was asked: its time of change and its size, `none` when there
 * is no such file. A remembered `missing` is used only while this is unchanged, so a claude-gh the user adds by hand
 * is seen at the next launch. A claude-gh defined in some other file is seen when the answer's day is up.
 */
function rcStamp(shellPath, env) {
  try {
    const st = statSync(rcFor(basename(shellPath), env));
    return `${st.mtimeMs}:${st.size}`;
  } catch (error) {
    return error?.code === "ENOENT" ? "none" : "unknown";
  }
}

/**
 * claudeGhPresent's answer for the SessionStart offer, or null (no offer) when the user has turned it off.
 *
 * Asking the shell runs the user's startup files (`$SHELL -lic`), which can be slow or start things, so it is not
 * done at every launch: the shell's answer, FOUND or MISSING, is remembered for a day (per shell, in the cache
 * folder: 0700, a 0600 file, never through a symlink or another user's folder) and the shell is not started again
 * until then. A remembered MISSING still makes the offer; it is dropped at once when it may be out of date: the
 * setup-github skill added or removed claude-gh (forgetClaudeGh), the shell's rc file changed, or a claude-gh is on
 * PATH. No answer (the shell failed or hung) is not remembered. After the user says no (recordDecline), there is no
 * offer and no shell is started for DECLINE_FOR_MS; then it is offered once again.
 */
export async function claudeGhForOffer(env = process.env, present = claudeGhPresent, { now = Date.now(), cacheRoot = cacheRootFor(env) } = {}) {
  if (env.RUNNERS_IO_NO_CLAUDE_GH_OFFER === "1") return null;
  if (declined(env, now)) return null;
  const shell = env.SHELL ?? "";
  const seen = readSeen(cacheRoot);
  if (seen && seen.shell === shell && typeof seen.at === "number" && now - seen.at >= 0 && now - seen.at < REMEMBER_FOR_MS) {
    // A file from before `found` was written holds a claude-gh that was found: only that was remembered then.
    if (seen.found !== false) return true;
    if (seen.rc === rcStamp(shell, env) && !findProgram("claude-gh", env)) return false;
  }
  const answer = await present(env);
  if (answer === true) writeSeen(cacheRoot, { shell, at: now, found: true });
  else if (answer === false) writeSeen(cacheRoot, { shell, at: now, found: false, rc: rcStamp(shell, env) });
  return answer;
}

/** A real folder (not a symlink) owned by this user. */
function ownFolder(dir) {
  const st = lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid());
}

/**
 * The shell's exit status, or null when it timed out, was killed or could not start.
 *
 * The shell runs the user's startup files, which may start things in the background (`sleep 60 &`, a watcher).
 * It is started in a process group of its own, and the whole group is killed when the shell exits or the limit
 * passes, so nothing it started IN THAT GROUP outlives the check. A program that left the group (a daemon that put
 * itself in a new session or group: ssh-agent, a tmux server) is not reached and is left alone, as it would be after
 * any terminal closed.
 */
function runShell(file, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { env, stdio: "ignore", detached: true });
    } catch {
      resolve(null);
      return;
    }
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve(status);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", (code, signal) => finish(signal ? null : code));
  });
}

/** claude's absolute path from PATH's absolute folders (programs.mjs), or null. Nothing is run to find it. */
function findClaude() {
  return findProgram("claude");
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const command = argv[0];
  if (command === "decline") {
    const now = Date.now();
    if (!recordDecline(process.env, now)) {
      process.stderr.write("could not record the no (no absolute HOME, or the state folder is not a plain folder of yours); the offer will come again\n");
      return 3;
    }
    const until = new Date(now + DECLINE_FOR_MS).toISOString().slice(0, 10);
    process.stdout.write(`noted: runners.io will not offer claude-gh again for 7 days (until ${until}). To set it up sooner: /runners-io:setup-github\n`);
    return 0;
  }
  if (!["show", "add", "remove"].includes(command)) {
    process.stderr.write("usage: claude-gh.mjs show|add|remove|decline [--shell zsh|bash|fish] [--rc <file>]\n");
    return 64;
  }
  const shell = arg(argv, "--shell") ?? (process.env.SHELL ?? "").split("/").at(-1);
  if (!SHELLS.includes(shell)) {
    process.stderr.write(`claude-gh can be set up for zsh, bash or fish; this shell is ${shell || "unknown"}: pass --shell, or add it by hand\n`);
    return 3;
  }
  const rc = resolve(arg(argv, "--rc") ?? rcFor(shell));
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const block = blockFor(shell, pluginRoot, findClaude());
  const text = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const check = shell === "fish" ? "fish -c 'type claude-gh'" : `${shell} -ic 'type claude-gh'`;

  if (command === "show") {
    let plan;
    try {
      const next = addBlock(text, block);
      plan = next === text ? "already has these lines; add would change nothing" : text.includes(BEGIN) ? "add would replace its runners.io block with" : "add would append";
    } catch (error) {
      plan = `add would refuse: ${error.message}. The lines it would have written`;
    }
    process.stdout.write(`shell: ${shell}\nfile: ${rc}${existsSync(rc) ? "" : " (does not exist yet)"}\n`);
    process.stdout.write(`${plan}:\n\n${block}\n`);
    process.stdout.write(`check afterwards with: ${check}\n`);
    return 0;
  }
  // Whatever comes of it, the user has asked for claude-gh to be set up or taken out: the answer the launch offer
  // remembered is forgotten, so the next launch asks the shell and sees what is there now.
  forgetClaudeGh(process.env);
  try {
    const next = command === "add" ? addBlock(text, block) : removeBlock(text);
    if (next === text) {
      process.stdout.write(command === "add" ? `${rc} already has these lines: nothing changed\n` : `${rc} has no runners.io block: nothing changed\n`);
      return 0;
    }
    mkdirSync(dirname(rc), { recursive: true });
    if (command === "add" && existsSync(rc) && !existsSync(`${rc}.before-runners-io`)) copyFileSync(rc, `${rc}.before-runners-io`);
    writeRc(rc, next);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 3;
  }
  process.stdout.write(
    command === "add"
      ? `added claude-gh to ${rc}. Check with: ${check}. Terminals already open need a new tab (or: source ${rc}).\n`
      : `removed claude-gh from ${rc}. Terminals already open keep it until they are closed.\n`,
  );
  return 0;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
