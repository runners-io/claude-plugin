// The BUNDLE's telemetry, end to end, as Claude Code runs it: what it sends when its own code fails, and that nothing is
// sent for each failure that is GitHub's, the network's or the machine's. Every send goes to a listener on 127.0.0.1
// that this file starts; each case ends with the control, which shows that listener would have counted a report.
//
// Where this runs inside the runners.io source tree, what the bundle sent is also given to the endpoint's own check
// (apps/web/lib/plugin-telemetry/message.ts), so the plugin and the server cannot drift apart unseen. In the published
// repository that file is not there, and the same patterns are checked from a copy below.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_BODY_BYTES, createTelemetry } from "../../hooks/telemetry.mjs";
import { startFakeEndpoint } from "./fake-endpoint.mjs";
import { startFakeGitHub } from "./fake-github.mjs";
import { startFakeProxy } from "./fake-proxy.mjs";
import { brokenLookup, caught } from "./faulty.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "runners-io-channel.mjs");
const VERSION = JSON.parse(readFileSync(join(here, "..", "..", ".claude-plugin", "plugin.json"), "utf8")).version;
const TOKEN = "gho_fakeTelemetryToken0123456789";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function endpoint(opts) {
  const e = await startFakeEndpoint(opts);
  cleanups.push(() => e.close());
  return e;
}

/** A machine of its own, with a session folder that is a clone of acme/widgets on the branch `feat`. */
function machine(url, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "rio-bundle-telemetry-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "repo");
  mkdirSync(project);
  execFileSync("git", ["-C", project, "init", "-q", "-b", "feat"]);
  execFileSync("git", ["-C", project, "remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  return {
    PATH: process.env.PATH,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    GH_CONFIG_DIR: join(root, "gh"),
    CLAUDE_PROJECT_DIR: project,
    RUNNERS_IO_POLL_SECONDS: "5",
    RUNNERS_IO_TEST_FAKE_GITHUB: "1",
    RUNNERS_IO_TEST_GITHUB_TOKEN: TOKEN,
    RUNNERS_IO_TEST_TELEMETRY_URL: url,
    ...extra,
  };
}

/** Runs one of the bundle's commands to its end. */
function command(env, ...args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bundle, ...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.once("exit", (code) => done({ code, stdout, stderr }));
  });
}

