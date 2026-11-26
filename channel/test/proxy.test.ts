// A company proxy (channel/src/proxy.ts, hooks/proxy.mjs): the channel's GitHub requests go through the proxy the
// environment names, the way `gh` already does, on every Node.js the plugin supports. Each case runs the real client
// against the fake GitHub, with a real CONNECT proxy on this machine in front of it.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { type GhAuth, GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { githubFetch, proxyNote } from "../src/proxy.ts";
import { bypassed, nodeProxiesItself, parseProxy, proxyFor, proxyVariable, sendRefusal, tlsChecksOff } from "../../hooks/proxy.mjs";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";
import { type FakeProxy, startFakeProxy } from "./fake-proxy.mjs";

setQuiet(true);
const TOKEN = "gho_fakeProxyToken0123456789";
const SECRET = "s3cr3t-pa55";
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
});
const auth = async (): Promise<GhAuth> => ({ kind: "ok", token: TOKEN, source: "gh" });

async function world(proxyOptions: { auth?: string | null; refuse?: number | null } = {}): Promise<{ gh: FakeGitHub; proxy: FakeProxy; authority: string }> {
  const gh = await startFakeGitHub({ token: TOKEN });
  const proxy = await startFakeProxy(proxyOptions);
  closers.push(() => gh.close(), () => proxy.close());
  gh.setPull("acme/widgets", 7, { head: { ref: "feat", sha: "c".repeat(40) } });
  return { gh, proxy, authority: new URL(gh.base).host };
}

// ---- which way a request goes -------------------------------------------------------------------------------------

test("no proxy variable: the way is direct, and the channel's fetch is Node's own, untouched", () => {
  assert.deepEqual(proxyFor({}, "https://api.github.com"), { kind: "direct", why: "unset" });
  assert.equal(proxyVariable({ HTTP_PROXY: "http://p:1", ALL_PROXY: "http://p:1", HTTPS_PROXY: "  " }), null);
  const mine: typeof fetch = async () => new Response("mine");
  assert.equal(githubFetch({}, mine), mine, "nothing is wrapped when no proxy variable is set");
  assert.equal(githubFetch({ NO_PROXY: "*", HTTP_PROXY: "http://p:1" }, mine), mine);
  assert.equal(proxyNote({}, "https://api.github.com"), null);
});

