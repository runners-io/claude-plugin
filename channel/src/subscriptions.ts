/**
 * What this session watches. In memory only: the channel is one process per
 * Claude Code session, so a subscription lives exactly as long as the
 * session, and two sessions never share one.
 */
import type { EventKind, Snapshot } from "./state.ts";

export type Source = "tool" | "auto";

export interface Entry {
  readonly key: string;
  readonly repo: string;
  readonly pr: number;
  readonly events: ReadonlySet<EventKind> | "all";
  /** Who asked: Claude through the subscribe tool, or the channel for the current branch. */
  readonly source: Source;
  /** The state last seen, or null before the first look. */
  last: Snapshot | null;
}

export function keyOf(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

export function wants(entry: Entry, kind: EventKind): boolean {
  return entry.events === "all" || entry.events.has(kind);
}

export class Subscriptions {
  private readonly entries = new Map<string, Entry>();

  /** Adds or replaces. Claude's own subscription is never downgraded to an automatic one. */
  add(input: { repo: string; pr: number; events?: readonly EventKind[] | "all"; source: Source; last?: Snapshot | null }): Entry {
    const key = keyOf(input.repo, input.pr);
    const existing = this.entries.get(key);
    if (existing && existing.source === "tool" && input.source === "auto") return existing;
    const events = !input.events || input.events === "all" ? "all" : new Set(input.events);
    const entry: Entry = { key, repo: input.repo, pr: input.pr, events, source: input.source, last: input.last ?? existing?.last ?? null };
    this.entries.set(key, entry);
    return entry;
  }

  get(repo: string, pr: number): Entry | undefined {
    return this.entries.get(keyOf(repo, pr));
  }

  /** Removes one PR, every PR of a repository (no `pr`), or everything (no `repo`). Answers how many. */
  remove(repo?: string, pr?: number): number {
    let n = 0;
    for (const [key, e] of this.entries) {
      if (repo && e.repo.toLowerCase() !== repo.toLowerCase()) continue;
      if (pr !== undefined && e.pr !== pr) continue;
      this.entries.delete(key);
      n++;
    }
    return n;
  }

  list(): Entry[] {
    return [...this.entries.values()];
  }
}
