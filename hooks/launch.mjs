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

/** `on`, `off` or `headless`, from one Claude Code command line. */
export function parseLaunch(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  let on = false;
  let headless = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (HEADLESS.has(t)) headless = true;
    const eq = t.indexOf("=");
    const flag = eq > 0 ? t.slice(0, eq) : t;
    if (!CHANNEL_FLAGS.has(flag)) continue;
    const entries = eq > 0 ? [t.slice(eq + 1)] : [];
    if (eq < 0) for (let j = i + 1; j < tokens.length && !tokens[j].startsWith("-"); j++) entries.push(tokens[j]);
    if (entries.some((e) => OURS.test(e))) on = true;
  }
  return { state: headless ? "headless" : on ? "on" : "off" };
}

const CACHE = /\/\.claude\/plugins\/cache\/([A-Za-z0-9._-]+)\/runners-io\/[^/]+\/?$/;

/** One word for a POSIX shell (zsh, bash) or fish: bare when safe, else single-quoted. */
export function shellWord(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replaceAll("'", "'\\''")}'`;
}

/**
 * The flags that start this plugin's channel, as shell words. An installed plugin lives under
 * ~/.claude/plugins/cache/<marketplace>/runners-io/<version> and is named plugin:runners-io@<marketplace>; one
 * loaded with --plugin-dir needs that flag again and is named plugin:runners-io@inline. The development flag
 * stays until the channel is on the approved allowlist (channels-reference).
 */
export function channelFlags(pluginRoot) {
  const root = String(pluginRoot ?? "");
  const cached = CACHE.exec(root);
  return cached
    ? ["--dangerously-load-development-channels", `plugin:runners-io@${cached[1]}`]
    : ["--plugin-dir", shellWord(root), "--dangerously-load-development-channels", "plugin:runners-io@inline"];
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
