/**
 * What GitHub answers, noted for the next launch.
 *
 * Some ways a machine is not ready show only in GitHub's answers: a login it refuses, a classic token with no `repo`
 * scope, an organisation whose single sign-on the login is not authorised for, a certificate that does not verify
 * (a company network that inspects HTTPS). The channel tells the session about the first two as events, but a session
 * started without the channel flag is shown no event at all. So the client reports what each answer says about the
 * login (github.ts Observation), and this recorder keeps it in a small file in the plugin's state folder, which the
 * SessionStart hook reads at the next launch (hooks/readiness.mjs).
 *
 * The file holds kinds, counts and times, and where the token came from (`env` or `gh`). It holds no token, no
 * response body, and no repository or organisation name: an organisation is kept as 16 hex characters of a hash, only
 * so that one organisation's good answer does not clear another's refusal.
 *
 * A good answer takes a refusal off the record again. Writes are rare: a refusal is written at most once in
 * WRITE_EVERY_MS however often it is seen, and a good answer is written once and then costs nothing while there is
 * nothing to clear. Two sessions writing in the same instant can lose one of the two notes; the next answer of that
 * kind writes it again. Nothing
 * here can fail a read: every path is wrapped, and a state folder that cannot be written just means nothing is noted.
 */
import { clearFirstCall, ownerKey, projectKey, readFirstCall, recordFirstCall } from "../../hooks/readiness.mjs";
import type { Observation } from "./github.ts";

/** A kind already on the record is written again at most this often. */
export const WRITE_EVERY_MS = 10 * 60_000;

type Env = Record<string, string | undefined>;

/** The kinds a good answer clears: the first two whoever answers, the last two only for the organisation that answers. */
const CLEARED_BY_OK = ["token_rejected", "cert_error"] as const;
const CLEARED_BY_OWNER = ["sso", "forbidden"] as const;

function ownerOf(path: string): string | null {
  const m = /^\/repos\/([^/]+)\//.exec(path) ?? /^\/repos\/([^/]+)$/.exec(path);
  return m ? ownerKey(m[1]) : null;
}

export class FirstCallRecorder {
  private readonly env: Env;
  private readonly project: string;
  private readonly now: () => number;
  /** When each kind (and, for an organisation's refusal, each organisation) was last written by this process. */
  private readonly wrote = new Map<string, number>();
  /** The record's kinds as last read, each with its organisations: what a good answer could clear. */
  private present = new Map<string, Set<string>>();
  private presentAt = Number.NEGATIVE_INFINITY;

  constructor(env: Env, projectDir: string, now: () => number = Date.now) {
    this.env = env;
    this.project = projectKey(projectDir);
    this.now = now;
  }

  observe(o: Observation): void {
    try {
      const owner = ownerOf(o.path);
      switch (o.what) {
        case "ok": {
          const present = this.read();
          const clear: string[] = CLEARED_BY_OK.filter((k) => present.has(k));
          if (clear.length) this.clear(clear);
          if (owner) {
            const theirs = CLEARED_BY_OWNER.filter((k) => present.get(k)?.has(owner));
            if (theirs.length) this.clear(theirs, owner);
          }
          // Once on the record, a good answer is not written again until that entry has aged out of it.
          if (!this.read().has("ok")) this.record("ok", o);
          return;
        }
        case "repo_scope":
          if (this.read().has("no_repo_scope")) this.clear(["no_repo_scope"]);
          return;
        case "forbidden":
          // With gh's own login a plain 403 is most often a repository GitHub does not show, which is said elsewhere.
          if (o.source === "env") this.record("forbidden", o, owner);
          return;
        case "sso":
          this.record("sso", o, owner);
          return;
        default:
          this.record(o.what, o);
      }
    } catch {
      // never a reason to fail a read
    }
  }

  /** What GitHub says of this project's repository: a fork is noted under the project, and taken off when it is not one. */
  fork(isFork: boolean): void {
    try {
      const now = this.now();
      if (isFork) recordFirstCall(this.env, "fork", { project: this.project, now });
      else clearFirstCall(this.env, ["fork"], { project: this.project, now });
    } catch {
      // never a reason to fail a read
    }
  }

  private record(kind: string, o: Observation, owner: string | null = null): void {
    const now = this.now();
    const key = owner ? `${kind} ${owner}` : kind;
    const last = this.wrote.get(key);
    if (last !== undefined && now - last < WRITE_EVERY_MS) return;
    this.wrote.set(key, now);
    recordFirstCall(this.env, kind, { source: o.source, ...(owner ? { owner } : {}), now });
    this.presentAt = Number.NEGATIVE_INFINITY;
  }

  private clear(kinds: readonly string[], owner?: string): void {
    clearFirstCall(this.env, [...kinds], { ...(owner ? { owner } : {}), now: this.now() });
    for (const k of kinds) this.wrote.delete(owner ? `${k} ${owner}` : k);
    this.presentAt = Number.NEGATIVE_INFINITY;
  }

  /** The record's kinds, read again when this process changed it or the reading is older than WRITE_EVERY_MS. */
  private read(): Map<string, Set<string>> {
    const now = this.now();
    if (now - this.presentAt < WRITE_EVERY_MS) return this.present;
    const record = readFirstCall(this.env, now);
    this.present = new Map(Object.entries(record.kinds).map(([kind, entry]) => [kind, new Set(entry.owners ?? [])]));
    this.presentAt = now;
    return this.present;
  }
}
