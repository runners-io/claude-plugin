/**
 * Scopes: "every open pull request in this repository that the signed-in GitHub login opened" (`mine`, the default),
 * or, only when asked for by name, those that involve the login (`me`) or everybody's (`all`). A scope is set once for
 * a project and kept, so a restarted session goes on watching without being asked again, and Claude need not subscribe
 * to each pull request it opens there.
 *
 * ONLY THE USER'S OWN PULL REQUESTS UNLESS THEY OPT IN: another person's pull request
 * carries their text into the session. Until 0.3.16 an omitted `involves` meant `all`, and the file (version 1) did not
 * say whether `all` was chosen or only defaulted to. So a version 1 file is read with `all` as `mine` (`me` was always
 * a choice and is kept), the repositories narrowed are handed over once to be said (`takeNarrowed`), and the file is
 * rewritten as version 2, in which every `all` was asked for by name. The version is the marker: no entry carries one.
 * A plugin older than 0.3.16 that meets a version 2 file reports it as unreadable and leaves it alone (its scopes then
 * hold for that session only, and it writes nothing), which is what it does with any file it does not know.
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
import { machineError } from "./errors.ts";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { log } from "./log.ts";

/**
 * Raised whenever what the file holds changes shape or meaning; a file of a version not known here is reported, not
 * read. 2 (0.3.16): `involves` may be `mine`, and `all` is only ever one asked for by name.
 */
export const SCOPE_FORMAT = 2;
/** The version 0.3.13 to 0.3.15 wrote: read, with its `all` taken as `mine` (above), and rewritten as SCOPE_FORMAT. */
const LEGACY_FORMAT = 1;

export type Involves = "mine" | "me" | "all";
export const INVOLVES: readonly Involves[] = ["mine", "me", "all"];
/** What an omitted `involves` means: only the pull requests the signed-in login opened. */
export const DEFAULT_INVOLVES: Involves = "mine";

export interface RepoScope {
  readonly kind: "repo";
  /** owner/name, as the user gave it; compared without regard to case, as GitHub does. */
  readonly repo: string;
  /**
   * `mine`: the open pull requests the signed-in GitHub login opened. `me`: those it opened, is assigned to or is asked
   * to review. `all`: every open pull request. The last two only when asked for by name.
   */
  readonly involves: Involves;
  /**
   * Always "all": a scope's pull requests are not narrowed by kind. What they push is what the branch's own pull
   * request pushes (subscriptions.ts AUTO_EVENTS): every kind but the per-workflow successes and starts.
   */
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
    Object.keys(v).length === 4 && v.kind === "repo" && isRepoName(v.repo) && INVOLVES.includes(v.involves as Involves) && v.events === "all"
  );
}

/** An entry as a version 1 file holds one: `mine` did not exist yet. */
const isLegacyScope = (value: unknown): value is Scope => isScope(value) && value.involves !== "mine";

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `narrowed`: the repositories whose `all`, in a version 1 file, was read as `mine`; the file then wants rewriting. */
type Read = { kind: "ok"; scopes: Scope[]; legacy?: { narrowed: string[] } } | { kind: "problem"; text: string };

/** The most narrowed repositories kept to be said: a project's file holds a handful of scopes. */
const NARROWED_KEPT = 50;

export class ScopeStore {
  /** Why the file is not used, naming it; null while it is read and written normally (or there is no file). */
  problem: string | null = null;
  private scopes: Scope[] = [];
  /** Repositories narrowed from a version 1 file and not yet said (lower-cased key, the name as saved). */
  private readonly narrowed = new Map<string, string>();
  /** Every repository ever put in `narrowed` (lower-cased): a file that could not be rewritten is read again, and said once. */
  private readonly narrowedSeen = new Set<string>();
  private saidNotRewritten = false;
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

  /**
   * The repositories whose scope was saved before 0.3.16 with `all`, which an omitted `involves` also saved, and is now
   * read as `mine`: handed over once, for the session to be told. One set again since is no longer among them.
   */
  takeNarrowed(): string[] {
    const repos = [...this.narrowed.values()];
    this.narrowed.clear();
    return repos;
  }

