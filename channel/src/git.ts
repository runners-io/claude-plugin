/**
 * Which repository and branch the session is in, read from git in the
 * project directory every poll, so a `git switch` mid-session moves the
 * channel to the new branch without a restart.
 *
 * git is run with execFile (no shell), a fixed argv and a short timeout, by its absolute path from PATH
 * (hooks/programs.mjs): the folder it reads is a repository, and a file named git in it must never be the one that runs.
 */
import { execFile } from "node:child_process";

import { findProgram } from "../../hooks/programs.mjs";
import { readsGitHubCom } from "../../hooks/proxy.mjs";

export interface GitScope {
  /** `owner/name` on GitHub, or null when origin is not a GitHub remote, or not on the GitHub host the plugin reads. */
  readonly repo: string | null;
  /** The checked-out branch, or null when HEAD is detached or there is no repo. */
  readonly branch: string | null;
  /**
   * The commit `origin/<branch>` names in this clone (`refs/remotes/origin/<branch>`), or null when there is none. A
   * `git push` from the session's folder moves it, so a change is the session's own push (cadence.ts OWN_PUSH_FAST_MS);
   * `readPushed` reads the same ref for every other watched PR's branch, which a push from a worktree moves.
   * Read from the clone, never from GitHub. Absent where a scope is not read from git.
   */
  readonly pushed?: string | null;
  /**
   * `owner/name` of the clone's `upstream` remote, when it is a GitHub repository other than origin: by convention the
   * repository a fork was forked from, where the fork's pull requests live (forks.ts). Absent otherwise.
   */
  readonly upstream?: string | null;
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]{1,100}?";
const REMOTES = [
  // git@github.com:owner/name(.git)
  new RegExp(`^git@github\\.com:(${OWNER})/(${NAME})(?:\\.git)?/?$`),
  // ssh://git@github.com/owner/name(.git), optionally with :22
  new RegExp(`^ssh://git@github\\.com(?::22)?/(${OWNER})/(${NAME})(?:\\.git)?/?$`),
  // https://github.com/owner/name(.git), optionally with userinfo (a token in a remote URL is not read)
  new RegExp(`^https://(?:[^@/]+@)?github\\.com/(${OWNER})/(${NAME})(?:\\.git)?/?$`),
];

export function parseGitHubRemote(url: string): string | null {
  const trimmed = url.trim();
  for (const pattern of REMOTES) {
    const m = pattern.exec(trimmed);
    if (m && m[2] !== "." && m[2] !== "..") return `${m[1]}/${m[2]}`;
  }
  return null;
}

function git(dir: string, args: string[]): Promise<string | null> {
  // Looked up at every call: cheap, and a git installed mid-session is found without a restart. None: as a git that failed.
  const program = findProgram("git");
  if (!program) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(program, ["-C", dir, ...args], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

/**
 * `env` says which GitHub host the plugin reads. A remote is read as a repository only when it is on that host: the
 * remotes understood here are github.com's, so while RUNNERS_IO_GITHUB_API names another host they name no repository
 * (hooks/proxy.mjs readsGitHubCom). Asked of another server, `owner/name` is somebody else's repository, and its
 * answer would be reported as this one's. A remote on any other host never names one, whatever the setting.
 */
export async function readGitScope(dir: string, env: Record<string, string | undefined> = process.env): Promise<GitScope> {
  const [remote, branch, upstreamUrl] = await Promise.all([
    git(dir, ["remote", "get-url", "origin"]),
    git(dir, ["branch", "--show-current"]),
    git(dir, ["remote", "get-url", "upstream"]),
  ]);
  const here = readsGitHubCom(env);
  const repo = here && remote ? parseGitHubRemote(remote) : null;
  const upstream = here && upstreamUrl ? parseGitHubRemote(upstreamUrl) : null;
  // A branch name git itself gave, after `refs/remotes/origin/`, so it cannot be read as an option; no shell runs.
  const pushed = branch ? await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) : null;
  return {
    repo,
    branch: branch ? branch : null,
    pushed: pushed && /^[0-9a-f]{40}$/.test(pushed) ? pushed : null,
    ...(repo && upstream && upstream.toLowerCase() !== repo.toLowerCase() ? { upstream } : {}),
  };
}

/**
 * A branch name as GitHub gives a pull request's head, safe to put after `refs/remotes/origin/` as one argv entry: no
 * space or control character, none of git's glob characters (so a pattern matches only its own ref, or refs below it),
 * no `..`, no leading or trailing slash. git's own rules refuse all of these in a ref name, so nothing real is lost.
 */
function safeBranch(b: string): boolean {
  if (b.length === 0 || b.length > 255 || b.startsWith("/") || b.endsWith("/") || b.includes("..")) return false;
  for (const c of b) {
    const code = c.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || "*?[\\^~:".includes(c) || /\s/.test(c)) return false;
  }
  return true;
}

/**
 * The commit `refs/remotes/origin/<b>` names in this clone, for each of `branches`: null for a branch with no such
 * ref. One `git for-each-ref` for all of them, never a GitHub request.
 *
 * Every git worktree of a clone shares its `refs/remotes`, so `git push` from any worktree moves the ref here, in the
 * session's folder; a `git fetch` moves it too. A change is taken for the session's own push (cadence.ts
 * OWN_PUSH_FAST_MS). null when git did not answer (no repository, a timeout), which is no reading at all.
 */
export async function readPushed(dir: string, branches: readonly string[]): Promise<Map<string, string | null> | null> {
  const wanted = [...new Set(branches)].filter(safeBranch);
  const out = new Map<string, string | null>(wanted.map((b) => [b, null]));
  if (wanted.length === 0) return out;
  // A pattern also matches refs below it (origin/feat matches origin/feat/x), so the answer is filtered to exact names.
  const listed = await git(dir, ["for-each-ref", "--format=%(objectname) %(refname)", ...wanted.map((b) => `refs/remotes/origin/${b}`)]);
  if (listed === null) return null;
  for (const line of listed.split("\n")) {
    const m = /^([0-9a-f]{40}) refs\/remotes\/origin\/(.+)$/.exec(line);
    if (m && out.has(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Whether a commit is this work tree's own: its HEAD, or behind its HEAD. A new PR head that is not is
 * `pr.head_moved`: someone (another person, another session, another worktree) pushed it.
 *
 * Not "is the commit anywhere in this repository": git worktrees share one object store, so a commit made in
 * another worktree of the same clone is already present here, and an "is it present" rule misses that push.
 * null when this is not a work tree or the sha is not a sha.
 */
export async function inOwnHistory(dir: string, sha: string): Promise<boolean | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;
  return (await git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"])) !== null;
}
