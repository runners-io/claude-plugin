/**
 * The channel's tools: Claude chooses, per session, which pull requests it
 * hears about: some pull requests, or all of the current branch's.
 *
 * THESE ARE NOT A REPLY PATH. They read GitHub and change only this process's
 * own lists of what to watch and what to mute. Nothing here approves a tool call, sends a
 * message anywhere, or writes to GitHub, so the channel still declares no
 * `claude/channel/permission` and every tool is `readOnlyHint`.
 */
import { relaunchSentence } from "../../hooks/launch.mjs";
import { NO_EVENT_LOG } from "./eventlog.ts";
import type { EventLog } from "./eventlog.ts";
import { NAMES_LABEL, clean, describe, setupText } from "./format.ts";
import type { GitScope } from "./git.ts";
import type { GitHubClient } from "./github.ts";
import { fetchSnapshot } from "./poller.ts";
import { EVENT_KINDS, type EventKind, isEventKind } from "./state.ts";
import { type Entry, MAX_MUTES, MAX_SUBSCRIPTIONS, type Mute, type Subscriptions } from "./subscriptions.ts";

export const TOOL_NAMES = ["subscribe", "unsubscribe", "list_subscriptions", "ci_status", "mute", "unmute"] as const;

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

/**
 * What a watch costs, in the subscribe description: Claude learned of the cap only from the refusal at the next one, and an
 * orchestrating session that watched everything it opened spent a GitHub login shared with gh. The figures are the README's.
 */
export const WATCH_COST =
  "Each watch reads GitHub on the user's own GitHub login and its hourly limit, shared with gh: about 24 GitHub requests an hour " +
  "while the pull request is quiet, more while its CI runs, and about 60 GraphQL points an hour for the review kinds " +
  `(a watch whose events name no review kind costs no review reads). A session watches at most ${MAX_SUBSCRIPTIONS} pull requests.`;

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const target = {
  repo: { type: "string", description: "owner/name on GitHub. Default: this session's repository (its origin remote)." },
  pr: { type: "integer", minimum: 1, description: "Pull request number. Default: the open pull request for the current branch." },
} as const;

const muteFields = {
  repo: { type: "string", description: "owner/name on GitHub, with pr. Default with pr: this session's repository." },
  pr: { type: "integer", minimum: 1, description: "Pull request number." },
  kinds: { type: "array", items: { type: "string", enum: [...EVENT_KINDS] }, description: "Event kinds to mute." },
  workflow: { type: "string", description: "A workflow's name, exactly as the events give it." },
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
      `events limits what is pushed (default: all of ${EVENT_KINDS.join(", ")}). ` +
      WATCH_COST,
    { ...target, events: { type: "array", items: { type: "string", enum: [...EVENT_KINDS] }, description: "Kinds to push. Omit for all." } },
  ),
  def(
    "unsubscribe",
    "Stop watching CI",
    "Stop pushing one pull request's CI results: pr, or with no arguments the current branch's pull request, as subscribe takes it. " +
      "whole_repo: true stops every pull request of a repository (repo, default this session's), and all: true stops everything.",
    {
      ...target,
      whole_repo: { type: "boolean", description: "Stop watching every pull request of the repository (repo, default this session's), not just one." },
      all: { type: "boolean", description: "Stop watching everything." },
    },
  ),
  def("list_subscriptions", "List watched pull requests", "The pull requests this session is watching, which events each pushes, and this session's mutes.", {}),
  def("ci_status", "Read a pull request's CI now", "The pull request's current CI and merge-conflict state, read from GitHub now. Does not subscribe.", target),
  def(
    "mute",
    "Stop hearing some events",
    "In this session only, stop pushing events that match: a pull request (repo and pr), some kinds on every pull request (kinds), " +
      "kinds on one pull request (repo, pr and kinds), or one workflow by its name (workflow). Other sessions are not affected. " +
      `A pull request muted on its own is never watched automatically. At most ${MAX_MUTES}; they end with the session.`,
    muteFields,
  ),
  def("unmute", "Hear muted events again", "Remove one mute (the same fields it was made with), or every mute (all: true).", {
    ...muteFields,
    all: { type: "boolean", description: "Remove every mute." },
  }),
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

