/**
 * PRs handed over by the PostToolUse hook (hooks/pr-created.mjs), so a PR is watched without Claude having to call
 * subscribe: scripts open most PRs, and their command text never says `gh pr create`.
 *
 * The hook writes one file per PR under `<root>/requests/<claude pid>/`. The channel is a child of that Claude
 * process (main.ts uses process.ppid), so each session reads only its own folder. A request says only "this PR
 * was named": whether to watch it (the session's own repository, opened by the signed-in login, new, within the
 * limits) is the poller's call, from GitHub's own answers. A request older than REQUEST_MAX_AGE_MS is dropped: the
 * hook writes it the moment the PR is named, so an old one was left by another session whose pid this one reused.
 */
import { lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface HookRequest {
  readonly repo: string;
  readonly pr: number;
  /** When the hook saw it, ms since the epoch. */
  readonly at: number;
}

/** A request older than this is not this session's: dropped unread. */
export const REQUEST_MAX_AGE_MS = 5 * 60_000;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** True only for a real folder (not a symlink) owned by this user that no one else can write to. */
function safeFolder(dir: string, uid: number | undefined): boolean {
  try {
    const s = lstatSync(dir);
    if (s.isSymbolicLink() || !s.isDirectory()) return false;
    if (uid !== undefined && s.uid !== uid) return false;
    return (s.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function parse(text: string): HookRequest | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v.repo !== "string" || !REPO.test(v.repo) || v.repo.split("/")[1].startsWith(".")) return null;
    if (typeof v.pr !== "number" || !Number.isSafeInteger(v.pr) || v.pr < 1) return null;
    if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
    return { repo: v.repo, pr: v.pr, at: v.at };
  } catch {
    return null;
  }
}

/**
 * Takes this Claude process's requests: each file is read once and deleted, a malformed one too. A folder that
 * is not plainly the user's own (another owner, a symlink, writable by others) is left alone and gives nothing.
 */
export function takeRequests(root: string, claudePid: number, uid: number | undefined = process.getuid?.(), now = Date.now()): HookRequest[] {
  const requests = join(root, "requests");
  const dir = join(requests, String(claudePid));
  if (!safeFolder(requests, uid) || !safeFolder(dir, uid)) return [];
  const out: HookRequest[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // the hook's half-written temporary files start with a dot
    const file = join(dir, name);
    let text = "";
    try {
      const s = lstatSync(file);
      if (!s.isFile()) continue;
      text = readFileSync(file, "utf8");
      unlinkSync(file);
    } catch {
      continue;
    }
    const r = parse(text);
    if (r && now - r.at > REQUEST_MAX_AGE_MS) continue;
    if (r && !out.some((o) => o.repo.toLowerCase() === r.repo.toLowerCase() && o.pr === r.pr)) out.push(r);
  }
  return out;
}

/** At start: whatever is in this pid's folder was left by an earlier process with the same pid. Taken and dropped. */
export function resetRequests(root: string, claudePid: number, uid: number | undefined = process.getuid?.()): void {
  takeRequests(root, claudePid, uid, Number.POSITIVE_INFINITY);
}

/**
 * At exit: the folder goes, so a later process given the same pid starts with none. A symlink is unlinked, never
 * followed, and nothing is removed under a `requests` folder that is not plainly the user's own (takeRequests' check):
 * a `requests` that is a symlink would otherwise lead the removal into whatever folder it points at.
 */
export function removeRequests(root: string, claudePid: number, uid: number | undefined = process.getuid?.()): void {
  const requests = join(root, "requests");
  const dir = join(requests, String(claudePid));
  if (!safeFolder(requests, uid)) return;
  try {
    const s = lstatSync(dir);
    if (s.isSymbolicLink()) unlinkSync(dir);
    else if (safeFolder(dir, uid)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // nothing there
  }
}
