/**
 * The channel's tools: Claude chooses, per session, which pull requests it
 * hears about: some pull requests, or all of the current branch's. A scope
 * (scopes.ts) is the one choice kept beyond the session: every open pull
 * request in a repository, set once for the project.
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
import { ForkParents, findBranchPull } from "./forks.ts";
import type { GitHubClient } from "./github.ts";
import { fetchSnapshot } from "./poller.ts";
import { DEFAULT_INVOLVES, INVOLVES, type Involves, type ScopeStore, isRepoName } from "./scopes.ts";
import { EVENT_KINDS, type EventKind, isEventKind } from "./state.ts";
import { internalError } from "./faults.ts";
import { AUTO_QUIET_KINDS, type Entry, MAX_MUTES, MAX_SUBSCRIPTIONS, type Mute, type Subscriptions } from "./subscriptions.ts";

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

/**
 * What a repository scope is and costs, in the subscribe description, so the choice is made knowing it: a scope's
 * pull requests are watches like any other, inside the same cap, and `involves` is decided from the list alone. By
 * default a scope covers only the login's own pull requests: other people's are an explicit choice.
 */
export const SCOPE_COST =
  ' With scope: "repo", it watches the open pull requests the signed-in GitHub login opened in the whole repository instead, ones opened later included, with no further ' +
  "subscribe call, and keeps that for this project across restarts; after gh pr create there, call subscribe only if no scope covers the " +
  "repository (list_subscriptions shows the scopes). Each pull request a scope holds is a watch like any other: it costs the same and " +
  `counts towards the same ${MAX_SUBSCRIPTIONS}, so a scope takes only the places nothing else has, the newest open pull requests first, and ` +
  "says how many it left out (list_subscriptions shows them too); a subscribe for one pull request takes the place of the scope's oldest. " +
  "Reading the repository's list is one more request a minute, free while the list is unchanged; the newest 100 open pull requests are read. " +
  `A scope's pull requests push what the current branch's does: every kind but ${AUTO_QUIET_KINDS.join(", ")}. ` +
  "Other people's pull requests are covered only when asked for by name, so pass these only if the user asks: " +
  'involves: "me" widens the scope to pull requests the login opened, is assigned to or is asked to review, read from ' +
  "that list with no further request (one the login only commented on, or was asked to review as a member of a team, is not counted), " +
  'and involves: "all" to every open pull request in the repository.';