/** The relaunch is launch.mjs's one sentence, as the launch notice and the watch-this-pr skill say it. */
export const EVENTS_OFF_NOTE =
  "But live CI events are OFF in this session: it was started without the channel flag, so nothing will be pushed. " +
  `To turn them on, ${relaunchSentence(null)}; /runners-io:setup-github sets claude-gh up. ci_status still reads a PR's state on request.`;

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

/** A mute from the tool's arguments, or why not. */
async function parseMute(deps: Deps, args: Record<string, unknown>): Promise<{ ok: true; mute: Mute } | { ok: false; text: string }> {
  const has = (k: string) => args[k] !== undefined;
  if (!has("pr") && !has("kinds") && !has("workflow")) return { ok: false, text: "Name what to mute: repo and pr, kinds, both, or workflow." };
  let repo: string | undefined;
  let pr: number | undefined;
  if (has("repo") && !has("pr")) return { ok: false, text: "repo needs pr: a mute names one pull request, not a whole repository." };
  if (has("pr")) {
    if (typeof args.pr !== "number" || !Number.isInteger(args.pr) || args.pr < 1) return { ok: false, text: "pr must be a positive whole number." };
    pr = args.pr;
    if (has("repo")) {
      if (typeof args.repo !== "string" || !REPO.test(args.repo)) return { ok: false, text: "repo must be owner/name, for example acme/widgets." };
      repo = args.repo;
    } else {
      const scope = await deps.readScope();
      if (!scope.repo) return { ok: false, text: "This session's folder has no GitHub origin remote: pass repo (owner/name) with pr." };
      repo = scope.repo;
    }
  }
  let kinds: Set<EventKind> | undefined;
  if (has("kinds")) {
    const parsed = parseEvents(args.kinds);
    if (!parsed.ok || parsed.events === "all") return { ok: false, text: "kinds must be a non-empty list of event kinds." + (parsed.ok ? "" : ` ${parsed.text}`) };
    kinds = new Set(parsed.events);
  }
  let workflow: string | undefined;
  if (has("workflow")) {
    workflow = typeof args.workflow === "string" ? clean(args.workflow) : "";
    if (!workflow) return { ok: false, text: "workflow must be a workflow's name, as the events give it." };
  }
  return { ok: true, mute: { ...(repo && pr ? { repo, pr } : {}), ...(kinds ? { kinds } : {}), ...(workflow ? { workflow } : {}) } };
}

/** One mute in words. A workflow's name is the repository's: it comes last, quoted, after the names label. */
function muteText(m: Mute): string {
  const parts = [
    m.kinds ? [...m.kinds].join(", ") : "every event",
    m.repo && m.pr ? `on ${m.repo} PR #${m.pr}` : "on every pull request",
    m.workflow ? "of the workflow named at the end" : "",
    m.untilBranchChange ? "(unsubscribed as the current branch's pull request: until the branch changes)" : "",
  ];
  return `${parts.filter(Boolean).join(" ")}.${m.workflow ? ` ${NAMES_LABEL} workflow ${JSON.stringify(m.workflow)}.` : ""}`;
}

function muteLog(m: Mute): Record<string, unknown> {
  return { repo: m.repo ?? null, pr: m.pr ?? null, kinds: m.kinds ? [...m.kinds] : null, workflow: m.workflow ?? null };
}

