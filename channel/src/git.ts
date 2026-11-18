/**
 * Which repository and branch the session is in, read from git in the
 * project directory every poll, so a `git switch` mid-session moves the
 * channel to the new branch without a restart.
 *
 * git is run with execFile (no shell), a fixed argv and a short timeout.
 */
import { execFile } from "node:child_process";

export interface GitScope {
  /** `owner/name` on GitHub, or null when origin is not a GitHub remote. */
  readonly repo: string | null;
  /** The checked-out branch, or null when HEAD is detached or there is no repo. */
  readonly branch: string | null;
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
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

export async function readGitScope(dir: string): Promise<GitScope> {
  const [remote, branch] = await Promise.all([
    git(dir, ["remote", "get-url", "origin"]),
    git(dir, ["branch", "--show-current"]),
  ]);
  return {
    repo: remote ? parseGitHubRemote(remote) : null,
    branch: branch ? branch : null,
  };
}

/**
 * Whether a commit is this work tree's own: its HEAD, or behind its HEAD. A new PR head that is not is
 * `pr.head_moved`: someone (another person, another session, another worktree) pushed it.
 *
 * Not "is the commit anywhere in this repository": git worktrees share one object store, so a commit made in
 * another worktree of the same clone is already present here. That is how the first rule missed a push on
 * 2026-11-18. null when this is not a work tree or the sha is not a sha.
 */
export async function inOwnHistory(dir: string, sha: string): Promise<boolean | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;
  return (await git(dir, ["merge-base", "--is-ancestor", sha, "HEAD"])) !== null;
}
