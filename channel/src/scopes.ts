/**
 * Scopes: "every open pull request in this repository", or only those that involve the signed-in GitHub login. A
 * scope is set once for a project and kept, so a restarted session goes on watching without being asked again, and
 * Claude need not subscribe to each pull request it opens there.
 *
 * Unlike a subscription (subscriptions.ts, in memory only), a scope is written to disk: one file per project, at
 * `<data folder>/scopes/<hash of the project folder>.json`, 0600 in a 0700 folder. It holds the repository names and
 * the choices made, nothing GitHub sent and no token. The file is:
 *
 * - read when the store is made, and read again before each change, so two sessions in one project do not undo each
 *   other's change;
 * - never trusted when it is a symlink, belongs to another user, or another user could write to it or its folder;
 * - never silently replaced when it cannot be read: the store then keeps its scopes in memory for this session, says
 *   why in `problem` (which names the file), and leaves the file as it is for the user to fix or remove.
 *
 * Nothing here throws on a bad file or a failed write.
 *
 * Discovery (`discoverRepoPulls`) turns a repository scope into the repository's open pull requests, with one
 * conditional request: an unchanged list is a 304, which GitHub does not count against the hourly limit.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { log } from "./log.ts";

/** Raised whenever what the file holds changes shape; a file of another version is reported, not read. */
export const SCOPE_FORMAT = 1;

export type Involves = "all" | "me";

export interface RepoScope {
  readonly kind: "repo";
  /** owner/name, as the user gave it; compared without regard to case, as GitHub does. */
  readonly repo: string;
  /** `all`: every open pull request. `me`: those that involve the signed-in GitHub login. */
  readonly involves: Involves;
  /** Every event kind is pushed for a scope's pull requests. */
  readonly events: "all";
}

export type Scope = RepoScope;

export type AddResult = { readonly ok: true; readonly saved: boolean } | { readonly ok: false; readonly text: string };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Whether `repo` is an owner/name GitHub allows: an owner of 1 to 39 letters, digits or hyphens, not starting with a
 * hyphen, and a name of 1 to 100 letters, digits, `.`, `_` or `-` that is not `.` or `..`. Anything else is refused
 * before it reaches a path or a URL.
 */
export function isRepoName(repo: unknown): repo is string {
  if (typeof repo !== "string") return false;
  const parts = repo.split("/");
  if (parts.length !== 2) return false;
  const [owner, name] = parts as [string, string];
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== "..";
}

/**
 * Where scopes are kept: the plugin's own data folder when Claude Code gives one (`CLAUDE_PLUGIN_DATA`), else
 * `$XDG_STATE_HOME/runners-io`, else `~/.local/state/runners-io`.
 */
export function defaultScopeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_PLUGIN_DATA && isAbsolute(env.CLAUDE_PLUGIN_DATA)) return env.CLAUDE_PLUGIN_DATA;
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, "runners-io");
  return join(homedir(), ".local", "state", "runners-io");
}

/** The one file a project's scopes are kept in. The project folder is hashed, so the file name says nothing of it. */
export function scopeFile(root: string, projectDir: string): string {
  const id = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 32);
  return join(root, "scopes", `${id}.json`);
}

function isScope(value: unknown): value is Scope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 && v.kind === "repo" && isRepoName(v.repo) && (v.involves === "all" || v.involves === "me") && v.events === "all"
  );
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Read = { kind: "ok"; scopes: Scope[] } | { kind: "problem"; text: string };

export class ScopeStore {
  /** Why the file is not used, naming it; null while it is read and written normally (or there is no file). */
  problem: string | null = null;
  private scopes: Scope[] = [];
  private readonly file: string | null;
  private readonly uid: number | undefined;

  /** `file` null: in memory only. `uid` is the user the file must belong to: this process's, unless a test says otherwise. */
  constructor(file: string | null, options: { uid?: number } = {}) {
    this.file = file;
    this.uid = options.uid ?? process.getuid?.();
    this.reload();
  }

  list(): Scope[] {
    return this.scopes.map((s) => ({ ...s }));
  }

  /** Sets a scope, replacing any for the same repository. `saved` is false when it holds for this session only. */
  add(scope: Scope): AddResult {
    if (!isScope(scope)) return { ok: false, text: "repo must be owner/name as GitHub allows it, for example acme/widgets." };
    return { ok: true, saved: this.change((list) => [...list.filter((s) => !sameRepo(s.repo, scope.repo)), { ...scope }]) };
  }

  /** Removes the scope for `repo`. Answers how many were removed (0 or 1). */
  remove(repo: string): number {
    if (!this.scopes.some((s) => sameRepo(s.repo, repo))) {
      // Another session in this project may have set it since this one last read the file.
      this.reload();
      if (!this.scopes.some((s) => sameRepo(s.repo, repo))) return 0;
    }
    this.change((list) => list.filter((s) => !sameRepo(s.repo, repo)));
    return 1;
  }

  /** Reads the file again; on a problem the scopes in memory are kept and the problem is reported. */
  reload(): void {
    if (this.file === null) return;
    const r = this.read(this.file);
    if (r.kind === "ok") {
      this.scopes = r.scopes;
      this.problem = null;
    } else if (this.problem !== r.text) {
      this.problem = r.text;
      log(r.text);
    }
  }

  /** Applies `edit` to the newest scopes (the file's, when it is usable) and writes them. True when written. */
  private change(edit: (list: Scope[]) => Scope[]): boolean {
    this.reload();
    this.scopes = edit(this.scopes);
    if (this.file === null || this.problem !== null) return false;
    try {
      this.write(this.file);
      return true;
    } catch (error) {
      this.problem = `The scope file ${this.file} could not be written (${(error as Error).message}), so scopes hold for this session only.`;
      log(this.problem);
      return false;
    }
  }

