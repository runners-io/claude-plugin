/**
 * The channel's tools: Claude chooses, per session, which pull requests it
 * hears about: some pull requests, or all of the current branch's.
 *
 * THESE ARE NOT A REPLY PATH. They read GitHub and change only this process's
 * own list of what to watch. Nothing here approves a tool call, sends a
 * message anywhere, or writes to GitHub, so the channel still declares no
 * `claude/channel/permission` and every tool is `readOnlyHint`.
 */
import { NO_EVENT_LOG } from "./eventlog.ts";
import type { EventLog } from "./eventlog.ts";
import { clean, describe, setupText } from "./format.ts";
import type { GitScope } from "./git.ts";
import type { GitHubClient } from "./github.ts";
import { fetchSnapshot } from "./poller.ts";
import { EVENT_KINDS, type EventKind, isEventKind } from "./state.ts";
import { MAX_SUBSCRIPTIONS, type Subscriptions } from "./subscriptions.ts";

export const TOOL_NAMES = ["subscribe", "unsubscribe", "list_subscriptions", "ci_status"] as const;

export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: { type: "object"; properties: Record<string, unknown>; additionalProperties: false };
  readonly annotations: { title: string; readOnlyHint: true; openWorldHint: true };
}

export interface ToolResult {
  readonly text: string;
  readonly isError?: boolean;
}

export interface ToolHost {
  list(): ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** The one line every subscribe answer and the PR hook end on: the server cannot tell whether the session has the channel on. */
export const CHANNEL_NOTE =
  'Results arrive as <channel source="runners-io"> events if this session was started with the runners-io channel; if none arrive, call ci_status to check.';

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const target = {
  repo: { type: "string", description: "owner/name on GitHub. Default: this session's repository (its origin remote)." },
  pr: { type: "integer", minimum: 1, description: "Pull request number. Default: the open pull request for the current branch." },
} as const;

function def(name: (typeof TOOL_NAMES)[number], title: string, description: string, properties: Record<string, unknown>): ToolDef {
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, additionalProperties: false },
    annotations: { title, readOnlyHint: true, openWorldHint: true },
  };
}

const DEFS: ToolDef[] = [
  def(
    "subscribe",
    "Watch a pull request's CI",
    "Push this pull request's CI results and merge-conflict changes into the session as they happen. Call it after you open a pull request, " +
      "or when the user asks you to watch one. Answers the PR's current state; after that only changes are pushed. " +
      `events limits what is pushed (default: all of ${EVENT_KINDS.join(", ")}).`,
    { ...target, events: { type: "array", items: { type: "string", enum: [...EVENT_KINDS] }, description: "Kinds to push. Omit for all." } },
  ),
  def("unsubscribe", "Stop watching CI", "Stop pushing a pull request's CI results, every pull request of a repository (no pr), or everything (all: true).", {
    ...target,
    all: { type: "boolean", description: "Stop watching everything." },
  }),
  def("list_subscriptions", "List watched pull requests", "The pull requests this session is watching, and which events each pushes.", {}),
  def("ci_status", "Read a pull request's CI now", "The pull request's current CI and merge-conflict state, read from GitHub now. Does not subscribe.", target),
];

interface Deps {
  readonly subs: Subscriptions;
  readonly gh: GitHubClient;
  readonly readScope: () => Promise<GitScope>;
  /** The durable record (eventlog.ts); none by default. */
  readonly eventLog?: EventLog;
  /** False when this session was launched without the channel flag (hooks/launch.mjs): nothing pushed arrives. */
  readonly liveEvents?: boolean;
}

export const EVENTS_OFF_NOTE =
  "But live CI events are OFF in this session: it was started without the channel flag, so nothing will be pushed. " +
  "Relaunch with `claude-gh --continue` (or /runners-io:setup-github to set claude-gh up); ci_status still reads a PR's state on request.";

type Target = { ok: true; repo: string; pr: number } | { ok: false; text: string };

async function resolveTarget(deps: Deps, args: Record<string, unknown>): Promise<Target> {
  let repo: string;
  if (args.repo !== undefined) {
    if (typeof args.repo !== "string" || !REPO.test(args.repo)) return { ok: false, text: "repo must be owner/name, for example acme/widgets." };
    repo = args.repo;
  } else {
    const scope = await deps.readScope();
    if (!scope.repo) return { ok: false, text: "This session's folder has no GitHub origin remote: pass repo (owner/name) and pr." };
    repo = scope.repo;
  }
  if (args.pr !== undefined) {
    if (typeof args.pr !== "number" || !Number.isInteger(args.pr) || args.pr < 1) return { ok: false, text: "pr must be a positive whole number." };
    return { ok: true, repo, pr: args.pr };
  }
  const scope = await deps.readScope();
  if (!scope.branch || scope.repo?.toLowerCase() !== repo.toLowerCase()) {
    return { ok: false, text: `Pass pr: there is no current branch of ${repo} in this session's folder to find it from.` };
  }
  const found = await deps.gh.findOpenPull(repo, scope.branch);
  if (found.kind === "auth") return { ok: false, text: setupText(found.auth) };
  if (found.kind !== "ok") return { ok: false, text: `Could not ask GitHub for the branch's pull request (${found.kind}); pass pr.` };
  // The local branch's name is chosen by whoever named it (a fetched fork's branch included), so it is cleaned like any name.
  if (found.value === null) return { ok: false, text: `There is no open pull request for branch ${clean(scope.branch, 100)} in ${repo}: pass pr.` };
  return { ok: true, repo, pr: found.value };
}

