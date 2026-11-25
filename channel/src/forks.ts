/**
 * A clone that is a fork.
 *
 * The pull request for a fork's branch usually lives on the repository it was forked from (the upstream, or parent),
 * with the fork's branch as its head: `ada:fix-login` on `acme/widgets`. The channel once looked only in the clone's
 * own repository (its `origin`), so in a fork it found nothing and watched nothing.
 *
 * WHICH REPOSITORY IS THE PARENT is taken from the clone when it says: an `upstream` remote that is a GitHub
 * repository other than origin, which costs no request. Otherwise GitHub is asked, once, whether origin is a fork and
 * of what: one conditional request for the repository itself, kept for the session and shared with the machine's other
 * sessions for PARENT_FRESH_MS. A repository does not become a fork later, so a good answer is never asked for again.
 * When GitHub does not answer, nothing is kept as a no: it is asked again after ASK_AGAIN_MS.
 *
 * THE BRANCH'S PULL REQUEST is then looked for on the parent first, by the fork owner's name and the branch, and in the
 * clone's own repository after it (a pull request from a branch to the fork itself, which is how a clone that is not a
 * fork has always been watched). The looking happens only while no pull request is watched for the branch, at the pace
 * the poller already keeps for it: in a fork that is two conditional requests where there was one.
 */
import type { ApiResult, GitHubClient, RepoInfo } from "./github.ts";

/** How long the machine's sessions share one answer about a repository's parent. */
export const PARENT_FRESH_MS = 6 * 60 * 60_000;
/** After an answer GitHub did not give (a timeout, a 5xx, a repository it does not show), it is asked again this much later. */
export const ASK_AGAIN_MS = 10 * 60_000;
/** The most repositories whose parent one session keeps: a session's folder is in one, and its origin rarely changes. */
const KEPT = 50;

export interface BranchPull {
  readonly repo: string;
  readonly pr: number;
}

/** What is read of the clone: its own repository, and its `upstream` remote when that is another GitHub repository. */
export interface CloneScope {
  readonly repo: string | null;
  readonly upstream?: string | null;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class ForkParents {
  private readonly gh: Pick<GitHubClient, "repoInfo">;
  private readonly now: () => number;
  private readonly known = new Map<string, { parent: string | null; until: number }>();

  constructor(gh: Pick<GitHubClient, "repoInfo">, now: () => number = Date.now) {
    this.gh = gh;
    this.now = now;
  }

  /** The repository the clone's own was forked from, or null: not a fork, or not known. May ask GitHub, once. */
  async parentOf(scope: CloneScope): Promise<string | null> {
    if (!scope.repo) return null;
    const local = this.fromRemote(scope);
    if (local !== undefined) return local;
    const key = scope.repo.toLowerCase();
    const hit = this.known.get(key);
    if (hit && this.now() < hit.until) return hit.parent;
    const r = await this.gh.repoInfo(scope.repo, PARENT_FRESH_MS);
    return this.learn(scope.repo, r.kind === "ok" ? r.value : null);
  }

  /**
   * Takes GitHub's answer about a repository from whoever asked (the setup checks' one live call asks the same
   * question), so it is not asked twice. `info` null: GitHub did not answer, which is kept only for ASK_AGAIN_MS.
   * Answers the parent.
   */
  learn(repo: string, info: RepoInfo | null): string | null {
    const key = repo.toLowerCase();
    const parent = info?.fork && info.parent && !same(info.parent, repo) ? info.parent : null;
    this.known.delete(key);
    this.known.set(key, { parent, until: info ? Number.POSITIVE_INFINITY : this.now() + ASK_AGAIN_MS });
    while (this.known.size > KEPT) {
      const oldest = this.known.keys().next().value;
      if (oldest === undefined) break;
      this.known.delete(oldest);
    }
    return parent;
  }

  /** The parent as far as it is known without asking anything: the remote's, or an answer GitHub already gave. */
  knownParent(scope: CloneScope): string | null {
    if (!scope.repo) return null;
    return this.fromRemote(scope) ?? this.known.get(scope.repo.toLowerCase())?.parent ?? null;
  }

  /** The upstream remote's repository; null when the remote is origin itself; undefined when there is no such remote. */
  private fromRemote(scope: CloneScope): string | null | undefined {
    if (!scope.upstream || !scope.repo) return undefined;
    return same(scope.upstream, scope.repo) ? null : scope.upstream;
  }
}

/**
 * The open pull request for the clone's branch: on the parent when the clone is a fork and the parent has one, else in
 * the clone's own repository, else null. A parent GitHub does not show to this login has no pull request to watch, so
 * the clone's own repository answers; a parent GitHub did not answer for at all leaves the question open (`retry`),
 * since taking the fork's own pull request then would hide the parent's for as long as it is watched.
 */
export async function findBranchPull(
  gh: Pick<GitHubClient, "findOpenPull">,
  scope: { readonly repo: string; readonly branch: string; readonly upstream?: string | null },
  parents: Pick<ForkParents, "parentOf">,
): Promise<ApiResult<BranchPull | null>> {
  const parent = await parents.parentOf(scope);
  if (parent) {
    const there = await gh.findOpenPull(parent, scope.branch, scope.repo.split("/")[0]);
    if (there.kind === "ok" && there.value !== null) return { kind: "ok", value: { repo: parent, pr: there.value } };
    if (there.kind === "auth" || there.kind === "retry") return there;
  }
  const own = await gh.findOpenPull(scope.repo, scope.branch);
  if (own.kind !== "ok") return own;
  return { kind: "ok", value: own.value === null ? null : { repo: scope.repo, pr: own.value } };
}