  private read(file: string): Read {
    const untrusted = (why: string): Read => ({
      kind: "problem",
      text: `The scope file ${file} is not trusted (${why}), so it was not read and will not be written: remove it, then set the scope again.`,
    });
    const unreadable = (why: string): Read => ({
      kind: "problem",
      text: `The scope file ${file} could not be read (${why}), so it was left as it is and scopes hold for this session only: fix or remove it.`,
    });
    try {
      const folder = lstatSync(dirname(file), { throwIfNoEntry: false });
      if (!folder) return { kind: "ok", scopes: [] };
      const why = this.distrust(folder, "its folder");
      if (why) return untrusted(why);
      const s = lstatSync(file, { throwIfNoEntry: false });
      if (!s) return { kind: "ok", scopes: [] };
      if (s.isSymbolicLink()) return untrusted("it is a symlink");
      if (!s.isFile()) return untrusted("it is not a plain file");
      const fileWhy = this.distrust(s, "it");
      if (fileWhy) return untrusted(fileWhy);
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return unreadable("it is not JSON");
      }
      const doc = json as { version?: unknown; scopes?: unknown };
      if (typeof json !== "object" || json === null || doc.version !== SCOPE_FORMAT || !Array.isArray(doc.scopes)) {
        return unreadable(`it is not a version ${SCOPE_FORMAT} scope file`);
      }
      if (!doc.scopes.every(isScope)) return unreadable("it holds an entry that is not a valid scope");
      return { kind: "ok", scopes: doc.scopes.map((x) => ({ ...(x as Scope) })) };
    } catch (error) {
      return unreadable((error as NodeJS.ErrnoException).code ?? "an error");
    }
  }

  /** Why a file or folder is not to be trusted, or null: another user's, or writable by others. */
  private distrust(s: { uid: number; mode: number; isSymbolicLink(): boolean }, what: string): string | null {
    if (s.isSymbolicLink()) return `${what} is a symlink`;
    if (this.uid !== undefined && s.uid !== this.uid) return `${what} belongs to another user`;
    if (s.mode & 0o022) return `another user could write to ${what}`;
    return null;
  }

  private write(file: string): void {
    const folder = dirname(file);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // A symlink or another user's folder is refused BEFORE the chmod: chmod follows a symlink, so tightening first
    // would change the mode of whatever the link points at. Only a folder of our own is tightened, then checked again.
    const before = lstatSync(folder);
    const foreign = this.distrust({ uid: before.uid, mode: 0, isSymbolicLink: () => before.isSymbolicLink() }, "its folder");
    if (foreign) throw new Error(foreign);
    chmodSync(folder, 0o700);
    const why = this.distrust(lstatSync(folder), "its folder");
    if (why) throw new Error(why);
    const doc = `${JSON.stringify({ version: SCOPE_FORMAT, scopes: this.scopes }, null, 2)}\n`;
    // Written beside it and renamed over it, so a reader never sees half a file.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, doc, { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** One conditional JSON GET: the poller passes its GitHub client's; a test passes its own. `etag` null: unconditional. */
export type JsonGet = (path: string, etag: string | null) => Promise<{ status: number; etag: string | null; body: unknown }>;

/** An open pull request, as discovery keeps it: its number and head commit, and none of GitHub's text. */
export interface OpenPull {
  readonly number: number;
  readonly headSha: string;
}

export type Discovered =
  | {
      readonly kind: "ok";
      /** Newest first. */
      readonly pulls: readonly OpenPull[];
      readonly etag: string | null;
      /** False when GitHub answered 304: the list is the previous one. */
      readonly changed: boolean;
      /** True when the page came back full (100), so the repository may hold more open pull requests than these. */
      readonly full: boolean;
    }
  | { readonly kind: "invalid" }
  /** GitHub's status (0: no answer). Only the status: a body is GitHub's text and is not kept. */
  | { readonly kind: "error"; readonly status: number };

export const DISCOVERY_PAGE = 100;
const SHA = /^[0-9a-f]{40}$/;

/**
 * A repository's open pull requests: `GET /repos/{owner}/{name}/pulls?state=open&per_page=100`, sent with the
 * previous answer's ETag. The repository name is checked before it is put in the path.
 */
export async function discoverRepoPulls(get: JsonGet, repo: string, previous: Extract<Discovered, { kind: "ok" }> | null): Promise<Discovered> {
  if (!isRepoName(repo)) return { kind: "invalid" };
  const [owner, name] = repo.split("/") as [string, string];
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=${DISCOVERY_PAGE}`;
  let res: Awaited<ReturnType<JsonGet>>;
  try {
    res = await get(path, previous?.etag ?? null);
  } catch {
    return { kind: "error", status: 0 };
  }
  if (res.status === 304 && previous) return { ...previous, changed: false };
  if (res.status !== 200 || !Array.isArray(res.body)) return { kind: "error", status: res.status };
  const pulls: OpenPull[] = [];
  for (const item of res.body as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as { number?: unknown; state?: unknown; head?: { sha?: unknown } | null };
    if (typeof p.number !== "number" || !Number.isInteger(p.number) || p.number < 1 || p.state !== "open") continue;
    const sha = p.head?.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) continue;
    pulls.push({ number: p.number, headSha: sha });
  }
  pulls.sort((a, b) => b.number - a.number);
  return { kind: "ok", pulls, etag: res.etag, changed: true, full: res.body.length >= DISCOVERY_PAGE };
}
