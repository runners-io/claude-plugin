/**
 * What this session watches. In memory only: the channel is one process per
 * Claude Code session, so a subscription lives exactly as long as the
 * session, and two sessions never share one.
 */
import { EVENT_KINDS, type EventKind, type Snapshot } from "./state.ts";

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

/**
 * The kinds the branch's automatic watch leaves out unless asked for: one per workflow, and a stuck job. They were
 * most of what a session was told and acted on least; ci.run_all_done says when all CI on the head has finished,
 * which workflows did not succeed, and whether the pull request may be ready to merge. subscribe with events still
 * gets them.
 */
export const AUTO_QUIET_KINDS: readonly EventKind[] = ["ci.workflow_succeeded", "ci.workflow_started", "ci.job_stuck_queued"];

/** What the automatic watch pushes: every kind but AUTO_QUIET_KINDS. */
export const AUTO_EVENTS: readonly EventKind[] = EVENT_KINDS.filter((k) => !AUTO_QUIET_KINDS.includes(k));

/** The most mutes one session keeps. */
export const MAX_MUTES = 50;

/**
 * What this session no longer wants to hear: a pull request (`repo` and `pr`), some kinds on every pull request,
 * both, or one workflow (its cleaned name, matched exactly). Every field given must match. In memory only, like the
 * subscriptions, so a mute is this session's alone and ends with it.
 */
export interface Mute {
  readonly repo?: string;
  readonly pr?: number;
  readonly kinds?: ReadonlySet<EventKind>;
  readonly workflow?: string;
  /** Made by unsubscribing the branch's automatic watch: it ends when the session's branch changes. */
  readonly untilBranchChange?: boolean;
}

/** What one change is, for matching against the mutes. */
export interface Muteable {
  readonly repo: string;
  readonly pr: number;
  readonly kind: EventKind;
  /** The cleaned workflow name, or "" when the change is not about one workflow. */
  readonly workflow: string;
}

function muteKey(m: Mute): string {
  const pr = m.repo !== undefined && m.pr !== undefined ? keyOf(m.repo, m.pr) : "";
  return JSON.stringify([pr, m.kinds ? [...m.kinds].sort() : [], m.workflow ?? ""]);
}

export class Mutes {
  private readonly entries = new Map<string, Mute>();

  /** Adds one; "exists" when the same mute is there already, "full" at MAX_MUTES. */
  add(m: Mute): "added" | "exists" | "full" {
    const key = muteKey(m);
    if (this.entries.has(key)) return "exists";
    if (this.entries.size >= MAX_MUTES) return "full";
    this.entries.set(key, m);
    return "added";
  }

  /** Removes the mute with exactly these fields; answers whether there was one. */
  remove(m: Mute): boolean {
    return this.entries.delete(muteKey(m));
  }

  clear(): number {
    const n = this.entries.size;
    this.entries.clear();
    return n;
  }

  /** Ends the mutes that last only until the branch changes. */
  endBranchMutes(): void {
    for (const [key, m] of this.entries) if (m.untilBranchChange) this.entries.delete(key);
  }

  list(): Mute[] {
    return [...this.entries.values()];
  }

  /** The first mute that holds this change back, if any. */
  matching(c: Muteable): Mute | undefined {
    for (const m of this.entries.values()) {
      if (m.repo !== undefined && m.pr !== undefined && keyOf(m.repo, m.pr) !== keyOf(c.repo, c.pr)) continue;
      if (m.kinds && !m.kinds.has(c.kind)) continue;
      if (m.workflow !== undefined && m.workflow !== c.workflow) continue;
      return m;
    }
    return undefined;
  }

  /** Whether the whole pull request is muted (a mute naming it and nothing else): the automatic watch leaves it be. */
  mutesPr(repo: string, pr: number): boolean {
    return this.entries.has(muteKey({ repo, pr }));
  }
}

const RANK: Record<Source, number> = { tool: 2, hook: 1, auto: 0 };

export function keyOf(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

export function wants(entry: Entry, kind: EventKind): boolean {
  return entry.events === "all" || entry.events.has(kind);
}

export class Subscriptions {
  private readonly entries = new Map<string, Entry>();
  /** This session's mutes: held beside the subscriptions so the tools and the poller share them. */
  readonly mutes = new Mutes();

  /** Adds or replaces, never with a lower-ranked source: Claude's own beats the hook's, which beats the branch's. */
  add(input: { repo: string; pr: number; events?: readonly EventKind[] | "all"; source: Source; last?: Snapshot | null }): Entry {
    const key = keyOf(input.repo, input.pr);
    const existing = this.entries.get(key);
    if (existing && RANK[existing.source] > RANK[input.source]) return existing;
    // The branch's automatic watch and the hook's hand-over (usually the PR just opened in this session), unless told
    // otherwise, leave out the per-workflow kinds (AUTO_QUIET_KINDS). Only Claude's subscribe gets every kind unasked.
    const asked = input.events ?? (input.source === "tool" ? "all" : AUTO_EVENTS);
    const events = asked === "all" ? "all" : new Set(asked);
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
