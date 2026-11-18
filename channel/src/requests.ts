/**
 * Review requests for the session's own GitHub login: `review.requested`, from ONE GraphQL search,
 * `is:pr is:open review-requested:@me` (which counts a team's request as well as the login's own), read every few
 * minutes (poller.ts) for 1 point of GraphQL's own budget, and shared by every session on the machine.
 *
 * It is not about a watched pull request: it is how a session hears that somebody wants the user's review on a
 * pull request it is not watching. It is opt-in (RUNNERS_IO_REVIEW_REQUESTS=on), because every session with it on
 * hears every request.
 *
 * NO TITLE. A pull request's title is written by whoever opened it. Only the repository, the number, who asked,
 * whom they asked and a link leave here; Claude reads the rest with `gh` itself.
 *
 * ONCE, AND ONLY NEW. A request is its ReviewRequestedEvent: asked again is a new request. The first reading is a
 * baseline, and a request made before it is never sent, even when some other update lifts its pull request into
 * the first page of the search.
 */
import { type ChannelMessage, clean, safeLink } from "./format.ts";

export interface ReviewRequest {
  /** The ReviewRequestedEvent's id: one request. */
  readonly id: string;
  readonly repo: string;
  readonly pr: number;
  readonly url: string;
  /** This login, or `org/team` for a team's request. */
  readonly reviewer: string;
  readonly requester: string;
  readonly requesterType: "bot" | "user";
  readonly at: string;
}

export interface RequestsReading {
  readonly viewer: string;
  readonly requests: readonly ReviewRequest[];
}

/** What a reading leaves for the next: the requests already seen, and when the session first looked. */
export interface RequestsSeen {
  readonly since: number;
  readonly ids: ReadonlySet<string>;
}

export const REQUESTS_SEARCH = "is:pr is:open archived:false review-requested:@me sort:updated-desc";

export const REQUESTS_QUERY = `query($q: String!) {
  rateLimit { cost remaining limit resetAt }
  viewer { login }
  search(query: $q, type: ISSUE, first: 30) {
    nodes { ... on PullRequest { number url repository { nameWithOwner }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) { nodes { ... on ReviewRequestedEvent {
        id createdAt actor { login __typename }
        requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } }
      } } } } }
  }
}`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nodes = (v: unknown): Json[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : []);
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The search's answer as each pull request's newest request naming this login or a team; null with no data. */
export function parseReviewRequests(body: unknown): RequestsReading | null {
  const data = obj(obj(body).data);
  const viewer = str(obj(data.viewer).login);
  if (!viewer || !Array.isArray(obj(data.search).nodes)) return null;
  const requests: ReviewRequest[] = [];
  for (const pr of nodes(data.search)) {
    const repo = str(obj(pr.repository).nameWithOwner);
    if (!REPO.test(repo) || typeof pr.number !== "number") continue;
    // A team's request counts: the search matched the pull request because of this login or one of its teams.
    const mine = nodes(pr.timelineItems)
      .filter((e) => str(e.id))
      .map((e) => {
        const r = obj(e.requestedReviewer);
        const reviewer = r.__typename === "Team" ? `${str(obj(r.organization).login)}/${str(r.slug)}` : str(r.login);
        return { e, reviewer, isMine: r.__typename === "Team" || str(r.login).toLowerCase() === viewer.toLowerCase() };
      })
      .filter((x) => x.isMine)
      .at(-1);
    if (!mine) continue;
    const actor = obj(mine.e.actor);
    requests.push({
      id: str(mine.e.id),
      repo,
      pr: pr.number,
      url: str(pr.url),
      reviewer: mine.reviewer,
      requester: str(actor.login) || "ghost",
      requesterType: actor.__typename === "Bot" ? "bot" : "user",
      at: str(mine.e.createdAt),
    });
  }
  return { viewer, requests };
}

/** The new requests in `next`, and what to keep. `prev` null: a baseline, made at `now`. */
export function requestChanges(prev: RequestsSeen | null, next: RequestsReading, now: number): { fresh: ReviewRequest[]; keep: RequestsSeen } {
  const since = prev?.since ?? now;
  const ids = new Set(prev?.ids ?? []);
  const fresh: ReviewRequest[] = [];
  for (const r of next.requests) {
    if (ids.has(r.id)) continue;
    ids.add(r.id);
    const at = Date.parse(r.at);
    if (prev && Number.isFinite(at) && at >= since) fresh.push(r);
  }
  return { fresh, keep: { since, ids } };
}

export function requestMessage(r: ReviewRequest): ChannelMessage {
  const repo = REPO.test(r.repo) ? r.repo : "";
  const requester = clean(r.requester, 40);
  const reviewer = clean(r.reviewer, 80);
  const url = safeLink(r.url);
  const team = reviewer.includes("/") ? ` (the team ${reviewer})` : "";
  const content =
    `Review requested${team}: ${repo}#${r.pr}, by ${requester}${r.requesterType === "bot" ? " (a bot)" : ""}. ${url}`.trim() +
    " Tell the user; it is not a request from the user." +
    (repo ? ` Read it (gh pr view ${r.pr} --repo ${repo}) only if the user asks.` : " Read it only if the user asks.");
  return {
    content,
    meta: {
      kind: "review.requested",
      repo,
      pr: String(r.pr),
      requester,
      requester_type: r.requesterType,
      reviewer,
      ...(url ? { url } : {}),
    },
  };
}
