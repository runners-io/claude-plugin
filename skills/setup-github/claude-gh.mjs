#!/usr/bin/env node
// claude-gh: a separate command that starts Claude Code with the runners.io CI channel on. The setup-github skill offers it; this script writes it, so the edit is the same every time.
//
//   node claude-gh.mjs show     the shell, the rc file and the exact lines; changes nothing
//   node claude-gh.mjs add      writes the lines between the markers (again: replaces them in place)
//   node claude-gh.mjs remove   takes them out, leaving the file as it was
//   --shell zsh|bash|fish       instead of $SHELL;  --rc <file>  instead of the shell's usual rc file
//
// It never redefines `claude`, and refuses to write over a claude-gh the user defined themselves. The command
// names claude by its absolute path when it can find it, so it does not depend on what is on PATH later.
// Dependency-free plain JavaScript, Node 20.
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { channelFlags, shellWord } from "../../hooks/launch.mjs";

export const BEGIN = "# >>> runners.io claude channel >>>";
export const END = "# <<< runners.io claude channel <<<";
const SHELLS = ["zsh", "bash", "fish"];
// Only a block carrying this line is ours to replace or remove: someone may write their own claude-gh between
// the same markers (a hand-made alias, say), and an add or an undo must not destroy it.
export const SIGNATURE = "# written by the runners.io plugin's setup-github skill (claude-gh.mjs)";

/** The lines for one shell. `claude` is its absolute path, or null to use `command claude`. */
export function blockFor(shell, pluginRoot, claude) {
  const exe = claude ? shellWord(claude) : "command claude";
  const words = [exe, ...channelFlags(pluginRoot)].join(" ");
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

/** The rc file a shell reads for an interactive session. */
export function rcFor(shell, env = process.env) {
  const home = env.HOME ?? "";
  if (shell === "zsh") return join(env.ZDOTDIR || home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  if (shell === "fish") return join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "config.fish");
  throw new Error(`claude-gh can be set up for zsh, bash or fish, not ${shell}: add it to your shell by hand`);
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
export async function claudeGhPresent(env = process.env, { platform = process.platform, run = runShell, timeoutMs = 4000 } = {}) {
  if (platform === "win32") return null;
  const shellPath = env.SHELL ?? "";
  const shell = basename(shellPath);
  if (!shellPath.startsWith("/") || !SHELLS.includes(shell)) return null;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "claude-gh"), constants.X_OK);
      return true;
    } catch {}
  }
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

/** A claude-gh found is believed this long before the shell is asked again. */
const FOUND_FOR_MS = 24 * 60 * 60_000;

/** The plugin's cache folder, the same one the channel shares its GitHub reads in. */
export function cacheRootFor(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "runners-io");
}

/**
 * claudeGhPresent's answer for the SessionStart offer, or null (no offer) when the user has turned it off.
 *
 * Asking the shell runs the user's startup files, which can be slow or start things, so a claude-gh FOUND is
 * remembered for a day (per shell, in the cache folder: 0700, a 0600 file, never through a symlink or another
 * user's folder) and the shell is not started again until then. One MISSING is asked at every launch: that is
 * when the offer is made, and the user may have just added it.
 */
export async function claudeGhForOffer(env = process.env, present = claudeGhPresent, { now = Date.now(), cacheRoot = cacheRootFor(env) } = {}) {
  if (env.RUNNERS_IO_NO_CLAUDE_GH_OFFER === "1") return null;
  const shell = env.SHELL ?? "";
  const file = join(cacheRoot, "claude-gh.json");
  try {
    if (ownFolder(cacheRoot) && !lstatSync(file).isSymbolicLink()) {
      const seen = JSON.parse(readFileSync(file, "utf8"));
      if (seen.shell === shell && typeof seen.at === "number" && now - seen.at >= 0 && now - seen.at < FOUND_FOR_MS) return true;
    }
  } catch {}
  const answer = await present(env);
  if (answer === true) {
    try {
      mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
      if (ownFolder(cacheRoot)) {
        const tmp = join(cacheRoot, `.claude-gh.json.${process.pid}`);
        writeFileSync(tmp, JSON.stringify({ shell, at: now }), { mode: 0o600 });
        renameSync(tmp, file);
      }
    } catch {}
  }
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
 * passes, so nothing it started outlives the check. A daemon that put itself in a new session (ssh-agent, a tmux
 * server) is not in the group and is left alone, as it would be after any terminal closed.
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

function findClaude() {
  try {
    const out = execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.startsWith("/") ? out : null;
  } catch {
    return null;
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const command = argv[0];
  if (!["show", "add", "remove"].includes(command)) {
    process.stderr.write("usage: claude-gh.mjs show|add|remove [--shell zsh|bash|fish] [--rc <file>]\n");
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
  try {
    const next = command === "add" ? addBlock(text, block) : removeBlock(text);
    if (next === text) {
      process.stdout.write(command === "add" ? `${rc} already has these lines: nothing changed\n` : `${rc} has no runners.io block: nothing changed\n`);
      return 0;
    }
    mkdirSync(dirname(rc), { recursive: true });
    if (command === "add" && existsSync(rc) && !existsSync(`${rc}.before-runners-io`)) copyFileSync(rc, `${rc}.before-runners-io`);
    writeFileSync(rc, next);
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
