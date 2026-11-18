/**
 * The machine-wide store that lets several Claude Code sessions with this channel share their GitHub reads.
 *
 * Without it, every session asked GitHub for the same pull requests on its own, so six sessions watching one
 * PR cost six times the requests, all against the same login's hourly limit. With it, a request path is asked
 * of GitHub at most once per freshness window on this machine:
 *
 * - the session that wants a path whose stored answer is too old takes that path's LEASE (a lock file holding
 *   its pid), asks GitHub with the stored ETag, and writes the answer back;
 * - every other session reads the stored answer and makes no request at all;
 * - a lease whose process is gone, or that is older than LEASE_MS, is taken over, so a session that dies
 *   holding one stops nobody.
 *
 * There is one store per GitHub login (the API address and the token, hashed): two logins can see different
 * repositories, so they never share. It lives in `$XDG_CACHE_HOME/runners-io` (else `~/.cache/runners-io`),
 * 0700, with 0600 files. It holds no token and no response body: only the fields the channel reads (the
 * values github.ts maps an answer to), the ETag, and the rate limit left. Anything that goes wrong with it is
 * not an outage: the session falls back to asking GitHub itself, as it did before the store existed.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "./log.ts";

/** A lease older than this is taken over even if its process looks alive (a pid can be reused). */
export const LEASE_MS = 30_000;
/** Stored answers are deleted once they are this old. */
const PRUNE_MS = 24 * 60 * 60_000;

export interface Stored<T = unknown> {
  readonly path: string;
  readonly etag: string;
  readonly value: T;
  /** When GitHub last answered for this path (a 200 or a 304), on the asker's clock. */
  readonly at: number;
}

export function defaultSharedRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "runners-io");
}

export class SharedStore {
  private readonly root: string;
  private readonly logins = new Map<string, LoginStore | null>();

  constructor(root: string) {
    this.root = root;
  }

  /** The file name a request path is stored under. */
  keyFor(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 24);
  }

  /** The store for one login, or null when it cannot be used (the session then asks GitHub itself). */
  forLogin(apiBase: string, token: string): LoginStore | null {
    const id = createHash("sha256").update(`${apiBase}\n${token}`).digest("hex").slice(0, 20);
    if (this.logins.has(id)) return this.logins.get(id) ?? null;
    let store: LoginStore | null = null;
    try {
      const dir = join(this.root, id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(this.root, 0o700);
      chmodSync(dir, 0o700);
      store = new LoginStore(dir, (path) => this.keyFor(path));
      store.prune(Date.now());
    } catch (error) {
      log(`the shared store cannot be used, so this session asks GitHub itself: ${(error as Error).message}`);
    }
    this.logins.set(id, store);
    return store;
  }
}

export class LoginStore {
  readonly dir: string;
  private readonly keyFor: (path: string) => string;

  constructor(dir: string, keyFor: (path: string) => string) {
    this.dir = dir;
    this.keyFor = keyFor;
  }

  read<T>(path: string): Stored<T> | null {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, `${this.keyFor(path)}.json`), "utf8")) as Stored<T>;
      return s && s.path === path && typeof s.etag === "string" && typeof s.at === "number" && "value" in s ? s : null;
    } catch {
      return null;
    }
  }

  write(entry: Stored): void {
    this.atomic(`${this.keyFor(entry.path)}.json`, JSON.stringify(entry));
  }

  /** Takes the path's lease; returns its release, or null while another live process holds it. */
  lease(path: string, now: number): (() => void) | null {
    const file = join(this.dir, `${this.keyFor(path)}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx", mode: 0o600 });
        return () => {
          try {
            const held = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; at?: number };
            if (held.pid === process.pid && held.at === now) unlinkSync(file);
          } catch {}
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return () => {}; // no lease to be had: ask anyway
      }
      let held: { pid?: number; at?: number } = {};
      try {
        held = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      const abandoned = typeof held.at !== "number" || now - held.at > LEASE_MS || !alive(held.pid);
      if (!abandoned) return null;
      try {
        unlinkSync(file);
      } catch {}
    }
    return null;
  }

  readRate(): { remaining: number; at: number } | null {
    try {
      const r = JSON.parse(readFileSync(join(this.dir, "rate.json"), "utf8")) as { remaining?: unknown; at?: unknown };
      return typeof r.remaining === "number" && typeof r.at === "number" ? { remaining: r.remaining, at: r.at } : null;
    } catch {
      return null;
    }
  }

  writeRate(remaining: number, at: number): void {
    this.atomic("rate.json", JSON.stringify({ remaining, at }));
  }

  prune(now: number): void {
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      try {
        if (now - statSync(p).mtimeMs > PRUNE_MS) unlinkSync(p);
      } catch {}
    }
  }

  private atomic(name: string, text: string): void {
    try {
      const tmp = join(this.dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}`);
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, join(this.dir, name));
    } catch (error) {
      log(`could not write to the shared store: ${(error as Error).message}`);
    }
  }
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // alive, but another user's
  }
}