/** The channel server, speaking MCP on stdio. */
function serve(env) {
  const child = spawn(process.execPath, [bundle], { env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const state = { stderr: "", exit: null };
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      messages.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d) => (state.stderr += d));
  const exited = new Promise((r) => child.once("exit", (code) => r((state.exit = code))));
  // A case that fails before it stops its channel must not leave one running: a child left alive keeps this file's
  // process alive, and the whole run then waits on it for ever.
  cleanups.push(() => {
    if (state.exit === null) child.kill("SIGKILL");
  });
  let id = 0;
  const until = async (what, fn, ms = 15_000) => {
    const began = Date.now();
    while (!fn()) {
      if (Date.now() - began > ms) throw new Error(`timed out waiting for ${what}; stderr:\n${state.stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const ask = async (method, params) => {
    const mine = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    await until(method, () => messages.some((m) => m.id === mine));
    return messages.find((m) => m.id === mine);
  };
  return {
    messages,
    state,
    exited,
    until,
    ask,
    tool: async (name, args = {}) => (await ask("tools/call", { name, arguments: args })).result,
    async open() {
      await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async stop() {
      child.stdin.end();
      await exited;
    },
  };
}

/** The endpoint's own check of a message, where the source tree holds it (and this Node.js can load it), else null. */
async function serverCheck() {
  const web = resolve(here, "..", "..", "..", "..", "apps", "web", "lib", "plugin-telemetry");
  if (!existsSync(join(web, "message.ts")) || Number(process.versions.node.split(".")[0]) < 24) return null;
  const { parsePluginMessage, MAX_BODY_BYTES: serverMax } = await import(pathToFileURL(join(web, "message.ts")).href);
  const { PUBLISHED_PLUGIN_VERSIONS } = await import(pathToFileURL(join(web, "versions.ts")).href);
  return { parse: (m) => parsePluginMessage(m, PUBLISHED_PLUGIN_VERSIONS), serverMax, published: PUBLISHED_PLUGIN_VERSIONS };
}

/** The endpoint's patterns, copied: what a message must pass where the endpoint's own check is not at hand. */
function passesCopiedPatterns(m) {
  const frame = /^(<external>|[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79} [a-z0-9][a-z0-9.-]{0,59}\.mjs:[1-9][0-9]{0,6}:[1-9][0-9]{0,5})$/;
  const base =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.install_id) &&
    /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(m.version) &&
    ["darwin", "linux", "win32", "freebsd", "openbsd", "netbsd", "sunos", "aix", "android"].includes(m.os) &&
    Number.isInteger(m.node_major) && m.node_major >= 18 && m.node_major <= 99;
  if (m.kind === "install" || m.kind === "update") {
    return base && Object.keys(m).every((k) => ["kind", "install_id", "version", "previous_version", "os", "node_major"].includes(k));
  }
  return (
    base &&
    m.kind === "error" &&
    Object.keys(m).every((k) => ["kind", "install_id", "version", "os", "node_major", "component", "error_name", "fingerprint", "frames", "code"].includes(k)) &&
    /^[a-z][a-z0-9-]{0,23}(:[a-z][a-z0-9_-]{0,39})?$/.test(m.component) &&
    /^[A-Z][A-Za-z0-9]{0,63}$/.test(m.error_name) &&
    /^[0-9a-f]{16}$/.test(m.fingerprint) &&
    Array.isArray(m.frames) && m.frames.length >= 1 && m.frames.length <= 8 && m.frames.every((f) => frame.test(f)) && m.frames.some((f) => f !== "<external>") &&
    (m.code === undefined || /^[a-z][a-z0-9_]{0,63}$/.test(m.code))
  );
}

// ---- what the bundle sends, and that the endpoint takes it -----------------------------------------------------------

test("the bundle's own fault report names the bundle's file and line, is under 1 KB, and is sent once a day", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const r = await command(env, "telemetry-test");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^telemetry: on /);
  assert.match(r.stdout, /test report: sent\n$/);
  assert.equal(e.requests.length, 1);
  assert.ok(Buffer.byteLength(e.requests[0].body) < MAX_BODY_BYTES);
  const [m] = e.messages();
  assert.equal(m.kind, "error");
  assert.equal(m.version, VERSION);
  assert.equal(m.component, "channel");
  assert.equal(m.error_name, "InternalError");
  assert.equal(m.code, "telemetry_self_test");
  assert.ok(m.frames.length >= 1);
  for (const f of m.frames) assert.match(f, /^(<external>|[A-Za-z_$<][A-Za-z0-9_$.<>]* runners-io-channel\.mjs:\d+:\d+)$/);
  assert.equal(r.stdout.includes(m.install_id), false, "the install id is never shown");
  // The same fault the same day, from another process: not sent again.
  assert.match((await command(env, "telemetry-test")).stdout, /test report: duplicate\n$/);
  assert.equal(e.requests.length, 1);
});

test("what the plugin sends passes the endpoint's own check, field for field: the bundle's report, a hook's report and both pings", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  await command(env, "telemetry-test");
  const t = (version) => createTelemetry({ component: "hook:session-start", version, env });
  assert.equal(await t(VERSION).ping(), "sent");
  assert.equal(await t(VERSION).report(caught(() => brokenLookup("a message that is never sent"))), "sent");
  assert.equal(await t(VERSION).report(caught(() => brokenLookup()), { component: "tool:ci_status" }), "sent");
  const sent = e.messages();
  assert.deepEqual(sent.map((m) => m.kind), ["error", "install", "error", "error"]);
  // An update's shape, with the version it replaced (not posted: a later version is not yet one the endpoint lists).
  const update = { ...sent[1], kind: "update", previous_version: "0.3.16" };

  for (const m of [...sent, update]) assert.equal(passesCopiedPatterns(m), true, JSON.stringify(m));
  const server = await serverCheck();
  if (!server) return; // the published repository, or a Node.js that cannot load TypeScript: the copy above is the check
  assert.equal(server.serverMax, MAX_BODY_BYTES, "the plugin's size limit is the endpoint's");
  assert.ok(server.published.includes(VERSION), `the endpoint does not list ${VERSION}: its install pings would be dropped`);
  for (const m of [...sent, update]) {
    const parsed = server.parse(m);
    assert.deepEqual({ ok: parsed.ok, reason: parsed.reason }, { ok: true, reason: undefined }, JSON.stringify(m));
  }
  // The control: the endpoint's check does refuse. A message with one more field, and one with a path in a frame.
  assert.equal(server.parse({ ...sent[0], message: "x" }).ok, false);
  assert.equal(server.parse({ ...sent[0], frames: ["f /Users/me/x.mjs:1:1"] }).ok, false);
});

// ---- never reported, through the bundle --------------------------------------------------------------------------------

/** Every GitHub request answered with this, for as long as the session lasts. */
const always = (status, more = {}) => ({ pattern: /./, status, count: 1_000_000, ...more });

const GITHUB_ANSWERS = {
  "401 (a token GitHub rejects)": (gh) => gh.state.failNext.push(always(401, { body: { message: "Bad credentials" } })),
  "403 (forbidden)": (gh) => gh.state.failNext.push(always(403, { body: { message: "Resource not accessible" } })),
  "403 with single sign-on": (gh) => gh.state.failNext.push(always(403, { headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=x" }, body: { message: "Resource protected by organization SAML enforcement." } })),
  "404 (not found, or not shown to this login)": (gh) => gh.state.failNext.push(always(404)),
  "422 (unprocessable)": (gh) => gh.state.failNext.push(always(422, { body: { message: "Validation Failed" } })),
  "500": (gh) => gh.state.failNext.push(always(500, { body: { message: "Server Error" } })),
  "502": (gh) => gh.state.failNext.push(always(502, { body: "<html>Bad Gateway</html>" })),
  "503": (gh) => gh.state.failNext.push(always(503, { body: { message: "Service Unavailable" } })),
  "the hourly rate limit": (gh) => {
    gh.state.rateLimited = { resetEpoch: Math.floor(Date.now() / 1000) + 3600 };
  },
  "a secondary rate limit": (gh) => {
    gh.state.secondaryLimited = true;
  },
  "an answer that is not JSON": (gh) => gh.state.failNext.push(always(200, { body: "<html>a proxy's sign-in page</html>" })),
};

/** A session's worth of use: every tool, and the poller's own looks for a moment. */
async function useEverything(s) {
  await s.open();
  const answers = [];
  answers.push(await s.tool("ci_status", {}));
  answers.push(await s.tool("ci_status", { repo: "acme/widgets", pr: 7 }));
  answers.push(await s.tool("subscribe", {}));
  answers.push(await s.tool("subscribe", { repo: "acme/widgets", pr: 7 }));
  answers.push(await s.tool("subscribe", { scope: "repo" }));
  answers.push(await s.tool("list_subscriptions", {}));
  answers.push(await s.tool("mute", { repo: "acme/widgets", pr: 7 }));
  answers.push(await s.tool("unmute", { repo: "acme/widgets", pr: 7 }));
  answers.push(await s.tool("unsubscribe", { repo: "acme/widgets", pr: 7 }));
  answers.push(await s.tool("no_such_tool", {}));
  // The poller's first looks: the login, the branch's pull request, the scope.
  await new Promise((r) => setTimeout(r, 700));
  return answers;
}

/** The control each case ends with: on the same listener and the same machine, a fault of the bundle's own IS counted. */
async function control(e, env) {
  const before = e.requests.length;
  const r = await command(env, "telemetry-test");
  assert.match(r.stdout, /test report: sent\n$/, `the control was not sent: ${r.stdout}${r.stderr}`);
  assert.equal(e.requests.length, before + 1, "the listener does not count what it is sent");
}

for (const [what, arrange] of Object.entries(GITHUB_ANSWERS)) {
  test(`never reported: GitHub answering ${what}`, async () => {
    const e = await endpoint();
    const gh = await startFakeGitHub({ token: TOKEN });
    cleanups.push(() => gh.close());
    gh.setPull("acme/widgets", 7, { head: { ref: "feat", sha: SHA } });
    gh.setRuns("acme/widgets", SHA, [{ id: 51, name: "CI", status: "in_progress" }]);
    arrange(gh);
    const env = machine(e.url, { RUNNERS_IO_GITHUB_API: gh.base });
    const s = serve(env);
    try {
      const answers = await useEverything(s);
      assert.ok(gh.requests.length >= 3, `GitHub was asked only ${gh.requests.length} times: the case did not run`);
      assert.ok(answers.every((a) => typeof a.content?.[0]?.text === "string"), "a tool did not answer");
    } finally {
      await s.stop();
    }
    assert.equal(e.requests.length, 0, `something was sent: ${e.requests.map((r) => r.body).join("\n")}\nstderr:\n${s.state.stderr}`);
    await control(e, env);
  });
}

test("never reported: GitHub cannot be reached at all (connection refused)", async () => {
  const e = await endpoint();
  const env = machine(e.url, { RUNNERS_IO_GITHUB_API: "http://127.0.0.1:9" });
  const s = serve(env);
  try {
    const answers = await useEverything(s);
    assert.ok(answers.some((a) => /did not answer|could not|Try again/i.test(a.content[0].text)), "no tool said GitHub could not be reached");
  } finally {
    await s.stop();
  }
  assert.equal(e.requests.length, 0, e.requests.map((r) => r.body).join("\n"));
  await control(e, env);
});

test("never reported: a proxy that refuses, and a proxy that is not there", async () => {
  const e = await endpoint();
  const gh = await startFakeGitHub({ token: TOKEN });
  cleanups.push(() => gh.close());
  const proxy = await startFakeProxy({ refuse: 403 });
  cleanups.push(() => proxy.close());
  for (const HTTPS_PROXY of [proxy.url(), "http://127.0.0.1:9"]) {
    const env = machine(e.url, { RUNNERS_IO_GITHUB_API: gh.base, HTTPS_PROXY });
    const s = serve(env);
    try {
      await useEverything(s);
    } finally {
      await s.stop();
    }
    assert.equal(e.requests.length, 0, e.requests.map((r) => r.body).join("\n"));
  }
  assert.ok(proxy.connects.length >= 1, "the proxy was never asked: the case did not run");
  await control(e, machine(e.url));
});

test("never reported: no gh and no login, and a session folder that is not a git repository", async () => {
  const e = await endpoint();
  const env = machine(e.url, { RUNNERS_IO_GITHUB_API: "http://127.0.0.1:9", PATH: "/usr/bin:/bin", RUNNERS_IO_TEST_GITHUB_TOKEN: "" });
  const notARepo = mkdtempSync(join(tmpdir(), "rio-not-a-repo-"));
  cleanups.push(() => rmSync(notARepo, { recursive: true, force: true }));
  for (const more of [{}, { CLAUDE_PROJECT_DIR: notARepo }, { CLAUDE_PROJECT_DIR: join(notARepo, "gone") }]) {
    const s = serve({ ...env, ...more });
    try {
      await useEverything(s);
    } finally {
      await s.stop();
    }
  }
  assert.equal(e.requests.length, 0, e.requests.map((r) => r.body).join("\n"));
  await control(e, { ...env, PATH: process.env.PATH });
});

test("never reported: a state folder and an event-log folder that cannot be written", { skip: process.getuid?.() === 0 && "root writes anywhere" }, async () => {
  const e = await endpoint();
  const gh = await startFakeGitHub({ token: TOKEN });
  cleanups.push(() => gh.close());
  gh.setPull("acme/widgets", 7, { head: { ref: "feat", sha: SHA } });
  const env = machine(e.url, { RUNNERS_IO_GITHUB_API: gh.base });
  // The cache and the event log are sent to a file, not a folder: every write there fails as a full or locked disk would.
  const s = serve({ ...env, XDG_CACHE_HOME: bundle, RUNNERS_IO_EVENT_LOG_DIR: bundle });
  try {
    await useEverything(s);
  } finally {
    await s.stop();
  }
  assert.equal(e.requests.length, 0, e.requests.map((r) => r.body).join("\n"));
  await control(e, env);
});

test("never reported: a setting the channel refuses ends it with status 1 and sends nothing", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  for (const RUNNERS_IO_GITHUB_API of ["http://github.example", "not a url", "https://127.0.0.1:1"]) {
    const r = await command({ ...env, RUNNERS_IO_GITHUB_API, RUNNERS_IO_TEST_FAKE_GITHUB: RUNNERS_IO_GITHUB_API.includes("127") ? "" : "1" }, "status");
    assert.equal(r.code, 1, `${RUNNERS_IO_GITHUB_API}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(e.requests.length, 0, e.requests.map((r) => r.body).join("\n"));
  await control(e, env);
});

test("never reported: a session that cannot receive channel events, and the client going away", async () => {
  const e = await endpoint();
  const gh = await startFakeGitHub({ token: TOKEN });
  cleanups.push(() => gh.close());
  // No `ps` on PATH: the launch cannot be read, which the channel says in its log and carries on from.
  const env = machine(e.url, { RUNNERS_IO_GITHUB_API: gh.base });
  const s = serve(env);
  await s.open();
  await s.tool("list_subscriptions", {});
  await s.stop();
  assert.equal(s.state.exit, 0);
  assert.equal(e.requests.length, 0, e.requests.map((r) => r.body).join("\n"));
  await control(e, env);
});

test("with telemetry off the bundle sends nothing, and status says which setting turned it off", async () => {
  const e = await endpoint();
  const gh = await startFakeGitHub({ token: TOKEN });
  cleanups.push(() => gh.close());
  for (const [name, value] of [["RUNNERS_IO_TELEMETRY", "off"], ["DO_NOT_TRACK", "1"], ["DISABLE_TELEMETRY", "1"], ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"]]) {
    const env = machine(e.url, { RUNNERS_IO_GITHUB_API: gh.base, [name]: value });
    const test = await command(env, "telemetry-test");
    assert.match(test.stdout, new RegExp(`^telemetry: off \\(${name}`), test.stdout);
    assert.match(test.stdout, /test report: off\n$/);
    const status = await command(env, "status");
    assert.match(status.stdout, new RegExp(`\\ntelemetry: off \\(${name}[^\\n]*\\): nothing is sent to runners\\.io\\n`), status.stdout);
  }
  assert.equal(e.requests.length, 0);
  const on = machine(e.url, { RUNNERS_IO_GITHUB_API: gh.base });
  assert.match((await command(on, "status")).stdout, /\ntelemetry: on \(/);
  await control(e, on);
});

// ---- behind a company proxy --------------------------------------------------------------------------------------------

test("behind a company proxy the channel sends the install ping through the proxy, once, and the hook leaves it to the channel", async () => {
  // The proxy refuses every CONNECT, so nothing passes it: what is checked is what the proxy was asked to reach. The
  // address is the tests' own listener throughout; the real one is never named here.
  const e = await endpoint();
  const proxy = await startFakeProxy({ refuse: 403 });
  cleanups.push(() => proxy.close());
  const env = machine(e.url, { RUNNERS_IO_GITHUB_API: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1:9", HTTPS_PROXY: proxy.url("ada:proxy-secret") });
  const listener = new URL(e.url).host;
  const asked = () => proxy.connects.filter((c) => c.authority === listener);
  for (let launch = 0; launch < 3; launch++) {
    const s = serve(env);
    await s.open();
    await s.until("the ping's CONNECT", () => asked().length >= 1, 5000);
    // Long enough for a second ping to have been asked for, had one been started.
    await new Promise((r) => setTimeout(r, 300));
    await s.stop();
  }
  assert.equal(asked().length, 1, "one ping, at the first launch only");
  assert.deepEqual(proxy.connects.map((c) => c.authority), [listener], "the proxy was asked for another address");
  assert.equal(e.requests.length, 0, "the message went round the proxy");
  assert.equal(proxy.requests.length, 0, "the message was handed to the proxy in the clear");
  assert.equal(proxy.sent().includes("install_id"), false, "the proxy could read the message");
  // Without a proxy the channel leaves the ping to the launch hook: a session's start sends none from here.
  const plain = machine(e.url, { RUNNERS_IO_GITHUB_API: "http://127.0.0.1:9" });
  const s = serve(plain);
  await s.open();
  await new Promise((r) => setTimeout(r, 300));
  await s.stop();
  assert.equal(e.requests.length, 0, "the channel pinged where the hook does");
});