/** Whose pull requests are watched unasked, in the subscribe description: the user's own, and anybody's only by name. */
export const OWN_ONLY =
  "Only pull requests the signed-in GitHub login opened are watched without being named: for somebody else's, pass repo and pr, " +
  "and only if the user asks, since its events carry that person's text into the session. ";

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const target = {
  repo: { type: "string", description: "owner/name on GitHub. Default: this session's repository (its origin remote)." },
  pr: {
    type: "integer",
    minimum: 1,
    description:
      "Pull request number. Default: the open pull request for the current branch; with no repo named, in a fork that is the one on the repository it was forked from, when there is one. " +
      "subscribe takes that default only for a pull request the signed-in GitHub login opened: somebody else's must be named.",
  },
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

const scopeArg = {
  type: "string",
  enum: ["repo"],
  description: "repo: the whole repository (repo, default this session's), kept for this project across restarts. Takes no pr.",
} as const;

/** The tools as listed. `withScopes`: the session has a scope store, so subscribe and unsubscribe offer a scope. */
function defs(withScopes: boolean): ToolDef[] {
  const scoped = (extra: Record<string, unknown>) => (withScopes ? extra : {});
  return [
    def(
      "subscribe",
      "Watch a pull request's CI",
      "Push this pull request's CI results and merge-conflict changes into the session as they happen. Call it after you open a pull request, " +
        "or when the user asks you to watch one. Answers the PR's current state; after that only changes are pushed. " +
        `events limits what is pushed (default: all of ${EVENT_KINDS.join(", ")}). ` +
        OWN_ONLY +
        WATCH_COST +
        (withScopes ? SCOPE_COST : ""),
      {
        ...target,
        events: { type: "array", items: { type: "string", enum: [...EVENT_KINDS] }, description: "Kinds to push. Omit for all." },
        ...scoped({
          scope: scopeArg,
          involves: {
            type: "string",
            enum: [...INVOLVES],
            description:
              "With scope: mine (default): only pull requests you opened. Only if the user asks for other people's: me, those you opened, are assigned to or are asked to review " +
              "(not ones you only commented on), or all, every open pull request.",
          },
        }),
      },
    ),
    def(
      "unsubscribe",
      "Stop watching CI",
      "Stop pushing one pull request's CI results: pr, or with no arguments the current branch's pull request, as subscribe takes it. " +
        "whole_repo: true stops every pull request of a repository (repo, default this session's), and all: true stops everything." +
        (withScopes
          ? ' With scope: "repo", end the repository\'s scope, for this project. While a scope covers a repository, unsubscribing one of its pull ' +
            "requests also mutes that pull request in this session, so the scope does not add it back: until it closes, the scope ends, or unmute or " +
            "subscribe names it. whole_repo: true and all: true end the scopes they cover too (whole_repo that repository's, all: true every scope " +
            "of this project), and say so: otherwise the scope would watch everything again within a minute."
          : ""),
      {
        ...target,
        whole_repo: { type: "boolean", description: "Stop watching every pull request of the repository (repo, default this session's), not just one." },
        all: { type: "boolean", description: "Stop watching everything." },
        ...scoped({ scope: scopeArg }),
      },
    ),
    def(
      "list_subscriptions",
      "List watched pull requests",
      `${withScopes ? "The scopes set for this project, and the" : "The"} pull requests this session is watching, which events each pushes, and this session's mutes.`,
      {},
    ),
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
}

interface Deps {
  readonly subs: Subscriptions;
  readonly gh: GitHubClient;
  readonly readScope: () => Promise<GitScope>;
  /** Which repository the clone was forked from (forks.ts); the poller's own, so GitHub is asked once. One of its own by default. */
  readonly parents?: ForkParents;
  /** The durable record (eventlog.ts); none by default. */
  readonly eventLog?: EventLog;
  /** False when this session was launched without the channel flag (hooks/launch.mjs): nothing pushed arrives. */
  readonly liveEvents?: boolean;
  /** This project's scopes (scopes.ts); none: a scope is refused. */
  readonly scopes?: ScopeStore;
}

/** The relaunch is launch.mjs's one sentence, as the launch notice and the watch-this-pr skill say it. */
export const EVENTS_OFF_NOTE =
  "But live CI events are OFF in this session: it was started without the channel flag, so nothing will be pushed. " +
  `To turn them on, ${relaunchSentence(null)}; /runners-io:setup-github sets claude-gh up. ci_status still reads a PR's state on request.`;

type Target = { ok: true; repo: string; pr: number } | { ok: false; text: string };

/** For a repository named outright: it is asked itself, and never about a parent. */
const NO_PARENTS: Pick<ForkParents, "parentOf"> = { parentOf: async () => null };

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
  if (!scope.branch || !scope.repo || scope.repo.toLowerCase() !== repo.toLowerCase()) {
    return { ok: false, text: `Pass pr: there is no current branch of ${repo} in this session's folder to find it from.` };
  }
  // With no repository named, the branch's pull request is found as the automatic watch finds it: in a fork, on the
  // repository it was forked from first (forks.ts). A repository named outright is the only one asked.
  const found =
    args.repo === undefined
      ? await findBranchPull(deps.gh, { repo: scope.repo, branch: scope.branch, upstream: scope.upstream }, deps.parents ?? NO_PARENTS)
      : await findBranchPull(deps.gh, { repo, branch: scope.branch }, NO_PARENTS);
  if (found.kind === "auth") return { ok: false, text: setupText(found.auth) };
  if (found.kind !== "ok") return { ok: false, text: `Could not ask GitHub for the branch's pull request (${found.kind}); pass pr.` };
  // The local branch's name is chosen by whoever named it (a fetched fork's branch included), so it is cleaned like any name.
  if (found.value === null) return { ok: false, text: `There is no open pull request for branch ${clean(scope.branch, 100)} in ${repo}: pass pr.` };
  return { ok: true, repo: found.value.repo, pr: found.value.pr };
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
    m.whileScoped ? "(unsubscribed while a scope covers its repository: until it closes or the scope ends)" : "",
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

/** Repository names are compared as GitHub compares them: without regard to case. */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const REPO_TEXT = "repo must be owner/name as GitHub allows it, for example acme/widgets.";

/** What a scope covers, in words: "every open pull request you opened in acme/widgets", or (that involves you), or everybody's. */
const covers = (repo: string, involves: Involves, joiner = " in ") =>
  `every open pull request${involves === "mine" ? " you opened" : ""}${joiner}${repo}${involves === "me" ? " that involves you" : ""}`;

/** The repository a scope call names: `repo`, else this session's. */
async function scopeRepo(deps: Deps, args: Record<string, unknown>): Promise<{ ok: true; repo: string } | { ok: false; text: string }> {
  if (args.repo !== undefined) return isRepoName(args.repo) ? { ok: true, repo: args.repo } : { ok: false, text: REPO_TEXT };
  const repo = (await deps.readScope()).repo;
  if (!repo) return { ok: false, text: "This session's folder has no GitHub origin remote: pass repo (owner/name)." };
  return isRepoName(repo) ? { ok: true, repo } : { ok: false, text: REPO_TEXT };
}

/** The project's scope store, or why a scope argument is refused. Only a repository scope exists so far. */
function scopeStore(deps: Deps, args: Record<string, unknown>): { ok: true; store: ScopeStore } | { ok: false; text: string } {
  if (args.scope !== "repo") return { ok: false, text: 'Only a repository scope (scope: "repo") is available.' };
  if (!deps.scopes) return { ok: false, text: "Scopes are not available in this session." };
  return { ok: true, store: deps.scopes };
}

export function makeTools(given: Deps): ToolHost {
  // One memory of which repository the clone was forked from for all the tools' calls.
  const deps: Deps = { ...given, parents: given.parents ?? new ForkParents(given.gh) };
  const err = (text: string): ToolResult => ({ text, isError: true });
  const listed = defs(deps.scopes !== undefined);

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
    list: () => listed,
    async call(name, args) {
      switch (name) {
        case "subscribe": {
          if (args.scope !== undefined) {
            const scopes = scopeStore(deps, args);
            if (!scopes.ok) return err(scopes.text);
            if (args.pr !== undefined) return err("A scope takes no pr: it covers every open pull request in the repository.");
            if (args.events !== undefined) {
              return err(`A scope takes no events: its pull requests push every kind but ${AUTO_QUIET_KINDS.join(", ")}. Subscribe to one pull request with events to hear those.`);
            }
            // Omitted: the login's own pull requests only. Other people's are covered when asked for by name.
            const involves = args.involves ?? DEFAULT_INVOLVES;
            if (!INVOLVES.includes(involves as Involves)) return err('involves must be "mine", "me" or "all".');
            const chosen = involves as Involves;
            const r = await scopeRepo(deps, args);
            if (!r.ok) return err(r.text);
            const added = scopes.store.add({ kind: "repo", repo: r.repo, involves: chosen, events: "all" });
            if (!added.ok) return err(added.text);
            (deps.eventLog ?? NO_EVENT_LOG).write("scope_set", { repo: r.repo, kind: "repo", involves, saved: added.saved });
            const kept = added.saved
              ? "It is kept for this project, so a restarted session goes on watching."
              : `It holds for this session only. ${scopes.store.problem ?? ""}`.trim();
            return {
              text:
                `Watching ${covers(r.repo, chosen)}. A pull request ${chosen === "mine" ? "you open" : "opened"} there later is watched with no subscribe call. ${kept} ` +
                (chosen === "mine"
                  ? 'Other people\'s pull requests are not covered: only if the user asks for them, involves: "me" adds those you are assigned to or asked to review, and involves: "all" covers everybody\'s. '
                  : "") +
                `Each one held counts towards the ${MAX_SUBSCRIPTIONS} pull requests a session watches: the newest that fit are held, and you are told ` +
                "how many are left out; list_subscriptions shows what the scope holds, within about a minute.\n" +
                (deps.liveEvents === false ? EVENTS_OFF_NOTE : CHANNEL_NOTE),
            };
          }
          if (args.involves !== undefined) return err('involves goes with scope: "repo".');
          const events = parseEvents(args.events);
          if (!events.ok) return err(events.text);
          const t = await resolveTarget(deps, args);
          if (!t.ok) return err(t.text);
          // At the cap, a pull request asked for by name takes the place of the oldest one a scope holds: a scope only
          // fills the places nobody asked for. With none to give up, the subscribe is refused as before.
          const full = !deps.subs.get(t.repo, t.pr) && deps.subs.list().length >= MAX_SUBSCRIPTIONS;
          if (full && !deps.subs.oldestScopeEntry()) {
            return err(
              `This session already watches ${MAX_SUBSCRIPTIONS} pull requests, the most it will. ` +
                "Call unsubscribe for one it no longer needs (list_subscriptions shows them), then subscribe again.",
            );
          }
          const snap = await read(t.repo, t.pr);
          if ("text" in snap) return snap;
          if (snap.state !== "open") return { text: `${describe(snap)}\nThe pull request is ${snap.state}, so it is not subscribed.` };
          // NOT NAMED IS NOT ASKED FOR: the branch can be a colleague's, and their pull request carries their
          // text into the session. With no pr passed, only one the signed-in login opened is taken; not knowing the
          // login is not a yes. Naming the pull request is the opt-in, and the refusal says how.
          if (args.pr === undefined) {
            const login = await deps.gh.viewerLogin();
            const me = login.kind === "ok" && login.value ? login.value.toLowerCase() : null;
            const named = `call subscribe with repo: "${t.repo}" and pr: ${t.pr}`;
            if (me === null) {
              return err(
                `GitHub did not say which login is signed in, so the channel cannot tell whether the current branch's pull request, ${t.repo} PR #${t.pr}, is yours, and it is not subscribed. ` +
                  `To watch it whoever opened it, ${named}.`,
              );
            }
            if ((snap.author ?? "").toLowerCase() !== me) {
              return err(
                `The current branch's pull request, ${t.repo} PR #${t.pr}, was not opened by the signed-in GitHub login, so it is not subscribed: only your own pull requests are watched unless one is named. ` +
                  `Watch it only if the user asks: ${named}.`,
              );
            }
          }
          let gaveWay = "";
          const watchedBefore = deps.subs.list().length;
          const isNew = !deps.subs.get(t.repo, t.pr);
          const room = full && deps.subs.list().length >= MAX_SUBSCRIPTIONS ? deps.subs.oldestScopeEntry() : undefined;
          if (room) {
            deps.subs.remove(room.repo, room.pr);
            (deps.eventLog ?? NO_EVENT_LOG).write("unsubscribe", { repo: room.repo, pr: room.pr, source: "scope", reason: "scope_cap" });
            gaveWay = ` The session was full, so ${room.repo} PR #${room.pr}, the oldest its scope held, is no longer watched.`;
          }
          // A PR already watched keeps the state the poller last saw as its baseline; this read only answers the call.
          // Taking it as the baseline swallowed whatever changed since the last look: a PR marked ready for review
          // thirteen seconds before a repeat subscribe, and before the next poll, was never reported. A PR seen for the
          // first time (or a hand-over not yet looked at) starts from this read.
          const seen = deps.subs.get(t.repo, t.pr)?.last ?? null;
          deps.subs.add({ repo: t.repo, pr: t.pr, events: events.events, source: "tool", last: seen ?? snap });
          // A new watch was let in only because there was room, or after a scope gave up a place: so it cannot have
          // taken the session past the most it watches, unless this code is wrong (faults.ts).
          if (isNew && deps.subs.list().length > Math.max(MAX_SUBSCRIPTIONS, watchedBefore)) internalError("watch_cap_exceeded");
          // Asked for by name: a mute of the whole pull request no longer holds. Kind and workflow mutes stay.
          const lifted = deps.subs.mutes.remove({ repo: t.repo, pr: t.pr });
          (deps.eventLog ?? NO_EVENT_LOG).write("subscribe", {
            repo: t.repo,
            pr: t.pr,
            source: "tool",
            events: events.events === "all" ? "all" : [...events.events],
          });
          return { text: `Subscribed to ${t.repo} PR #${t.pr} (${label(events.events)})${lifted ? "; its mute is lifted" : ""}.${gaveWay}\n${describe(snap)}\n${deps.liveEvents === false ? EVENTS_OFF_NOTE : CHANNEL_NOTE}` };
        }
        case "unsubscribe": {
          const record = (repo: string | null, pr: number | null, count: number) =>
            (deps.eventLog ?? NO_EVENT_LOG).write("unsubscribe", { repo, pr, source: "tool", reason: "tool", count });
          if (args.scope !== undefined) {
            const scopes = scopeStore(deps, args);
            if (!scopes.ok) return err(scopes.text);
            if (args.pr !== undefined || args.all !== undefined || args.whole_repo !== undefined)
              return err("A scope is ended by its repository alone: pass scope and repo.");
            const r = await scopeRepo(deps, args);
            if (!r.ok) return err(r.text);
            if (scopes.store.remove(r.repo) === 0) return { text: `No scope is set for ${r.repo}.` };
            // The pull requests the scope held go with it; one Claude, the hook or the branch asked for stays.
            let held = 0;
            for (const e of deps.subs.list()) {
              if (e.source === "scope" && e.repo.toLowerCase() === r.repo.toLowerCase()) held += deps.subs.remove(e.repo, e.pr);
            }
            deps.subs.mutes.endScopeMutes((repo) => same(repo, r.repo));
            deps.subs.scopeHoldings.delete(r.repo.toLowerCase());
            (deps.eventLog ?? NO_EVENT_LOG).write("scope_unset", { repo: r.repo, kind: "repo", count: held });
            return { text: `Stopped watching ${r.repo} as a scope (${held} pull request(s) it held).` };
          }
          const covered = (repo: string) => (deps.scopes?.list() ?? []).some((s) => same(s.repo, repo));
          // A SCOPE MUST NOT QUIETLY UNDO AN UNSUBSCRIBE. Its next look at the repository, within a minute, would hold the
          // pull request again. So unsubscribing ONE pull request of a scoped repository leaves a mute of it (as
          // unsubscribing the branch's own does), which the scope honours and which ends when the pull request leaves the
          // open list or the scope ends; whoever held it, and even if nothing did (one the cap had left out).
          const muteUnderScope = (repo: string, pr: number): string => {
            deps.subs.mutes.remove({ repo, pr }); // a mute of it that ends with the branch would end too soon
            const added = deps.subs.mutes.add({ repo, pr, whileScoped: true });
            if (added === "full") {
              return ` A scope covers ${repo}, and this session already has ${MAX_MUTES} mutes, so the scope may add PR #${pr} back: unmute one, then unsubscribe again.`;
            }
            (deps.eventLog ?? NO_EVENT_LOG).write("mute", { ...muteLog({ repo, pr }), source: "unsubscribe_scoped" });
            return ` A scope covers ${repo}, so PR #${pr} is muted in this session and the scope will not add it back: until it closes, the scope ends, or unmute or subscribe names it.`;
          };
          // WHOLE_REPO AND ALL END THE SCOPES THEY COVER, and say so. "Stop watching everything" that a scope refilled a
          // minute later would be the quiet undo again; twenty mutes would not cover the next pull request opened. A scope
          // is the project's, so this ends it for every session of the project, which the answer says.
          const endScopes = (repo?: string): string => {
            const ended = (deps.scopes?.list() ?? []).filter((s) => !repo || same(s.repo, repo));
            let note = "";
            for (const s of ended) {
              deps.scopes?.remove(s.repo);
              deps.subs.mutes.endScopeMutes((r) => same(r, s.repo));
              deps.subs.scopeHoldings.delete(s.repo.toLowerCase());
              (deps.eventLog ?? NO_EVENT_LOG).write("scope_unset", { repo: s.repo, kind: "repo", reason: repo ? "whole_repo" : "all" });
              note += ` The scope on ${s.repo} is ended too, for this project (every session of it), or it would watch them again: subscribe with scope: "repo" sets it again.`;
            }
            return note;
          };
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
            const note = (await muteBranchPr()) + endScopes();
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
            const note = (await muteBranchPr(repo)) + endScopes(repo);
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
          const note = covered(one.repo) ? muteUnderScope(one.repo, one.pr) : await muteBranchPr(one.repo, one.pr);
          const count = deps.subs.remove(one.repo, one.pr);
          record(one.repo, one.pr, count);
          return { text: count ? `Stopped watching ${one.repo} PR #${one.pr}.${note}` : `${one.repo} PR #${one.pr} was not watched.${note}` };
        }
        case "list_subscriptions": {
          const scopes = deps.scopes?.list() ?? [];
          const all = deps.subs.list();
          const problem = deps.scopes?.problem ? [deps.scopes.problem] : [];
          const mutes = deps.subs.mutes.list();
          // What each scope holds now, as the poller last worked it out; nothing yet before its first look.
          const holding = (repo: string): string => {
            const h = deps.subs.scopeHoldings.get(repo.toLowerCase());
            if (!h) return "";
            if (h.problem) return `: ${h.problem}`;
            const held = h.held.length ? `holds ${h.held.length} (${h.held.map((n) => `#${n}`).join(", ")})` : "holds none";
            const left = h.leftOut
              ? `; ${h.leftOut} more open pull request(s) it covers are left out, because a session watches at most ${MAX_SUBSCRIPTIONS}`
              : "";
            const more = h.more ? "; only the newest 100 open pull requests are read" : "";
            return `: ${held}${left}${more}`;
          };
          const why = (source: string) =>
            source === "auto" ? " (automatic: the current branch's PR)" : source === "scope" ? " (held by the scope)" : "";
          const watched =
            all.length || scopes.length
              ? [
                  ...scopes.map((s) => `- ${s.repo}: ${covers("", s.involves, "")} (scope)${holding(s.repo)}`),
                  ...all.map((e) => `- ${e.repo} PR #${e.pr}: ${label(e.events)}${why(e.source)}`),
                ].join("\n")
              : "No subscriptions in this session.";
          const muted = mutes.length
            ? [`Muted in this session only (${mutes.length} of ${MAX_MUTES}):`, ...mutes.map((m) => `- ${muteText(m)}`)]
            : [];
          return { text: [watched, ...muted, ...problem].join("\n") };
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