const label = (events: ReadonlySet<EventKind> | EventKind[] | "all") => {
  if (events === "all") return "all events";
  const list = [...events];
  // Most kinds (the automatic watch's default): say which are left out, not the twenty that are not.
  const left = EVENT_KINDS.filter((k) => !list.includes(k));
  return list.length > left.length ? `all events but ${left.join(", ")}` : list.join(", ");
};

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
          // A PR already watched keeps the state the poller last saw as its baseline; this read only answers the call.
          // Taking it as the baseline swallowed whatever changed since the last look: a PR marked ready for review
          // thirteen seconds before a repeat subscribe, and before the next poll, was never reported. A PR seen for the
          // first time (or a hand-over not yet looked at) starts from this read.
          const seen = deps.subs.get(t.repo, t.pr)?.last ?? null;
          deps.subs.add({ repo: t.repo, pr: t.pr, events: events.events, source: "tool", last: seen ?? snap });
          // Asked for by name: a mute of the whole pull request no longer holds. Kind and workflow mutes stay.
          const lifted = deps.subs.mutes.remove({ repo: t.repo, pr: t.pr });
          (deps.eventLog ?? NO_EVENT_LOG).write("subscribe", {
            repo: t.repo,
            pr: t.pr,
            source: "tool",
            events: events.events === "all" ? "all" : [...events.events],
          });
          return { text: `Subscribed to ${t.repo} PR #${t.pr} (${label(events.events)})${lifted ? "; its mute is lifted" : ""}.\n${describe(snap)}\n${deps.liveEvents === false ? EVENTS_OFF_NOTE : CHANNEL_NOTE}` };
        }
        case "unsubscribe": {
          const record = (repo: string | null, pr: number | null, count: number) =>
            (deps.eventLog ?? NO_EVENT_LOG).write("unsubscribe", { repo, pr, source: "tool", reason: "tool", count });
          // The branch's automatic watch would find its pull request again within minutes: unsubscribing it leaves a
          // mute of that pull request, which ends when the session's branch changes. Whoever holds it: the automatic
          // watch, the hook's hand-over of a PR just opened, or Claude's own subscribe.
          const muteBranchPr = async (repo?: string, pr?: number) => {
            const scope = await deps.readScope();
            const branchPr = (e: Entry) =>
              e.source === "auto" ||
              (!!scope.branch && !!scope.repo && e.repo.toLowerCase() === scope.repo.toLowerCase() && e.last?.headRef === scope.branch);
            const mine = deps.subs
              .list()
              .filter((e) => branchPr(e) && (!repo || e.repo.toLowerCase() === repo.toLowerCase()) && (pr === undefined || e.pr === pr));
            let note = "";
            for (const e of mine) {
              const added = deps.subs.mutes.add({ repo: e.repo, pr: e.pr, untilBranchChange: true });
              if (added === "added") (deps.eventLog ?? NO_EVENT_LOG).write("mute", { ...muteLog({ repo: e.repo, pr: e.pr }), source: "unsubscribe" });
              note +=
                added === "full"
                  ? ` This session already has ${MAX_MUTES} mutes, so the branch's automatic watch may add ${e.repo} PR #${e.pr} back.`
                  : ` ${e.repo} PR #${e.pr} is the current branch's: it stays unwatched until the branch changes, or until unmute or subscribe.`;
            }
            return note;
          };
          if (args.all === true) {
            const note = await muteBranchPr();
            const count = deps.subs.remove();
            record(null, null, count);
            return { text: `Stopped watching ${count} pull request(s).${note}` };
          }
          if (args.repo !== undefined && (typeof args.repo !== "string" || !REPO.test(args.repo))) return err("repo must be owner/name.");
          if (args.pr !== undefined && (typeof args.pr !== "number" || !Number.isInteger(args.pr) || args.pr < 1)) return err("pr must be a positive whole number.");
          if (args.whole_repo === true) {
            // A whole repository only when asked for by name: no pr used to mean this, while the parameter
            // said "the current branch's pull request", so "stop watching this one" silenced every other PR too.
            if (args.pr !== undefined) return err("Pass pr or whole_repo: true, not both.");
            const repo = (args.repo as string | undefined) ?? (await deps.readScope()).repo;
            if (!repo) return err("Pass repo with whole_repo: true, or all: true.");
            const note = await muteBranchPr(repo);
            const count = deps.subs.remove(repo);
            record(repo, null, count);
            return { text: `Stopped watching ${count} pull request(s) of ${repo}.${note}` };
          }
          let one: { repo: string; pr: number };
          if (args.pr !== undefined) {
            const repo = (args.repo as string | undefined) ?? (await deps.readScope()).repo;
            if (!repo) return err("This session's folder has no GitHub origin remote: pass repo (owner/name) with pr, or all: true.");
            one = { repo, pr: args.pr as number };
          } else {
            // No pr: the current branch's pull request, as subscribe takes it. One already watched for this branch is
            // found without asking GitHub; otherwise GitHub is asked, as subscribe does.
            const scope = await deps.readScope();
            const repo = (args.repo as string | undefined) ?? scope.repo;
            const watched =
              repo && scope.branch && scope.repo?.toLowerCase() === repo.toLowerCase()
                ? deps.subs.list().find((e) => e.repo.toLowerCase() === repo.toLowerCase() && (e.source === "auto" || e.last?.headRef === scope.branch))
                : undefined;
            if (watched) one = { repo: watched.repo, pr: watched.pr };
            else {
              const t = await resolveTarget(deps, args);
              if (!t.ok) return err(`${t.text} To stop every pull request of a repository, pass whole_repo: true; to stop everything, all: true.`);
              one = { repo: t.repo, pr: t.pr };
            }
          }
          const note = await muteBranchPr(one.repo, one.pr);
          const count = deps.subs.remove(one.repo, one.pr);
          record(one.repo, one.pr, count);
          return { text: count ? `Stopped watching ${one.repo} PR #${one.pr}.${note}` : `${one.repo} PR #${one.pr} was not watched.${note}` };
        }
        case "list_subscriptions": {
          const all = deps.subs.list();
          const mutes = deps.subs.mutes.list();
          const watched = all.length
            ? all.map((e) => `- ${e.repo} PR #${e.pr}: ${label(e.events)}${e.source === "auto" ? " (automatic: the current branch's PR)" : ""}`).join("\n")
            : "No subscriptions in this session.";
          if (!mutes.length) return { text: watched };
          return { text: `${watched}\nMuted in this session only (${mutes.length} of ${MAX_MUTES}):\n${mutes.map((m) => `- ${muteText(m)}`).join("\n")}` };
        }
        case "mute": {
          const m = await parseMute(deps, args);
          if (!m.ok) return err(m.text);
          const added = deps.subs.mutes.add(m.mute);
          if (added === "full") {
            return err(`This session already has ${MAX_MUTES} mutes, the most it keeps. Call unmute for one it no longer needs (list_subscriptions shows them), then mute again.`);
          }
          if (added === "exists") return { text: `Already muted: ${muteText(m.mute)}` };
          (deps.eventLog ?? NO_EVENT_LOG).write("mute", { ...muteLog(m.mute), source: "tool" });
          return { text: `Muted in this session only: ${muteText(m.mute)} Other sessions still hear it; unmute with the same fields undoes it.` };
        }
        case "unmute": {
          if (args.all === true) {
            const count = deps.subs.mutes.clear();
            (deps.eventLog ?? NO_EVENT_LOG).write("unmute", { all: true, count });
            return { text: `Removed ${count} mute(s).` };
          }
          const m = await parseMute(deps, args);
          if (!m.ok) return err(m.text);
          // An unsubscribed automatic watch's mute is the same pull request: unmute names it the same way.
          const removed = deps.subs.mutes.remove(m.mute);
          if (!removed) return err(`No such mute: ${muteText(m.mute)} list_subscriptions shows this session's mutes.`);
          (deps.eventLog ?? NO_EVENT_LOG).write("unmute", muteLog(m.mute));
          return { text: `Unmuted: ${muteText(m.mute)}` };
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
