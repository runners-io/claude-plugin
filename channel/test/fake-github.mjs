// A fake of the few GitHub REST endpoints the channel reads, on 127.0.0.1,
// with ETag/304 and the rate-limit answer GitHub gives. Plain JavaScript so
// the Node 20 bundle test can use it too.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function startFakeGitHub({ token = "gho_fakeToken123" } = {}) {
  const state = {
    token,
    pulls: new Map(), // "o/r#n" -> pull
    runs: new Map(), // "o/r@sha" -> runs[]
    jobs: new Map(), // runId -> jobs[]
    annotations: new Map(), // job (check run) id -> annotations[]
    commits: new Map(), // "o/r#n" -> [{ sha }]
    baseRuns: new Map(), // "o/r@branch" -> runs[] (push runs on a branch)
    issueEvents: new Map(), // "o/r#n" -> [{ event, created_at, label? }]
    attempts: new Map(), // "runId/attempt" -> run
    rateLimited: null, // null | { resetEpoch }
    rate: { remaining: 4999, limit: 5000, reset: null }, // the x-ratelimit-* headers of every answer (reset: epoch s)
    secondaryLimited: false, // a 403 with no rate-limit headers, only the message
    scopes: "repo, workflow", // x-oauth-scopes; null = a fine-grained token (no header)
    failNext: [], // [{ pattern: RegExp, status, count }]
    restReviews: new Map(), // "o/r#n" -> [{ id, state, submitted_at }] (REST pulls/{n}/reviews)
    reviewComments: new Map(), // "o/r#n" -> [{ id, created_at, in_reply_to_id? }] (REST pulls/{n}/comments)
    reviewRequests: { viewer: "octocat", nodes: [] }, // what the review-requested:@me search answers
    involved: new Map(), // "o/r" -> PR numbers the involves:@me search answers
    reviewPulls: new Map(), // "o/r#n" -> the GraphQL pullRequest node the review query answers with
    graphqlRate: { remaining: 4990, limit: 5000 }, // GraphQL's own budget, separate from REST's
    repos: new Map(), // "o/r" -> the repository's own fields (fork, private); one not listed is a plain public one
  };
  const requests = [];

  const send = (req, res, status, body, extra = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    const headers = { "content-type": "application/json", "x-ratelimit-remaining": String(state.rate.remaining), "x-ratelimit-limit": String(state.rate.limit), ...(state.rate.reset ? { "x-ratelimit-reset": String(state.rate.reset) } : {}), ...extra };
    if (state.scopes !== null) headers["x-oauth-scopes"] = state.scopes;
    if (status === 200) {
      headers.etag = etag;
      if (req.headers["if-none-match"] === etag) {
        requests.push({ path: req.url, status: 304 });
        res.writeHead(304, headers).end();
        return;
      }
    }
    requests.push({ path: req.url, status });
    res.writeHead(status, headers).end(text);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(req, res, 401, { message: "Bad credentials" });
    const fail = state.failNext.find((f) => f.count > 0 && f.pattern.test(url.pathname));
    if (fail) {
      fail.count--;
      return send(req, res, fail.status, { message: "Not Found" });
    }
    if (state.secondaryLimited) {
      return send(req, res, 403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
    }
    if (req.method === "POST" && url.pathname === "/graphql") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(req, res, 400, { message: "Problems parsing JSON" });
        }
        const v = body.variables ?? {};
        const node = state.reviewPulls.get(`${v.owner}/${v.name}#${v.number}`) ?? null;
        const resetAt = new Date(Date.now() + 3_600_000).toISOString();
        const rate = { cost: 1, remaining: state.graphqlRate.remaining, limit: state.graphqlRate.limit, resetAt };
        requests.push({ path: "/graphql", status: 200, query: String(body.query ?? ""), variables: v });
        const data = String(body.query ?? "").includes("search(")
          ? { rateLimit: rate, viewer: { login: state.reviewRequests.viewer }, search: { nodes: state.reviewRequests.nodes } }
          : { rateLimit: rate, repository: node ? { pullRequest: node } : { pullRequest: null } };
        res
          .writeHead(200, {
            "content-type": "application/json",
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": String(state.graphqlRate.remaining),
            "x-ratelimit-limit": String(state.graphqlRate.limit),
          })
          .end(JSON.stringify({ data }));
      });
      return;
    }
    if (state.rateLimited) {
      return send(req, res, 403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(state.rateLimited.resetEpoch),
      });
    }
    if (url.pathname === "/user") return send(req, res, 200, { login: state.reviewRequests.viewer });
    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m) return send(req, res, 200, { full_name: `${m[1]}/${m[2]}`, fork: false, private: false, ...(state.repos.get(`${m[1]}/${m[2]}`) ?? {}) });
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (m) {
      const pull = state.pulls.get(`${m[1]}/${m[2]}#${m[3]}`);
      return pull ? send(req, res, 200, pull) : send(req, res, 404, { message: "Not Found" });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.restReviews.get(`${m[1]}/${m[2]}#${m[3]}`) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.reviewComments.get(`${m[1]}/${m[2]}#${m[3]}`) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/commits$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.commits.get(`${m[1]}/${m[2]}#${m[3]}`) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      if (!url.searchParams.has("head")) {
        // The repository's open PRs, newest first (a repo scope's discovery).
        const all = [...state.pulls.entries()].filter(([k, p]) => k.startsWith(`${repo}#`) && p.state === "open").map(([, p]) => p);
        return send(req, res, 200, all.sort((a, b) => b.number - a.number));
      }
      const [owner, branch] = (url.searchParams.get("head") ?? "").split(":");
      const open = [...state.pulls.entries()]
        .filter(([k, p]) => k.startsWith(`${repo}#`) && p.state === "open" && p.head.ref === branch && owner === m[1])
        .map(([, p]) => p);
      return send(req, res, 200, open);
    }
    if (url.pathname === "/search/issues") {
      // `is:pr is:open repo:o/r involves:@me`: the open PRs setInvolved named.
      const q = url.searchParams.get("q") ?? "";
      const repo = /(?:^|\s)repo:(\S+)/.exec(q)?.[1] ?? "";
      const numbers = state.involved.get(repo) ?? [];
      const items = numbers
        .map((n) => state.pulls.get(`${repo}#${n}`))
        .filter((p) => p && p.state === "open")
        .map((p) => ({ number: p.number, html_url: p.html_url, repository_url: `https://api.github.com/repos/${repo}`, pull_request: {} }));
      return send(req, res, 200, { total_count: items.length, incomplete_results: false, items });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(url.pathname);
    if (m) {
      const branch = url.searchParams.get("branch");
      const sha = url.searchParams.get("head_sha");
      const repo = `${m[1]}/${m[2]}`;
      // A run carries its head branch and repository, as GitHub's do: by default those of the pull request whose head
      // or commit list has that commit.
      const ownerOf = (s) =>
        [...state.pulls.entries()].find(
          ([k, p]) => k.startsWith(`${repo}#`) && (p.head?.sha === s || (state.commits.get(k) ?? []).some((c) => c.sha === s)),
        )?.[1];
      const prRuns = [...state.runs.entries()]
        .filter(([k]) => k.startsWith(`${repo}@`))
        .flatMap(([k, rs]) => {
          const s = k.slice(k.indexOf("@") + 1);
          return rs.map((r) => ({ head_branch: ownerOf(s)?.head?.ref ?? "fix-login", head_repository: { full_name: repo }, ...r }));
        });
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const runs = sha
        ? prRuns.filter((r) => r.head_sha === sha && (!branch || r.head_branch === branch))
        : [...(state.baseRuns.get(`${repo}@${branch}`) ?? []), ...prRuns.filter((r) => r.head_branch === branch && url.searchParams.get("event") !== "push")]
            // As GitHub pages them: newest first, per_page at a time.
            .toSorted((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
            .slice((page - 1) * per, page * per);
      return send(req, res, 200, { total_count: runs.length, workflow_runs: runs });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/events$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.issueEvents.get(`${m[1]}/${m[2]}#${m[3]}`) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(url.pathname);
    if (m) {
      const a = state.attempts.get(`${m[3]}/${m[4]}`);
      return a ? send(req, res, 200, a) : send(req, res, 404, { message: "Not Found" });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/check-runs\/(\d+)\/annotations$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.annotations.get(Number(m[3])) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (m) {
      const jobs = state.jobs.get(Number(m[3])) ?? [];
      return send(req, res, 200, { total_count: jobs.length, jobs });
    }
    send(req, res, 404, { message: "Not Found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}`,
    state,
    requests,
    /** A pull request as GitHub returns it, with sensible defaults. */
    setPull(repo, number, fields = {}) {
      const prev = state.pulls.get(`${repo}#${number}`);
      const pull = {
        number,
        state: "open",
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        html_url: `https://github.com/${repo}/pull/${number}`,
        head: { sha: "a".repeat(40), ref: "fix-login", repo: { full_name: repo } },
        user: { login: state.reviewRequests.viewer }, // opened by the signed-in login unless a test says otherwise
        ...prev,
        ...fields,
      };
      if (fields.head) pull.head = { repo: { full_name: repo }, ...(prev?.head ?? {}), ...fields.head };
      state.pulls.set(`${repo}#${number}`, pull);
      return pull;
    },
    setInvolved(repo, numbers) {
      state.involved.set(repo, numbers);
    },
    deletePull(repo, number) {
      state.pulls.delete(`${repo}#${number}`);
    },
    setRuns(repo, sha, runs) {
      state.runs.set(
        `${repo}@${sha}`,
        runs.map((r) => ({
          status: "queued",
          conclusion: null,
          run_attempt: 1,
          head_sha: sha,
          // As GitHub reports a pull request's own run: started by a push to it, by the signed-in login.
          event: "pull_request",
          triggering_actor: { login: state.reviewRequests.viewer },
          html_url: `https://github.com/${repo}/actions/runs/${r.id}`,
          ...r,
        })),
      );
    },
    setCommits(repo, number, shas) {
      state.commits.set(`${repo}#${number}`, shas.map((sha) => ({ sha })));
    },
    setBaseRuns(repo, branch, runs) {
      state.baseRuns.set(`${repo}@${branch}`, runs);
    },
    setIssueEvents(repo, number, events) {
      state.issueEvents.set(`${repo}#${number}`, events);
    },
    setAttempt(runId, attempt, run) {
      state.attempts.set(`${runId}/${attempt}`, run);
    },
    setRate(remaining, limit = 5000, reset = null) {
      state.rate = { remaining, limit, reset };
    },
    /** The GraphQL pullRequest node (headRefOid, mergeStateStatus, latestOpinionatedReviews, reviewThreads, ...). */
    setReviews(repo, number, reviews) {
      state.restReviews.set(`${repo}#${number}`, reviews);
    },
    setReviewComments(repo, number, comments) {
      state.reviewComments.set(`${repo}#${number}`, comments);
    },
    setReviewRequests(nodes, viewer = "octocat") {
      state.reviewRequests = { viewer, nodes };
    },
    setReviewPull(repo, number, node) {
      state.reviewPulls.set(`${repo}#${number}`, node);
    },
    setGraphqlRate(remaining, limit = 5000) {
      state.graphqlRate = { remaining, limit };
    },
    setAnnotations(jobId, list) {
      state.annotations.set(jobId, list);
    },
    setJobs(runId, jobs) {
      // Every job GitHub returns has an id (a job is a check run); a test that names none gets one per position.
      state.jobs.set(runId, jobs.map((j, i) => ({ id: runId * 1000 + i + 1, ...j })));
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