  /** Sets a scope, replacing any for the same repository. `saved` is false when it holds for this session only. */
  add(scope: Scope): AddResult {
    if (!isScope(scope)) return { ok: false, text: "repo must be owner/name as GitHub allows it, for example acme/widgets." };
    this.narrowed.delete(scope.repo.toLowerCase()); // chosen afresh: nothing is left to say about the old one
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
      if (r.legacy) {
        for (const repo of r.legacy.narrowed) {
          const key = repo.toLowerCase();
          if (this.narrowedSeen.has(key) || this.narrowedSeen.size >= NARROWED_KEPT) continue;
          this.narrowedSeen.add(key);
          this.narrowed.set(key, repo);
        }
        // Rewritten at once in the new format, so the project's next session reads it as it stands and is told nothing.
        // A write that fails leaves the old file: it is read, narrowed and tried again at the next reload.
        try {
          this.write(this.file);
        } catch (error) {
          if (!this.saidNotRewritten) log(`The scope file ${this.file} could not be rewritten in the new format (${(error as Error).message}); it is read as before.`);
          this.saidNotRewritten = true;
        }
      }
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
      const legacy = typeof json === "object" && json !== null && doc.version === LEGACY_FORMAT;
      if (typeof json !== "object" || json === null || (doc.version !== SCOPE_FORMAT && !legacy) || !Array.isArray(doc.scopes)) {
        return unreadable(`it is not a version ${SCOPE_FORMAT} scope file`);
      }
      if (!doc.scopes.every(legacy ? isLegacyScope : isScope)) return unreadable("it holds an entry that is not a valid scope");
      const scopes = doc.scopes.map((x) => ({ ...(x as Scope) }));
      if (!legacy) return { kind: "ok", scopes };
      // Version 1 did not say whether `all` was chosen or only the default of the day: not known is not a yes.
      const narrowed = scopes.filter((x) => x.involves === "all").map((x) => x.repo);
      return { kind: "ok", scopes: scopes.map((x) => (x.involves === "all" ? { ...x, involves: DEFAULT_INVOLVES } : x)), legacy: { narrowed } };
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
    if (foreign) throw machineError(foreign);
    chmodSync(folder, 0o700);
    const why = this.distrust(lstatSync(folder), "its folder");
    if (why) throw machineError(why);
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

/**
 * An open pull request, as discovery keeps it: its number, its head commit, who opened it and the logins it involves. None of
 * GitHub's free text (title, body, branch or label names) is kept.
 */
export interface OpenPull {
  readonly number: number;
  readonly headSha: string;
  /**
   * The logins the list itself names for it, lower-cased: who opened it, who is assigned to it and who is asked to
   * review it. A scope with `involves: "me"` is decided from these alone, with no further request, so somebody who
   * only commented, and a review asked of a team, are not counted.
   */
  readonly involved: readonly string[];
  /**
   * The login that opened it, lower-cased, or null when the list names none a login could be. A scope with
   * `involves: "mine"` is decided from this alone: null is nobody's, so not the signed-in login's.
   */
  readonly author: string | null;
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
/** A GitHub login as discovery keeps one: a user's, or an app's (`name[bot]`). Anything else is dropped. */
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}(\[bot\])?$/;

/** The one request discovery makes, or null for a repository name GitHub would not allow. */
export function openPullsPath(repo: string): string | null {
  if (!isRepoName(repo)) return null;
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=${DISCOVERY_PAGE}`;
}

/** What the list's answer holds, or null when it is not a list: the well-formed open pull requests, newest first. */
export function parseOpenPulls(body: unknown): { pulls: OpenPull[]; full: boolean } | null {
  if (!Array.isArray(body)) return null;
  const pulls: OpenPull[] = [];
  for (const item of body as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as { number?: unknown; state?: unknown; head?: { sha?: unknown } | null; user?: unknown; assignees?: unknown; requested_reviewers?: unknown };
    if (typeof p.number !== "number" || !Number.isInteger(p.number) || p.number < 1 || p.state !== "open") continue;
    const sha = p.head?.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) continue;
    const involved = new Set<string>();
    const loginOf = (who: unknown): string | null => {
      const login = typeof who === "object" && who !== null ? (who as { login?: unknown }).login : undefined;
      return typeof login === "string" && LOGIN.test(login.toLowerCase()) ? login.toLowerCase() : null;
    };
    for (const who of [p.user, ...(Array.isArray(p.assignees) ? p.assignees : []), ...(Array.isArray(p.requested_reviewers) ? p.requested_reviewers : [])]) {
      const login = loginOf(who);
      if (login !== null) involved.add(login);
    }
    pulls.push({ number: p.number, headSha: sha, involved: [...involved].sort(), author: loginOf(p.user) });
  }
  pulls.sort((a, b) => b.number - a.number);
  return { pulls, full: body.length >= DISCOVERY_PAGE };
}

/**
 * Whether a stored list (shared.ts) has the shape parseOpenPulls gives: another process of this user can write the
 * store. A list with no `author` on an entry is one a session older than 0.3.16 stored: it is not used (GitHub is asked
 * instead, a free 304 while the list is unchanged), since a `mine` scope decided from it would hold nothing.
 */
export function isOpenPulls(value: unknown): value is { pulls: OpenPull[]; full: boolean } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { pulls?: unknown; full?: unknown };
  return (
    typeof v.full === "boolean" &&
    Array.isArray(v.pulls) &&
    v.pulls.every((p) => {
      if (typeof p !== "object" || p === null) return false;
      const x = p as { number?: unknown; headSha?: unknown; involved?: unknown; author?: unknown };
      return (
        typeof x.number === "number" &&
        Number.isSafeInteger(x.number) &&
        x.number > 0 &&
        typeof x.headSha === "string" &&
        SHA.test(x.headSha) &&
        Array.isArray(x.involved) &&
        x.involved.every((l) => typeof l === "string" && LOGIN.test(l)) &&
        (x.author === null || (typeof x.author === "string" && LOGIN.test(x.author)))
      );
    })
  );
}

/**
 * A repository's open pull requests: `GET /repos/{owner}/{name}/pulls?state=open&per_page=100`, sent with the
 * previous answer's ETag. The repository name is checked before it is put in the path. The poller makes the same
 * request through its GitHub client (github.ts `openPulls`), which shares the answer between sessions.
 */
export async function discoverRepoPulls(get: JsonGet, repo: string, previous: Extract<Discovered, { kind: "ok" }> | null): Promise<Discovered> {
  const path = openPullsPath(repo);
  if (path === null) return { kind: "invalid" };
  let res: Awaited<ReturnType<JsonGet>>;
  try {
    res = await get(path, previous?.etag ?? null);
  } catch {
    return { kind: "error", status: 0 };
  }
  if (res.status === 304 && previous) return { ...previous, changed: false };
  const parsed = res.status === 200 ? parseOpenPulls(res.body) : null;
  if (!parsed) return { kind: "error", status: res.status };
  return { kind: "ok", pulls: parsed.pulls, etag: res.etag, changed: true, full: parsed.full };
}
