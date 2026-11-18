// Whether this Claude Code session opted the runners-io channel in.
//
// Claude Code tells a channel nothing: a session that did not opt in drops its events silently, and `-p`
// ignores the channel flags (channels-reference). The one reliable signal is the launching process's own
// command line, so this walks up from the calling process's parent to the `claude` process and reads its
// flags. Claude Code starts the channel itself and a hook through a shell, so the walk passes through shells
// and nothing else: any other process in between (a test runner, npm) means something other than Claude Code
// started us, and the claude found above it would be the wrong session. Where `ps` does not exist (Windows),
// or the chain is not claude-and-shells, the answer is "unknown", never a guess.
//
// Shared by hooks/session-start.mjs and the channel (bundled). Dependency-free plain JavaScript.
import { execFileSync } from "node:child_process";

const CHANNEL_FLAGS = new Set(["--channels", "--dangerously-load-development-channels"]);
const OURS = /^(plugin:runners-io@[A-Za-z0-9._-]+|server:runners-io)$/;
const HEADLESS = new Set(["-p", "--print"]);

/**
 * `on`, `off` or `headless`, from one Claude Code command line. Only the options are read: ps drops the quotes, so
 * `claude "explain the -p flag"` arrives as words, and a word of the prompt must never count as a flag. The options
 * end at `--` or at the first word that is not a flag and not a flag's value. A channel flag takes every entry that
 * follows it; any other flag at most one value (`--model opus`), so a prompt after a value-less flag loses its first
 * word to it, which is harmless: the next word ends the options.
 */
export function parseLaunch(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  // The executable: `claude ...`, or `node .../@anthropic-ai/claude-code/cli.js ...`.
  const script = tokens.slice(0, 3).findIndex((t) => /@anthropic-ai\/claude-code\/cli\.(m?js)$/.test(t));
  let on = false;
  let headless = false;
  for (let i = script >= 0 ? script + 1 : 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--" || !t.startsWith("-")) break;
    if (HEADLESS.has(t)) headless = true;
    const eq = t.indexOf("=");
    const flag = eq > 0 ? t.slice(0, eq) : t;
    if (CHANNEL_FLAGS.has(flag)) {
      const entries = eq > 0 ? [t.slice(eq + 1)] : [];
      if (eq < 0) while (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) entries.push(tokens[++i]);
      if (entries.some((e) => OURS.test(e))) on = true;
    } else if (eq < 0 && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      i++; // this flag's value, if it takes one
    }
  }
  return { state: headless ? "headless" : on ? "on" : "off" };
}

const CACHE = /\/\.claude\/plugins\/cache\/([A-Za-z0-9._-]+)\/runners-io\/[^/]+\/?$/;

/**
 * One word for a POSIX shell (zsh, bash; the default) or fish: bare when safe, else single-quoted. The quoting
 * differs: inside single quotes a POSIX shell takes every character as it is, so a quote closes, is escaped and
 * reopens ('\''); fish reads \' and \\ as escapes there, so both are backslashed instead.
 */
export function shellWord(s, shell = "posix") {
  const text = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return shell === "fish" ? `'${text.replace(/[\\']/g, "\\$&")}'` : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The flags that start this plugin's channel, as shell words. An installed plugin lives under
 * ~/.claude/plugins/cache/<marketplace>/runners-io/<version> and is named plugin:runners-io@<marketplace>; one
 * loaded with --plugin-dir needs that flag again and is named plugin:runners-io@inline. The development flag
 * stays until the channel is on the approved allowlist (channels-reference).
 */
export function channelFlags(pluginRoot, shell = "posix") {
  const root = String(pluginRoot ?? "");
  const cached = CACHE.exec(root);
  return cached
    ? ["--dangerously-load-development-channels", `plugin:runners-io@${cached[1]}`]
    : ["--plugin-dir", shellWord(root, shell), "--dangerously-load-development-channels", "plugin:runners-io@inline"];
}

/** Whether the channel should poll: only where a pushed event can arrive, or where it cannot tell. */
export function pollsIn(state) {
  return state === "on" || state === "unknown";
}

function isClaude(args) {
  const tokens = String(args ?? "").trim().split(/\s+/);
  const first = tokens[0] ?? "";
  if (first === "claude" || first.endsWith("/claude") || /\/claude\/versions\/[^/]+$/.test(first)) return true;
  return tokens.slice(0, 2).some((t) => /@anthropic-ai\/claude-code\/cli\.(m?js)$/.test(t));
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

function isShell(args) {
  const first = String(args ?? "").trim().split(/\s+/)[0] ?? "";
  return SHELLS.has(first.replace(/^-/, "").split("/").at(-1));
}

function psRow(pid) {
  const out = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  const m = /^\s*(\d+)\s+(.*)$/.exec(out.trim());
  return m ? { ppid: Number(m[1]), args: m[2] } : null;
}

/** Walks up from `pid` (the caller's parent), through shells only, to the claude process. */
export function findLaunch(pid = process.ppid, ps = psRow) {
  try {
    let current = pid;
    for (let hops = 0; hops < 8 && current > 1; hops++) {
      const row = ps(current);
      if (!row) break;
      if (isClaude(row.args)) return { ...parseLaunch(row.args), claudePid: current };
      if (!isShell(row.args)) break;
      current = row.ppid;
    }
  } catch {
    // no ps, or it failed: say so
  }
  return { state: "unknown" };
}