function parseEvents(raw: unknown): { ok: true; events: EventKind[] | "all" } | { ok: false; text: string } {
  if (raw === undefined || raw === "all") return { ok: true, events: "all" };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, text: "events must be a non-empty list of event kinds, or omitted for all." };
  for (const e of raw) {
    if (!isEventKind(e)) return { ok: false, text: `unknown event kind ${JSON.stringify(e)}. Known kinds: ${EVENT_KINDS.join(", ")}.` };
  }
  return { ok: true, events: [...new Set(raw as EventKind[])] };
}

const label = (events: ReadonlySet<EventKind> | EventKind[] | "all") => (events === "all" ? "all events" : [...events].join(", "));

export function makeTools(deps: Deps): ToolHost {
  const err = (text: string): ToolResult => ({ text, isError: true });

  const read = async (repo: string, pr: number) => {
    const r = await fetchSnapshot(deps.gh, repo, pr);
    if (r.kind === "auth") return err(setupText(r.auth));
    if (r.kind === "not_found") {
      return err(
        `GitHub has no PR #${pr} in ${repo}, or this GitHub login cannot see PR #${pr} in ${repo}. ` +
          "A private repository needs a gh login with the repo scope (gh auth refresh --scopes repo); an organisation with SSO needs the token authorised for it.",
      );
    }
    if (r.kind === "retry") return err(`GitHub did not answer (${r.reason}). Try again shortly.`);
    return r.value;
  };

  return {
    list: () => DEFS,
    async call(name, args) {
      switch (name) {
        case "subscribe": {
          const events = parseEvents(args.events);
          if (!events.ok) return err(events.text);
          const t = await resolveTarget(deps, args);
          if (!t.ok) return err(t.text);
          if (!deps.subs.get(t.repo, t.pr) && deps.subs.list().length >= MAX_SUBSCRIPTIONS) {
            return err(
              `This session already watches ${MAX_SUBSCRIPTIONS} pull requests, the most it will. ` +
                "Call unsubscribe for one it no longer needs (list_subscriptions shows them), then subscribe again.",
            );
          }
          const snap = await read(t.repo, t.pr);
          if ("text" in snap) return snap;
          if (snap.state !== "open") return { text: `${describe(snap)}\nThe pull request is ${snap.state}, so it is not subscribed.` };
          deps.subs.add({ repo: t.repo, pr: t.pr, events: events.events, source: "tool", last: snap });
          (deps.eventLog ?? NO_EVENT_LOG).write("subscribe", {
            repo: t.repo,
            pr: t.pr,
            source: "tool",
            events: events.events === "all" ? "all" : [...events.events],
          });
          return { text: `Subscribed to ${t.repo} PR #${t.pr} (${label(events.events)}).\n${describe(snap)}\n${deps.liveEvents === false ? EVENTS_OFF_NOTE : CHANNEL_NOTE}` };
        }
        case "unsubscribe": {
          const record = (repo: string | null, pr: number | null, count: number) =>
            (deps.eventLog ?? NO_EVENT_LOG).write("unsubscribe", { repo, pr, source: "tool", reason: "tool", count });
          if (args.all === true) {
            const count = deps.subs.remove();
            record(null, null, count);
            return { text: `Stopped watching ${count} pull request(s).` };
          }
          if (args.repo !== undefined && (typeof args.repo !== "string" || !REPO.test(args.repo))) return err("repo must be owner/name.");
          if (args.pr !== undefined && (typeof args.pr !== "number" || !Number.isInteger(args.pr) || args.pr < 1)) return err("pr must be a positive whole number.");
          const repo = (args.repo as string | undefined) ?? (await deps.readScope()).repo;
          if (!repo) return err("Pass repo, or all: true.");
          const count = deps.subs.remove(repo, args.pr as number | undefined);
          record(repo, (args.pr as number | undefined) ?? null, count);
          return { text: `Stopped watching ${count} pull request(s).` };
        }
        case "list_subscriptions": {
          const all = deps.subs.list();
          if (!all.length) return { text: "No subscriptions in this session." };
          return {
            text: all
              .map((e) => `- ${e.repo} PR #${e.pr}: ${label(e.events)}${e.source === "auto" ? " (automatic: the current branch's PR)" : ""}`)
              .join("\n"),
          };
        }
        case "ci_status": {
          const t = await resolveTarget(deps, args);
          if (!t.ok) return err(t.text);
          const snap = await read(t.repo, t.pr);
          if ("text" in snap) return snap;
          const entry = deps.subs.get(t.repo, t.pr);
          const note = entry
            ? `This session is subscribed (${label(entry.events)}).`
            : "This session is not subscribed to it; call subscribe to have changes pushed.";
          return { text: `${describe(snap)}\n${note}` };
        }
        default:
          return err(`unknown tool: ${name}`);
      }
    },
  };
}
