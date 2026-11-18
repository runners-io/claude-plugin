/**
 * What this session watches. In memory only: the channel is one process per
 * Claude Code session, so a subscription lives exactly as long as the
 * session, and two sessions never share one.
 */
import type { EventKind, Snapshot } from "./state.ts";

/** `hook`: handed over by the PostToolUse hook (hookrequests.ts) for a PR named in a tool's output. */
export type Source = "tool" | "auto" | "hook";

export interface Entry {
  readonly key: string;
  readonly repo: string;
  readonly pr: number;
  readonly events: ReadonlySet<EventKind> | "all";
  /** Who asked: Claude through the subscribe tool, the channel for the current branch, or the PostToolUse hook. */
  readonly source: Source;
  /** The state last seen, or null before the first look. */
  last: Snapshot | null;
}

/** Who outranks whom: Claude's own choice, then the hook's hand-over, then the branch's automatic watch. */
/**
 * The most pull requests one session watches, and the most of those the hook may add. Each costs requests on the
 * user's own GitHub budget and is a source of text in the conversation.
 */
export const MAX_SUBSCRIPTIONS = 20;
export const MAX_HOOK_SUBSCRIPTIONS = 5;

const RANK: Record<Source, number> = { tool: 2, hook: 1, auto: 0 };

export function keyOf(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

export function wants(entry: Entry, kind: EventKind): boolean {
  return entry.events === "all" || entry.events.has(kind);
}

export class Subscriptions {
  private readonly entries = new Map<string, Entry>();

  /** Adds or replaces, never with a lower-ranked source: Claude's own beats the hook's, which beats the branch's. */
  add(input: { repo: string; pr: number; events?: readonly EventKind[] | "all"; source: Source; last?: Snapshot | null }): Entry {
    const key = keyOf(input.repo, input.pr);
    const existing = this.entries.get(key);
    if (existing && RANK[existing.source] > RANK[input.source]) return existing;
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