test("the proxy variable is read as curl and gh read it: lower case first, a bare host:port is http, the port defaults by scheme", () => {
  assert.equal(proxyVariable({ HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:2" }), "https_proxy");
  assert.equal(proxyVariable({ HTTPS_PROXY: "http://upper:1" }), "HTTPS_PROXY");
  assert.deepEqual(parseProxy("http://proxy.corp:8080"), { protocol: "http:", hostname: "proxy.corp", port: 8080, auth: null, display: "proxy.corp:8080" });
  assert.deepEqual(parseProxy("proxy.corp:3128"), { protocol: "http:", hostname: "proxy.corp", port: 3128, auth: null, display: "proxy.corp:3128" });
  assert.equal(parseProxy("http://proxy.corp")?.port, 80);
  assert.equal(parseProxy("https://proxy.corp")?.port, 443);
  assert.deepEqual(parseProxy("http://[::1]:8080"), { protocol: "http:", hostname: "::1", port: 8080, auth: null, display: "[::1]:8080" });
});

test("a proxy's login is kept for the proxy alone: what is shown is its host and port, never the name or the password", () => {
  const p = parseProxy(`http://ada%40corp:${SECRET}@proxy.corp:8080/`);
  assert.equal(p?.auth, `ada@corp:${SECRET}`);
  assert.equal(p?.display, "proxy.corp:8080");
  const note = proxyNote({ HTTPS_PROXY: `http://ada:${SECRET}@proxy.corp:8080` }, "https://api.github.com") ?? "";
  assert.match(note, /proxy\.corp:8080/);
  assert.match(note, /HTTPS_PROXY/);
  assert.equal(note.includes(SECRET) || note.includes("ada"), false, note);
});

test("a SOCKS proxy, or a value that is no address, is one the channel cannot use, and it says so without the value", () => {
  assert.equal(parseProxy("socks5://proxy.corp:1080"), null);
  assert.equal(parseProxy("http://"), null);
  assert.equal(parseProxy(""), null);
  assert.deepEqual(proxyFor({ HTTPS_PROXY: `socks5://ada:${SECRET}@proxy.corp:1080` }, "https://api.github.com"), { kind: "unusable", variable: "HTTPS_PROXY" });
  const note = proxyNote({ HTTPS_PROXY: `socks5://ada:${SECRET}@proxy.corp:1080` }, "https://api.github.com") ?? "";
  assert.equal(note, "HTTPS_PROXY names a proxy the channel cannot use (only http:// and https:// proxies): no request is made");
  assert.equal(note.includes(SECRET) || note.includes("proxy.corp"), false, note);
});

const PROXY_REFUSAL = "HTTPS_PROXY names a proxy the plugin cannot use, so no request is made: set it to an http:// or https:// proxy, or name the host in NO_PROXY";
const TLS_REFUSAL =
  "NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, so the GitHub login is not sent and no request is made: unset it (NODE_EXTRA_CA_CERTS adds a company's root certificate)";

test("a proxy that is set and cannot be used is a refusal, never a way round it: no request, and a sentence that says what to set", () => {
  for (const value of [`socks5://ada:${SECRET}@proxy.corp:1080`, "socks5h://proxy.corp:1080", "http://", "pac+https://proxy.corp/proxy.pac"]) {
    const refusal = sendRefusal({ HTTPS_PROXY: value }, "https://api.github.com");
    assert.deepEqual(refusal, { why: "proxy_unusable", variable: "HTTPS_PROXY", reason: PROXY_REFUSAL }, value);
  }
  assert.equal(sendRefusal({ https_proxy: "socks5://proxy.corp:1080" }, "https://api.github.com")?.reason, PROXY_REFUSAL.replace("HTTPS_PROXY", "https_proxy"));
  // The ways a request does go: no proxy, a proxy the channel uses, and a host the no_proxy list names.
  assert.equal(sendRefusal({}, "https://api.github.com"), null);
  assert.equal(sendRefusal({ HTTPS_PROXY: "http://proxy.corp:8080" }, "https://api.github.com"), null);
  assert.equal(sendRefusal({ HTTPS_PROXY: "socks5://proxy.corp:1080", NO_PROXY: "api.github.com" }, "https://api.github.com"), null);
  assert.deepEqual(sendRefusal({ HTTPS_PROXY: "socks5://proxy.corp:1080", NO_PROXY: "api.github.com" }, "https://ghe.corp.example/api/v3")?.why, "proxy_unusable");
  // ALL_PROXY is not read: it neither sends a request through a proxy nor stops one.
  assert.equal(sendRefusal({ ALL_PROXY: "socks5://proxy.corp:1080", all_proxy: "socks5://proxy.corp:1080" }, "https://api.github.com"), null);
  assert.deepEqual(proxyFor({ ALL_PROXY: "http://proxy.corp:8080" }, "https://api.github.com"), { kind: "direct", why: "unset" });
});

test("certificate checks switched off is a refusal for a request that carries the login, and only for one", () => {
  assert.equal(tlsChecksOff({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), true);
  for (const value of [undefined, "", "1", "false", "00"]) assert.equal(tlsChecksOff({ NODE_TLS_REJECT_UNAUTHORIZED: value }), false, `${value}: Node.js switches the checks off for "0" and nothing else`);
  const off = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  assert.deepEqual(sendRefusal(off, "https://api.github.com"), { why: "tls_checks_off", reason: TLS_REFUSAL });
  assert.deepEqual(sendRefusal(off, "https://ghe.corp.example/api/v3")?.why, "tls_checks_off");
  assert.equal(sendRefusal(off, "https://www.runners.io/api/plugin/telemetry", { login: false }), null, "a message with no login in it is not held back");
  // The tests' fake GitHub is plain http on this machine: there is no certificate to check, and no real login is sent.
  assert.equal(sendRefusal({ ...off, RUNNERS_IO_TEST_FAKE_GITHUB: "1" }, "http://127.0.0.1:8790"), null);
  assert.deepEqual(sendRefusal(off, "http://127.0.0.1:8790")?.why, "tls_checks_off", "only under the tests' switch");
  // Both at once: the certificate checks are said first, since they are the one that could give the login away.
  assert.deepEqual(sendRefusal({ ...off, HTTPS_PROXY: "socks5://proxy.corp:1080" }, "https://api.github.com")?.why, "tls_checks_off");
});

test("no_proxy: a name matches itself and every name below it, a port matches only itself, * matches everything", () => {
  const yes = (list: string, host = "api.github.com", port = 443) => assert.equal(bypassed(list, host, port), true, `${list} should name ${host}:${port}`);
  const no = (list: string, host = "api.github.com", port = 443) => assert.equal(bypassed(list, host, port), false, `${list} should not name ${host}:${port}`);
  yes("*");
  yes("github.com");
  yes(".github.com");
  yes("*.github.com");
  yes("localhost, 10.0.0.1 ,API.GitHub.com");
  yes("api.github.com:443");
  no("api.github.com:8443");
  no("hub.com", "api.github.com");
  no("example.com,internal");
  no("");
  yes("127.0.0.1", "127.0.0.1", 9999);
  yes("127.0.0.1:9999", "127.0.0.1", 9999);
  no("127.0.0.1:1", "127.0.0.1", 9999);
  no("10.0.0.0/8", "10.1.2.3", 443);
  yes("::1", "[::1]", 443);
  yes("[::1]:443", "::1", 443);
  assert.deepEqual(proxyFor({ https_proxy: "http://p:1", NO_PROXY: "github.com" }, "https://api.github.com"), { kind: "direct", why: "no_proxy", variable: "NO_PROXY" });
  assert.equal(proxyFor({ https_proxy: "http://p:1", no_proxy: "example.com", NO_PROXY: "github.com" }, "https://api.github.com").kind, "proxy", "lower case first, as for the proxy itself");
});

test("NODE_USE_ENV_PROXY=1 on a Node.js that reads the proxy variables itself: the channel stands aside and Node's own fetch is used", () => {
  const mine: typeof fetch = async () => new Response("mine");
  const env = { HTTPS_PROXY: "http://proxy.corp:8080", NODE_USE_ENV_PROXY: "1" };
  for (const version of ["24.0.0", "24.16.0", "26.1.0", "22.21.0", "22.22.1"]) {
    assert.equal(nodeProxiesItself(env, version), true, version);
    assert.equal(githubFetch(env, mine, version), mine, version);
  }
  // A Node.js that does not know the variable ignores it, so the channel still does the work there.
  for (const version of ["20.19.0", "22.16.0", "22.20.9", "23.11.0"]) {
    assert.equal(nodeProxiesItself(env, version), false, version);
    assert.notEqual(githubFetch(env, mine, version), mine, version);
  }
  assert.equal(nodeProxiesItself({ HTTPS_PROXY: "http://p:1" }, "24.16.0"), false, "not asked for");
  assert.equal(nodeProxiesItself({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "0" }, "24.16.0"), false);
  assert.match(proxyNote(env, "https://api.github.com", "24.16.0") ?? "", /Node\.js itself.*NODE_USE_ENV_PROXY=1/);
  assert.match(proxyNote(env, "https://api.github.com", "20.19.0") ?? "", /through the proxy proxy\.corp:8080 \(HTTPS_PROXY\)$/);
});

// ---- through a real proxy -----------------------------------------------------------------------------------------

test("with HTTPS_PROXY set, a GitHub read goes through the proxy's CONNECT tunnel, and the proxy is never handed the token", async () => {
  const { gh, proxy, authority } = await world();
  const client = new GitHubClient(gh.base, auth, githubFetch({ HTTPS_PROXY: proxy.url() }));
  const pull = await client.getPull("acme/widgets", 7);
  assert.equal(pull.kind, "ok");
  assert.equal(pull.kind === "ok" && pull.value.headRef, "feat");
  assert.deepEqual(proxy.connects.map((c) => c.authority), [authority], "one tunnel, to the GitHub address and nowhere else");
  assert.equal(proxy.connects[0].headers.authorization, undefined, "the CONNECT carries no GitHub token");
  assert.equal(JSON.stringify(proxy.connects).includes(TOKEN), false);
  assert.equal(proxy.requests.length, 0, "nothing but CONNECT is ever sent to the proxy itself");
  assert.match(proxy.sent(), /^GET \/repos\/acme\/widgets\/pulls\/7 HTTP\/1\.1\r\n/, "the request itself went through the tunnel");
  assert.equal(gh.requests.at(-1)?.status, 200);
});

test("through the proxy the client behaves as it does without one: ETags and 304s, rate headers, 404s and GraphQL", async () => {
  const { gh, proxy } = await world();
  const client = new GitHubClient(gh.base, auth, githubFetch({ https_proxy: proxy.url() }));
  assert.equal((await client.getPull("acme/widgets", 7)).kind, "ok");
  const again = await client.getPull("acme/widgets", 7);
  assert.equal(again.kind === "ok" && again.value.number, 7);
  assert.deepEqual(gh.requests.map((r) => r.status), [200, 304], "the second read is conditional, and its 304 has no body to trip on");
  assert.equal(client.rateRemaining, 4999);
  assert.deepEqual(client.scopes, ["repo", "workflow"]);
  assert.deepEqual(await client.getPull("acme/widgets", 404), { kind: "not_found" });
  gh.setReviewPull("acme/widgets", 7, { headRefOid: "c".repeat(40), mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", latestOpinionatedReviews: { nodes: [] }, reviewThreads: { nodes: [] } });
  const review = await client.reviewState("acme/widgets", 7, 0);
  assert.equal(review.kind, "ok", JSON.stringify(review));
  assert.equal(proxy.connects.length, 4, "every request, the GraphQL POST included, went through the proxy");
  assert.match(proxy.sent(), /POST \/graphql HTTP\/1\.1\r\n/);
  assert.equal(proxy.sent().split("if-none-match: ").length - 1, 1, "the conditional request carried its ETag through the tunnel");
});

test("NO_PROXY naming GitHub's host sends the request straight there: the proxy sees nothing", async () => {
  const { gh, proxy } = await world();
  for (const noProxy of ["127.0.0.1", "*", `127.0.0.1:${new URL(gh.base).port}`]) {
    const client = new GitHubClient(gh.base, auth, githubFetch({ HTTPS_PROXY: proxy.url(), NO_PROXY: noProxy }));
    assert.equal((await client.getPull("acme/widgets", 7)).kind, "ok", noProxy);
  }
  assert.equal(proxy.connects.length, 0);
  assert.equal(gh.requests.length, 3);
  // ...and a list that names other hosts does not.
  const client = new GitHubClient(gh.base, auth, githubFetch({ HTTPS_PROXY: proxy.url(), NO_PROXY: "localhost,example.com,127.0.0.1:1" }));
  assert.equal((await client.getPull("acme/widgets", 7)).kind, "ok");
  assert.equal(proxy.connects.length, 1);
});

test("a proxy that wants a login is given the one in the variable, in the CONNECT and nowhere else", async () => {
  const { gh, proxy } = await world({ auth: `ada:${SECRET}` });
  const client = new GitHubClient(gh.base, auth, githubFetch({ HTTPS_PROXY: proxy.url(`ada:${SECRET}`) }));
  assert.equal((await client.getPull("acme/widgets", 7)).kind, "ok");
  assert.equal(proxy.connects[0].headers["proxy-authorization"], `Basic ${Buffer.from(`ada:${SECRET}`).toString("base64")}`);
  assert.match(proxy.sent(), /^GET \/repos\/acme\/widgets\/pulls\/7 /, "the request went through the tunnel");
  assert.equal(proxy.sent().includes(SECRET), false, "the proxy's login is not sent on to GitHub");
  assert.equal(proxy.sent().toLowerCase().includes("proxy-authorization"), false);
});

test("a proxy that refuses is a retry that names the proxy's host and its answer, and never its login", async () => {
  const { gh, proxy } = await world({ auth: "ada:right" });
  const client = new GitHubClient(gh.base, auth, githubFetch({ HTTPS_PROXY: proxy.url(`ada:${SECRET}`) }));
  const r = await client.getPull("acme/widgets", 7);
  assert.equal(r.kind, "retry");
  const reason = r.kind === "retry" ? r.reason : "";
  assert.match(reason, new RegExp(`proxy 127\\.0\\.0\\.1:${proxy.port} answered HTTP 407`));
  assert.equal(reason.includes(SECRET) || reason.includes("ada"), false, reason);
  assert.equal(gh.requests.length, 0, "refused by the proxy, the request is not sent some other way");
});

test("a proxy that is not there is a retry, not a request sent straight to GitHub", async () => {
  const { gh, proxy } = await world();
  const port = proxy.port;
  await proxy.close();
  const client = new GitHubClient(gh.base, auth, githubFetch({ HTTPS_PROXY: `http://ada:${SECRET}@127.0.0.1:${port}` }));
  const r = await client.getPull("acme/widgets", 7);
  assert.equal(r.kind, "retry");
  const reason = r.kind === "retry" ? r.reason : "";
  assert.match(reason, new RegExp(`proxy 127\\.0\\.0\\.1:${port}`));
  assert.equal(reason.includes(SECRET), false, reason);
  assert.equal(gh.requests.length, 0);
});

test("a request that runs out of time behind the proxy ends as GitHub timed out, as it does without one", async () => {
  const { gh, proxy } = await world();
  const viaProxy = githubFetch({ HTTPS_PROXY: proxy.url() });
  await assert.rejects(
    () => viaProxy(`${gh.base}/repos/acme/widgets/pulls/7`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1) }),
    (e: Error) => e.name === "TimeoutError",
  );
});

test("a redirect is refused, as the client asks of every request: a token is never carried to another address", async () => {
  const { gh, proxy } = await world();
  gh.state.failNext.push({ pattern: /pulls\/7$/, status: 302, count: 1 });
  const viaProxy = githubFetch({ HTTPS_PROXY: proxy.url() });
  await assert.rejects(() => viaProxy(`${gh.base}/repos/acme/widgets/pulls/7`, { headers: { authorization: `Bearer ${TOKEN}` }, redirect: "error" }), /redirect/);
});

test("a proxy the channel cannot use: no request is made at all, not through it and not around it, and the login is not even read", async () => {
  const { gh, proxy } = await world();
  const env = { HTTPS_PROXY: "socks5://127.0.0.1:1", RUNNERS_IO_TEST_FAKE_GITHUB: "1" };
  let logins = 0;
  const counted = async (): Promise<GhAuth> => {
    logins++;
    return auth();
  };
  const client = new GitHubClient(gh.base, counted, githubFetch(env), { env });
  const before = gh.requests.length;
  const rest = await client.getPull("acme/widgets", 7);
  assert.deepEqual(rest, { kind: "retry", reason: PROXY_REFUSAL, afterMs: 5 * 60_000 });
  const graphql = await client.reviewState("acme/widgets", 7);
  assert.equal(graphql.kind === "retry" && graphql.reason, PROXY_REFUSAL);
  assert.equal(gh.requests.length, before, "GitHub was not asked");
  assert.equal(proxy.connects.length, 0);
  assert.equal(logins, 0, "with nowhere to send it, the login is not read");
  // The same client's fetch, used by itself (as the channel's messages to runners.io are sent): refused there too.
  await assert.rejects(() => githubFetch(env)(`${gh.base}/repos/acme/widgets/pulls/7`), (e: Error) => e.name === "MachineError" && e.message === PROXY_REFUSAL);
  assert.equal(gh.requests.length, before);
  // Where Node.js was told to do the proxying itself, it is not asked either: it knows no more kinds than the channel.
  let asked = 0;
  const spy: typeof fetch = async () => (asked++, new Response("{}"));
  await assert.rejects(() => githubFetch({ ...env, NODE_USE_ENV_PROXY: "1" }, spy, "24.16.0")(`${gh.base}/user`), (e: Error) => e.message === PROXY_REFUSAL);
  assert.equal(asked, 0);
  // A host the no_proxy list names is still asked directly: that is the user's own instruction.
  const named = { ...env, NO_PROXY: "127.0.0.1" };
  assert.equal((await new GitHubClient(gh.base, auth, githubFetch(named), { env: named }).getPull("acme/widgets", 7)).kind, "ok");
});
