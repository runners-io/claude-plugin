#!/usr/bin/env node
// PostToolUse hook: hands the PRs a tool call's output names in the session's OWN repository to this session's
// runners-io channel, which watches one if it is new and the signed-in login opened it, and tells Claude when Claude
// itself opened it.
//
// A prompt to subscribe can be ignored, and most PRs are opened by scripts whose command never says `gh pr create`,
// so the hook hands the PR over instead: a file per PR under `<shared root>/requests/<claude pid>/`, which the
// channel (channel/src/hookrequests.ts) reads. A PR URL in output is text anyone can write (a log, a README, a
// comment), so only a PR in the repository the session's folder belongs to is handed over, only when the channel is
// on and automatic subscription is not off; the channel then keeps it only if GitHub says it is open, was created
// minutes ago and was opened by the signed-in login. Otherwise Claude is asked to subscribe, as before.
//
// It never blocks anything: every path exits 0, and it prints nothing unless
// it found the PR it is talking about. Dependency-free plain JavaScript, so it
// runs on Node 20 with nothing installed.
//
// Input (stdin): Claude Code's PostToolUse JSON. It hands over the PR URLs in
//   - any Bash call's output (at most 5), and tells Claude only when the command ran `gh pr create`;
//   - an MCP tool named like `create_pull_request` (the GitHub MCP server), reading the URL in its result.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLaunch } from "./launch.mjs";

const PR_URL_ALL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)\/pull\/(\d{1,9})(?![\d])/g;
/** At most this many PRs are handed over from one tool call's output (a long log can name dozens). */
const MAX_REQUESTS = 5;
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)\/pull\/(\d{1,9})(?![\d])/;
const GH_PR_CREATE = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;
const CREATE_TOOL = /^mcp__.+__create_pull_request$/;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      data += d;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function text(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function contextFor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  let haystack = "";
  if (tool === "Bash") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (!GH_PR_CREATE.test(command)) return null;
    const res = input.tool_response;
    haystack = typeof res?.stdout === "string" ? res.stdout : text(res);
  } else if (CREATE_TOOL.test(tool)) {
    haystack = text(input.tool_response);
  } else {
    return null;
  }
  const m = PR_URL.exec(haystack);
  if (!m) return null;
  const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  const pr = Number(m[3]);
  if (!Number.isSafeInteger(pr) || pr < 1) return null;
  return (
    `You opened ${repo} PR #${pr}. Call the runners-io channel's subscribe tool now ` +
    `(mcp__plugin_runners-io_runners-io__subscribe) with repo="${repo}" pr=${pr}: without it this session is not told ` +
    "when that PR's CI fails, waits for approval or finishes, or when it gets a merge conflict. " +
    'Results arrive as <channel source="runners-io"> events if this session was started with the runners-io channel; ' +
    "if none arrive, call ci_status to check."
  );
}

/** The PRs named in a tool call's output: any Bash output (a script may have opened one), or a create tool's result. */
export function prsIn(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  let haystack = "";
  if (tool === "Bash") {
    const res = input.tool_response;
    haystack = typeof res?.stdout === "string" ? res.stdout : text(res);
  } else if (CREATE_TOOL.test(tool)) {
    haystack = text(input.tool_response);
  } else {
    return [];
  }
  const seen = new Map();
  for (const m of haystack.matchAll(PR_URL_ALL)) {
    const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
    const pr = Number(m[3]);
    if (!Number.isSafeInteger(pr) || pr < 1) continue;
    seen.set(`${repo.toLowerCase()}#${pr}`, { repo, pr });
    if (seen.size >= MAX_REQUESTS) break;
  }
  return [...seen.values()];
}

/** The folder the channel defaults to for shared state (channel/src/shared.ts defaultSharedRoot). */
export function defaultRoot(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "runners-io");
}

/** A plain folder (never a symlink) owned by this user, made 0700; throws otherwise. */
function ownFolder(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain folder`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  chmodSync(dir, 0o700);
}

/**
 * Hands each PR to the channel of the Claude process `claudePid`: one file per PR under
 * `<root>/requests/<claudePid>/`, which that channel reads, deletes and subscribes to (channel/src/hookrequests.ts).
 * The channel, not the hook, decides whether the PR is new enough to watch. Answers how many were written.
 */
export function handOver(prs, { claudePid, root, now }) {
  if (!Number.isSafeInteger(claudePid) || claudePid < 2 || prs.length === 0) return 0;
  let written = 0;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    ownFolder(root);
    ownFolder(join(root, "requests"));
    const dir = join(root, "requests", String(claudePid));
    ownFolder(dir);
    for (const { repo, pr } of prs) {
      const name = createHash("sha256").update(`${repo.toLowerCase()}#${pr}`).digest("hex").slice(0, 24);
      const tmp = join(dir, `.${name}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ repo, pr, at: now }), { mode: 0o600 });
      renameSync(tmp, join(dir, `${name}.json`));
      written++;
    }
  } catch {
    // Not our folder, or no disk: the prompt below still asks Claude to subscribe.
  }
  return written;
}

/**
 * The hook's work: hand every PR the output names to this session's channel, and, when Claude itself just
 * opened one, tell it so. Returns the additionalContext, or null.
 */
/** `owner/name` of a GitHub remote URL (https, git@ or ssh://), or null. The channel's git.ts reads remotes the same way. */
export function repoOfRemote(url) {
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(
      String(url ?? "").trim(),
    );
  return m && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : null;
}

/** The repository the session's folder belongs to: its `origin` remote on GitHub, or null. */
function repoOfFolder(cwd) {
  if (typeof cwd !== "string" || !cwd) return null;
  try {
    return repoOfRemote(execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

/**
 * The text for Claude, or null. `launch` is called only when the output names a PR (it walks the process table);
 * `repoOf` gives the session folder's repository; `env` carries the plugin's settings.
 */
export function handle(input, { launch, root, now, env = process.env, repoOf = repoOfFolder }) {
  const prompt = contextFor(input);
  const prs = prsIn(input);
  if (!prs.length) return prompt;
  if (String(env.RUNNERS_IO_AUTO_SUBSCRIBE ?? "").trim().toLowerCase() === "off") return prompt;
  const own = repoOf(input?.cwd);
  const mine = own ? prs.filter((p) => p.repo.toLowerCase() === own.toLowerCase()) : [];
  if (!mine.length) return prompt;
  const l = launch();
  if (l?.state !== "on" || !l.claudePid) return prompt;
  const handed = handOver(mine, { claudePid: l.claudePid, root, now }) > 0;
  if (!prompt) return null;
  if (!handed) return prompt;
  // contextFor names the first PR URL in the output; it is handed over only if it is one of the session's own.
  const { repo, pr } = prs[0];
  if (!mine.some((p) => p.repo === repo && p.pr === pr)) return prompt;
  return (
    `runners-io is now watching ${repo} PR #${pr} for this session: no subscribe call is needed. ` +
    "Its CI results (workflows failing or waiting for approval, all checks finished) and merge conflicts arrive here as " +
    '<channel source="runners-io"> events. ' +
    "Do not poll CI yourself; call ci_status only to see the current state on demand."
  );
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const context = handle(input, { launch: () => findLaunch(process.ppid), root: defaultRoot(), now: Date.now() });
  if (!context) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } })}\n`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
