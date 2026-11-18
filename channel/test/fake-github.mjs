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
    commits: new Map(), // "o/r#n" -> [{ sha }]
    baseRuns: new Map(), // "o/r@branch" -> runs[] (push runs on a branch)
    issueEvents: new Map(), // "o/r#n" -> [{ event, created_at, label? }]
    attempts: new Map(), // "runId/attempt" -> run
    rateLimited: null, // null | { resetEpoch }
    secondaryLimited: false, // a 403 with no rate-limit headers, only the message
    scopes: "repo, workflow", // x-oauth-scopes; null = a fine-grained token (no header)
    failNext: [], // [{ pattern: RegExp, status, count }]
  };
  const requests = [];

  const send = (req, res, status, body, extra = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    const headers = { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...extra };
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
    if (state.rateLimited) {
      return send(req, res, 403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(state.rateLimited.resetEpoch),
      });
    }
    let m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    if (m) {
      const pull = state.pulls.get(`${m[1]}/${m[2]}#${m[3]}`);
      return pull ? send(req, res, 200, pull) : send(req, res, 404, { message: "Not Found" });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/commits$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.commits.get(`${m[1]}/${m[2]}#${m[3]}`) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      const [owner, branch] = (url.searchParams.get("head") ?? "").split(":");
      const open = [...state.pulls.entries()]
        .filter(([k, p]) => k.startsWith(`${repo}#`) && p.state === "open" && p.head.ref === branch && owner === m[1])
        .map(([, p]) => p);
      return send(req, res, 200, open);
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(url.pathname);
    if (m) {
      const branch = url.searchParams.get("branch");
      const runs = branch ? (state.baseRuns.get(`${m[1]}/${m[2]}@${branch}`) ?? []) : (state.runs.get(`${m[1]}/${m[2]}@${url.searchParams.get("head_sha")}`) ?? []);
      return send(req, res, 200, { total_count: runs.length, workflow_runs: runs });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/events$/.exec(url.pathname);
    if (m) return send(req, res, 200, state.issueEvents.get(`${m[1]}/${m[2]}#${m[3]}`) ?? []);
    m = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(url.pathname);
    if (m) {
      const a = state.attempts.get(`${m[3]}/${m[4]}`);
      return a ? send(req, res, 200, a) : send(req, res, 404, { message: "Not Found" });
    }
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
        head: { sha: "a".repeat(40), ref: "fix-login" },
        ...prev,
        ...fields,
      };
      if (fields.head) pull.head = { ...(prev?.head ?? {}), ...fields.head };
      state.pulls.set(`${repo}#${number}`, pull);
      return pull;
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
    setJobs(runId, jobs) {
      state.jobs.set(runId, jobs);
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
