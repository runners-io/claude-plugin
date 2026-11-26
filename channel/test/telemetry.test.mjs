// The two messages the plugin sends to runners.io (hooks/telemetry.mjs): what each holds and never holds, which
// failures are never sent, how often, how it is turned off, and that a send can neither be repointed nor slow anything.
//
// Nothing here reaches the real endpoint: every send goes to a listener on 127.0.0.1 that this file starts, and the
// tests that name the real address only compare strings.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GONE_FOR_MS,
  INTERNAL_CODES,
  MAX_BODY_BYTES,
  MAX_REPORTS_PER_DAY,
  PLUGIN_ROOT,
  TELEMETRY_URL,
  createTelemetry,
  denied,
  errorReport,
  frameLines,
  installPing,
  needsTunnel,
  runHook,
  telemetryEndpoint,
  telemetryLine,
  telemetrySwitch,
} from "../../hooks/telemetry.mjs";
import { startFakeEndpoint } from "./fake-endpoint.mjs";
import { brokenLookup, caught, deepFault, faults } from "./faulty.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = "0.4.0";
const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);

const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function endpoint(opts) {
  const e = await startFakeEndpoint(opts);
  cleanups.push(() => e.close());
  return e;
}

/** A machine's environment with a state folder of its own, sending to `url` (a fake endpoint's) when one is given. */
function machine(url, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "rio-telemetry-"));
  cleanups.push(() => {
    try {
      chmodSync(join(home, "state", "runners-io"), 0o700);
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });
  return { HOME: home, XDG_STATE_HOME: join(home, "state"), ...(url ? { RUNNERS_IO_TEST_TELEMETRY_URL: url } : {}), ...extra };
}

const sender = (env, more = {}) => createTelemetry({ component: "channel", version: VERSION, env, now: () => T0, ...more });

const PING_FIELDS = ["install_id", "kind", "node_major", "os", "version"];
const ERROR_FIELDS = ["component", "error_name", "fingerprint", "frames", "install_id", "kind", "node_major", "os", "version"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAME = /^(<external>|[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79} [a-z0-9][a-z0-9.-]{0,59}\.mjs:[1-9][0-9]{0,6}:[1-9][0-9]{0,5})$/;

// ---- the address -----------------------------------------------------------------------------------------------------

test("the address is www.runners.io's telemetry path and nothing in the environment can repoint it off this machine", () => {
  assert.equal(TELEMETRY_URL, "https://www.runners.io/api/plugin/telemetry");
  assert.equal(telemetryEndpoint({}), TELEMETRY_URL);
  assert.equal(telemetryEndpoint({ RUNNERS_IO_TEST_TELEMETRY_URL: "http://127.0.0.1:4010/x" }), "http://127.0.0.1:4010/x");
  for (const elsewhere of [
    "https://evil.example/api/plugin/telemetry",
    "http://evil.example/",
    "https://127.0.0.1:4010/x",
    "http://localhost:4010/x",
    "http://127.0.0.1.evil.example/x",
    "http://user:pass@127.0.0.1:4010/x",
    "http://[::1]:4010/x",
    "http://0.0.0.0:4010/x",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(telemetryEndpoint({ RUNNERS_IO_TEST_TELEMETRY_URL: elsewhere }), null, `${elsewhere} is sent to`);
    assert.equal(telemetrySwitch({ RUNNERS_IO_TEST_TELEMETRY_URL: elsewhere }).on, false, elsewhere);
  }
});

test("under the plugin's own tests nothing is sent unless a test names its own listener", () => {
  assert.equal(telemetryEndpoint({ NODE_TEST_CONTEXT: "child-v8" }), null);
  assert.equal(telemetryEndpoint({ RUNNERS_IO_TEST_FAKE_GITHUB: "1" }), null);
  assert.equal(telemetryEndpoint({ NODE_TEST_CONTEXT: "child-v8", RUNNERS_IO_TEST_TELEMETRY_URL: "http://127.0.0.1:9/x" }), "http://127.0.0.1:9/x");
  // This very process is one: whatever a test forgets, the real address is not reachable from here.
  assert.equal(telemetryEndpoint(process.env), null, "this test run could send to the real endpoint");
});

// ---- the install ping ------------------------------------------------------------------------------------------------

test("the install ping is sent once: exactly its fields, to the endpoint as JSON, and not again at the next launch", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  assert.equal(await sender(env).ping(), "sent");
  assert.equal(e.requests.length, 1, "the control: the listener counts what it is sent");
  const [r] = e.requests;
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/plugin/telemetry");
  assert.equal(r.headers["content-type"], "application/json");
  assert.ok(Buffer.byteLength(r.body) < MAX_BODY_BYTES);
  const m = JSON.parse(r.body);
  assert.deepEqual(Object.keys(m).sort(), PING_FIELDS);
  assert.equal(m.kind, "install");
  assert.match(m.install_id, UUID_V4);
  assert.equal(m.version, VERSION);
  assert.equal(m.os, process.platform);
  assert.equal(m.node_major, Number(process.versions.node.split(".")[0]));

  // The next launches: a new process each, the same machine.
  assert.equal(await sender(env).ping(), "already");
  assert.equal(await sender(env, { now: () => T0 + 40 * DAY }).ping(), "already");
  assert.equal(e.requests.length, 1, "a ping at every launch");
});

test("two sessions started together send one ping between them", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const words = await Promise.all([sender(env).ping(), sender(env).ping(), sender(env).ping()]);
  assert.deepEqual(words.sort(), ["already", "already", "sent"]);
  assert.equal(e.requests.length, 1);
});

test("a new version pings once more, as an update naming the version it replaced, with the same install id", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  await sender(env).ping();
  assert.equal(await sender(env, { version: "0.4.1" }).ping(), "sent");
  assert.equal(await sender(env, { version: "0.4.1" }).ping(), "already");
  const [first, second] = e.messages();
  assert.equal(e.requests.length, 2);
  assert.deepEqual(Object.keys(second).sort(), [...PING_FIELDS, "previous_version"].sort());
  assert.equal(second.kind, "update");
  assert.equal(second.version, "0.4.1");
  assert.equal(second.previous_version, "0.4.0");
  assert.equal(second.install_id, first.install_id, "the install id is made once");
});

test("a machine that had the plugin before it sent anything says update, with no version to name", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const state = join(env.XDG_STATE_HOME, "runners-io");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "setup.json"), "{}");
  const lastWeek = new Date(T0 - 7 * DAY);
  utimesSync(join(state, "setup.json"), lastWeek, lastWeek);
  assert.equal(await sender(env).ping(), "sent");
  const [m] = e.messages();
  assert.equal(m.kind, "update");
  assert.equal("previous_version" in m, false);
});

test("where the state folder cannot be written nothing is sent, rather than something at every launch", { skip: process.getuid?.() === 0 && "root writes anywhere" }, async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const state = join(env.XDG_STATE_HOME, "runners-io");
  mkdirSync(state, { recursive: true });
  chmodSync(state, 0o500);
  for (let launch = 0; launch < 3; launch++) {
    assert.equal(await sender(env).ping(), "no_state");
    assert.equal(await sender(env).report(caught(() => brokenLookup())), "no_state");
  }
  assert.equal(e.requests.length, 0);
});

// ---- a report of the plugin's own fault ------------------------------------------------------------------------------

test("a fault of the plugin's own is sent once: exactly its fields, with frames that name the plugin's files by base name", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  assert.equal(await sender(env).report(caught(() => brokenLookup()), { component: "tool:ci_status" }), "sent");
  assert.equal(e.requests.length, 1, "the control: a real fault is counted by the listener");
  assert.ok(Buffer.byteLength(e.requests[0].body) < MAX_BODY_BYTES);
  const [m] = e.messages();
  assert.deepEqual(Object.keys(m).sort(), ERROR_FIELDS);
  assert.equal(m.kind, "error");
  assert.match(m.install_id, UUID_V4);
  assert.equal(m.component, "tool:ci_status");
  assert.equal(m.error_name, "TypeError");
  assert.match(m.fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(m.frames.length >= 1 && m.frames.length <= 8);
  for (const f of m.frames) assert.match(f, FRAME);
  assert.match(m.frames[0], /^brokenLookup faulty\.mjs:\d+:\d+$/, "the line that threw, by function and base name");
  assert.ok(m.frames.includes("<external>"), "the test runner's own lines are not named");
});

// Each value below is one a real failure could carry. None may be in what is sent, whole or in part.
test("a report never holds the error's message, a path, a user or machine name, a repository, branch or pull request, a token or an environment value", async () => {
  const e = await endpoint();
  const planted = {
    token: "gho_PLANTEDtoken0123456789abcdef",
    repo: "planted-owner/planted-secret-repo",
    branch: "planted/feature-branch-name",
    pr: "pull request #48151623",
    path: "/Users/planted-user/work/planted-project/src/app.ts",
    login: "planted-github-login",
    envValue: "planted-env-value-9f3c",
  };
  const env = machine(e.url, {
    GH_TOKEN: planted.token,
    PLANTED_SECRET: planted.envValue,
    CLAUDE_PROJECT_DIR: "/Users/planted-user/work/planted-project",
    USER: "planted-user",
    HTTPS_PROXY_NOTE: planted.envValue,
  });
  const error = caught(() => brokenLookup(Object.values(planted).join(" ")));
  error.path = planted.path;
  error.repo = planted.repo;
  assert.equal(await sender(env).report(error), "sent");
  assert.equal(await sender(env).ping(), "sent");
  assert.equal(e.requests.length, 2, "the control: both messages were sent, so what follows read something");
  for (const r of e.requests) {
    const sent = `${r.body}\n${JSON.stringify(r.headers)}\n${r.path}`;
    for (const [what, value] of Object.entries(planted)) assert.equal(sent.includes(value), false, `the ${what} is in what was sent: ${sent}`);
    for (const word of ["planted", "Cannot read", "48151623", "/Users/", "\\\\Users\\\\"]) assert.equal(sent.includes(word), false, `"${word}" is in what was sent: ${sent}`);
    // This machine's own: the home folder, the user, the machine's name, the folders this runs in, the plugin's folder.
    for (const [what, value] of [
      ["home folder", homedir()],
      ["user name", userInfo().username],
      ["machine name", hostname()],
      ["working folder", process.cwd()],
      ["plugin folder", ROOT],
      ["state folder", env.XDG_STATE_HOME],
      ["temporary folder", tmpdir()],
    ]) {
      if (value.length >= 3) assert.equal(sent.includes(value), false, `the ${what} (${value}) is in what was sent: ${sent}`);
    }
    assert.equal(/authorization|cookie/i.test(JSON.stringify(Object.keys(r.headers))), false, "a credential header was sent");
  }
});

test("a deep stack is cut to 8 lines and the message stays under 1 KB", async () => {
  const e = await endpoint();
  assert.equal(await sender(machine(e.url)).report(caught(() => deepFault(40))), "sent");
  const [m] = e.messages();
  assert.equal(m.frames.length, 8);
  assert.equal(m.error_name, "RangeError");
  assert.ok(Buffer.byteLength(e.requests[0].body) < MAX_BODY_BYTES);
});

test("a line of the message that looks like a stack line is not sent as one", () => {
  const error = caught(() => brokenLookup(`\n    at plantedRepoName (file://${ROOT}/hooks/planted.mjs:1:1)`));
  const frames = frameLines(error, ROOT);
  assert.equal(frames.some((f) => f.includes("planted")), false, frames.join(" | "));
  assert.match(frames[0], /^brokenLookup faulty\.mjs:/);
});

test("a failure whose stack never passes through the plugin's own files is not sent", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const foreign = new TypeError("thrown by something else");
  foreign.stack = "TypeError: thrown by something else\n    at parse (node:internal/deps/undici/undici:1:1)\n    at /opt/elsewhere/lib/index.mjs:10:3";
  assert.equal(await sender(env).report(foreign), "denied");
  assert.equal(await sender(env).report("a string was thrown"), "denied");
  assert.equal(await sender(env).report(undefined), "denied");
  // A file with the plugin's name in another folder is not the plugin's.
  const lookalike = new TypeError("x");
  lookalike.stack = "TypeError: x\n    at f (file:///tmp/other/hooks/telemetry.mjs:1:1)";
  assert.equal(await sender(env).report(lookalike), "denied");
  assert.equal(e.requests.length, 0);
});

// ---- never reported: GitHub, the network, git, gh, the file system, a wrong setting, the channel's own notices -----------

/** A failure as its source throws it, on a stack that DOES pass through the plugin's files: only the deny-list stops it. */
function failure(shape) {
  const error = caught(() => brokenLookup());
  if (shape.name) error.name = shape.name;
  if (shape.message !== undefined) error.message = shape.message;
  for (const [k, v] of Object.entries(shape.props ?? {})) error[k] = v;
  return error;
}
const code = (c, more = {}) => ({ props: { code: c, ...more } });
const fetchFailed = (c) => ({ name: "TypeError", message: "fetch failed", props: { cause: Object.assign(new Error("connect failed"), { code: c }) } });

const NOT_REPORTED = {
  // GitHub answered with a status.
  "GitHub 401": { name: "HttpError", props: { status: 401 } },
  "GitHub 403": { props: { status: 403 } },
  "GitHub 404": { props: { status: 404 } },
  "GitHub 422": { props: { statusCode: 422 } },
  "GitHub 500": { props: { status: 500 } },
  "GitHub 502": { props: { status: 502 } },
  "GitHub 503": { name: "RequestError", props: { status: 503 } },
  "GitHub rate limit": { props: { status: 403, code: "rate_limited" } },
  "GitHub secondary rate limit": { props: { status: 429 } },
  "GitHub SSO": { props: { status: 403, code: "sso" } },
  "GitHub GraphQL": { name: "GraphqlResponseError" },
  "a handled answer: auth": code("auth"),
  "a handled answer: retry": code("retry"),
  "a handled answer: not_found": code("not_found"),
  // The network.
  "DNS": fetchFailed("ENOTFOUND"),
  "DNS, temporary": fetchFailed("EAI_AGAIN"),
  "connection refused": fetchFailed("ECONNREFUSED"),
  "connection reset": fetchFailed("ECONNRESET"),
  "timed out": fetchFailed("ETIMEDOUT"),
  "fetch failed with no reason": { name: "TypeError", message: "fetch failed" },
  "undici connect timeout": fetchFailed("UND_ERR_CONNECT_TIMEOUT"),
  "undici socket": { name: "SocketError", props: { code: "UND_ERR_SOCKET" } },
  "aborted": { name: "AbortError" },
  "request timed out": { name: "TimeoutError" },
  "TLS: expired certificate": fetchFailed("CERT_HAS_EXPIRED"),
  "TLS: unknown issuer": fetchFailed("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
  "TLS: self-signed": fetchFailed("SELF_SIGNED_CERT_IN_CHAIN"),
  "TLS: wrong name": code("ERR_TLS_CERT_ALTNAME_INVALID"),
  "TLS: protocol": code("EPROTO"),
  "proxy refused": code("ERR_PROXY_TUNNEL"),
  "proxy closed the socket": code("ECONNRESET", { syscall: "read", errno: -54 }),
  "pipe closed": code("EPIPE", { syscall: "write" }),
  // git, gh and the file system on this machine.
  "gh is not installed": code("ENOENT", { syscall: "spawn gh", path: "gh", spawnargs: ["auth", "token"] }),
  "git is not installed": code("ENOENT", { syscall: "spawn git", spawnargs: ["rev-parse"] }),
  "gh is not signed in (exit 1)": { props: { code: 1, cmd: "gh auth token", killed: false, signal: null } },
  "git failed (exit 128)": { props: { code: 128, cmd: "git rev-parse --abbrev-ref HEAD", killed: false } },
  "a program was killed": { props: { killed: true, signal: "SIGTERM", cmd: "git status" } },
  "an unreadable config": code("EACCES", { syscall: "open", errno: -13 }),
  "a missing file": code("ENOENT", { syscall: "open", errno: -2 }),
  "a full disk": code("ENOSPC", { syscall: "write", errno: -28 }),
  "a read-only disk": code("EROFS"),
  "no permission": code("EPERM"),
  "too many open files": code("EMFILE"),
  "an errno that is not listed": code("ENOTEMPTY"),
  // A setting the user gave.
  "a setting the plugin refuses, a folder that is not the user's, a proxy that refuses": { name: "MachineError" },
};

for (const [what, shape] of Object.entries(NOT_REPORTED)) {
  test(`never reported: ${what}`, async () => {
    const e = await endpoint();
    const env = machine(e.url);
    const t = sender(env);
    const error = failure(shape);
    assert.equal(denied(error), true);
    assert.equal(await t.report(error), "denied");
    // Thrown again by the plugin's own code with this one as its cause, it is still not the plugin's fault.
    assert.equal(await t.report(Object.assign(caught(() => brokenLookup()), { cause: error })), "denied");
    assert.equal(e.requests.length, 0, `${what} was sent: ${e.requests.map((r) => r.body).join("\n")}`);
    assert.throws(() => readdirSync(join(env.XDG_STATE_HOME, "runners-io")), /ENOENT/, "a failure that is never sent made a file, or used up one of the day's reports");
    // The control, on the same listener and the same machine: the same stack with nothing denied about it IS sent.
    assert.equal(await t.report(caught(() => brokenLookup())), "sent");
    assert.equal(e.requests.length, 1, "the listener would have counted it");
  });
}

test("never reported: the channel's own notices and anything that is not one of the plugin's consistency checks", async () => {
  const e = await endpoint();
  const t = sender(machine(e.url));
  for (const notice of ["channel_inactive", "channel_throttled", "channel_held_back", "channel_scope_capped", "channel_scope_not_visible", "problem", "auth", "retry", "not_found", "enoent", "http_500", "made_up_code"]) {
    assert.equal(await t.internalError(notice), "denied", notice);
  }
  // Even if a check's code were ever named like a notice, the code is refused where the message is built.
  assert.equal(errorReport(caught(() => brokenLookup()), { installId: "3f2a9c1e-0b7d-4c55-9a51-6c8e2f0d4b11", version: VERSION, component: "channel", code: "channel_inactive", root: ROOT }), null);
  assert.equal(e.requests.length, 0);
  // The control: a real check's code is sent, with the code and the check's own line first.
  const sent = (() => t.internalError(INTERNAL_CODES[0]))();
  assert.equal(await sent, "sent");
  const [m] = e.messages();
  assert.deepEqual(Object.keys(m).sort(), [...ERROR_FIELDS, "code"].sort());
  assert.equal(m.code, INTERNAL_CODES[0]);
  assert.equal(m.error_name, "InternalError");
  assert.match(m.frames[0], / telemetry\.test\.mjs:\d+:\d+$/, "the stack starts at the check, not inside the sender");
});

/** One fault, thrown from one place: the same fault every time it is called. */
function fault0() {
  return caught(faults[0]);
}

// ---- how often -------------------------------------------------------------------------------------------------------

test("one fault is reported once per version per day, by every session of the install together", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const fault = fault0;
  assert.equal(await sender(env).report(fault()), "sent");
  assert.equal(await sender(env).report(fault()), "duplicate");
  assert.equal(await sender(env, { now: () => T0 + 60 * 60_000 }).report(fault()), "duplicate", "another session, an hour on");
  assert.equal(e.requests.length, 1);
  assert.equal(await sender(env, { version: "0.4.1" }).report(fault()), "sent", "the same fault in a new version");
  assert.equal(await sender(env, { now: () => T0 + DAY }).report(fault()), "sent", "the same fault the next day");
  assert.equal(e.requests.length, 3);
});

test(`at most ${MAX_REPORTS_PER_DAY} reports a day from one install, whatever fails, and again the next day`, async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const words = [];
  // Eight different faults, from two sessions in turn.
  for (let i = 0; i < 8; i++) words.push(await sender(env).report(caught(faults[i])));
  assert.deepEqual(words, ["sent", "sent", "sent", "sent", "sent", "capped", "capped", "capped"]);
  assert.equal(e.requests.length, 5);
  assert.equal(new Set(e.messages().map((m) => m.fingerprint)).size, 5, "five different faults");
  // At once, from many sessions: still five.
  const e2 = await endpoint();
  const env2 = machine(e2.url);
  await Promise.all(faults.map((f) => sender(env2).report(caught(f))));
  assert.equal(e2.requests.length, 5);
  // The next UTC day has five of its own.
  assert.equal(await sender(env, { now: () => T0 + DAY }).report(caught(faults[6])), "sent");
  assert.equal(e.requests.length, 6);
});

// ---- turning it off --------------------------------------------------------------------------------------------------

const OPT_OUTS = {
  "RUNNERS_IO_TELEMETRY=off": { RUNNERS_IO_TELEMETRY: "off" },
  "RUNNERS_IO_TELEMETRY=OFF": { RUNNERS_IO_TELEMETRY: "OFF" },
  "RUNNERS_IO_TELEMETRY=0": { RUNNERS_IO_TELEMETRY: "0" },
  "RUNNERS_IO_TELEMETRY=false": { RUNNERS_IO_TELEMETRY: "false" },
  "DO_NOT_TRACK=1": { DO_NOT_TRACK: "1" },
  "DO_NOT_TRACK=true": { DO_NOT_TRACK: "true" },
  "DISABLE_TELEMETRY=1": { DISABLE_TELEMETRY: "1" },
  "DISABLE_TELEMETRY=true": { DISABLE_TELEMETRY: "true" },
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1": { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=yes": { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "yes" },
  // The plugin's own telemetry setting (plugin.json userConfig), as Claude Code hands a saved one to a hook and, through
  // the manifest's env, to the channel.
  "the plugin's telemetry setting, off": { CLAUDE_PLUGIN_OPTION_TELEMETRY: "off" },
  "the plugin's telemetry setting, OFF": { CLAUDE_PLUGIN_OPTION_TELEMETRY: " OFF " },
};

for (const [what, setting] of Object.entries(OPT_OUTS)) {
  test(`${what}: nothing is sent, no install id is made, and status says which setting turned it off`, async () => {
    const e = await endpoint();
    const env = machine(e.url, setting);
    const t = sender(env);
    assert.equal(await t.ping(), "off");
    assert.equal(await t.report(caught(() => brokenLookup())), "off");
    assert.equal(await t.internalError(INTERNAL_CODES[0]), "off");
    assert.equal(e.requests.length, 0);
    assert.throws(() => readdirSync(join(env.XDG_STATE_HOME, "runners-io")), /ENOENT/, "a file was made with telemetry off");
    const line = telemetryLine(env);
    assert.match(line, /^telemetry: off \(/);
    assert.ok(line.includes(Object.keys(setting)[0]), line);
    // The control: without the setting the same machine sends.
    const { [Object.keys(setting)[0]]: _, ...on } = env;
    assert.equal(await sender(on).ping(), "sent");
    assert.equal(e.requests.length, 1);
  });
}

test("a variable that is set to nothing, 0 or false does not turn it off, and status then says it is on, never the install id", async () => {
  const e = await endpoint();
  const env = machine(e.url, { DO_NOT_TRACK: "0", DISABLE_TELEMETRY: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "false", RUNNERS_IO_TELEMETRY: "on", CLAUDE_PLUGIN_OPTION_TELEMETRY: "on" });
  assert.deepEqual(telemetrySwitch(env), { on: true });
  assert.equal(await sender(env).ping(), "sent");
  const line = telemetryLine(env);
  assert.match(line, /^telemetry: on /);
  assert.match(line, /RUNNERS_IO_TELEMETRY=off/);
  assert.match(line, /the plugin's telemetry setting/, "the on line names the setting that turns it off");
  assert.equal(line.includes(e.messages()[0].install_id), false);
});

test("the plugin's telemetry setting: only a saved off turns it off, and status says the setting did", () => {
  assert.deepEqual(telemetrySwitch({ CLAUDE_PLUGIN_OPTION_TELEMETRY: "off" }), { on: false, why: "the plugin's telemetry setting is off (CLAUDE_PLUGIN_OPTION_TELEMETRY=off)" });
  assert.match(telemetryLine({ CLAUDE_PLUGIN_OPTION_TELEMETRY: "off" }), /^telemetry: off \(the plugin's telemetry setting is off/);
  // A setting nobody saved reaches a hook as no variable at all, and a skill as the reference itself, unreplaced: both
  // are the default, on. So is anything that is not the word off.
  for (const value of [undefined, "", "on", "${user_config.telemetry}", "offf", "0"]) {
    assert.equal(telemetrySwitch({ CLAUDE_PLUGIN_OPTION_TELEMETRY: value }).on, true, String(value));
  }
  // An environment variable that says off wins over a setting that says on, and is the one named.
  assert.equal(telemetrySwitch({ CLAUDE_PLUGIN_OPTION_TELEMETRY: "on", DO_NOT_TRACK: "1" }).why, "DO_NOT_TRACK is set");
});

test("with a proxy named that the plugin cannot use, status says telemetry is on but that nothing is sent, and why", async () => {
  const e = await endpoint();
  const env = machine(e.url, { HTTPS_PROXY: "socks5://proxy.example:1080" });
  assert.equal(await sender(env).ping(), "blocked");
  assert.equal(e.requests.length, 0);
  const line = telemetryLine(env);
  assert.match(line, /^telemetry: on, but nothing is sent while HTTPS_PROXY names a proxy the plugin cannot use/);
  assert.equal(line.includes("socks5"), false, "the variable's value is never shown");
  // The control: with no such proxy the line is the plain one.
  assert.match(telemetryLine(machine(e.url)), /^telemetry: on \(/);
});

// ---- the endpoint's answers ------------------------------------------------------------------------------------------

test("410 Gone: nothing more is sent from this version for 7 days, and its ping is never sent a second time", async () => {
  const e = await endpoint({ answer: 410 });
  const env = machine(e.url);
  assert.equal(await sender(env).ping(), "gone");
  assert.equal(e.requests.length, 1);
  for (const at of [T0, T0 + DAY, T0 + GONE_FOR_MS - 1000]) {
    assert.equal(await sender(env, { now: () => at }).ping(), "gone");
    assert.equal(await sender(env, { now: () => at }).report(caught(() => brokenLookup())), "gone");
  }
  assert.equal(e.requests.length, 1, "something was sent inside the 7 days");
  // Another version was not told to stop.
  e.state.answer = 204;
  assert.equal(await sender(env, { version: "0.4.1" }).report(caught(faults[1])), "sent");
  assert.equal(e.requests.length, 2);
  // After the 7 days this version reports its faults again. Its ping was sent once and is not sent again: "it tells
  // us once" holds whatever the answer was.
  const later = { now: () => T0 + GONE_FOR_MS + 1000 };
  assert.equal(await sender(env, later).ping(), "already");
  assert.equal(e.requests.length, 2);
  assert.equal(await sender(env, later).report(caught(() => brokenLookup())), "sent");
  assert.equal(e.requests.length, 3);
  assert.equal(e.messages()[2].version, VERSION);
});

test("410 Gone to a fault report stops the version too", async () => {
  const e = await endpoint({ answer: 410 });
  const env = machine(e.url);
  assert.equal(await sender(env).report(caught(faults[0])), "gone");
  assert.equal(await sender(env).report(caught(faults[1])), "gone");
  assert.equal(await sender(env).ping(), "gone");
  assert.equal(e.requests.length, 1);
});

for (const status of [429, 500, 400, 204]) {
  test(`an answer of ${status} is taken without a word and the message is never sent again`, async () => {
    const e = await endpoint({ answer: status });
    const env = machine(e.url);
    const word = status === 429 ? "limited" : "sent";
    assert.equal(await sender(env).ping(), word);
    assert.equal(await sender(env).report(fault0()), word);
    assert.equal(await sender(env).ping(), "already");
    assert.equal(await sender(env).report(fault0()), "duplicate");
    assert.equal(e.requests.length, 2);
  });
}

test("a redirect is not followed: a message goes to the one address or nowhere", async () => {
  const elsewhere = await endpoint();
  const e = await endpoint({ redirectTo: elsewhere.url });
  assert.equal(await sender(machine(e.url)).ping(), "failed");
  assert.equal(e.requests.length, 1);
  assert.equal(elsewhere.requests.length, 0);
});

// ---- it never slows or breaks anything -------------------------------------------------------------------------------

test("an endpoint that never answers costs 2 seconds at most, once, and nothing is left running", async () => {
  const e = await endpoint({ hang: true });
  const env = machine(e.url);
  const t = sender(env);
  const began = Date.now();
  const pinged = t.ping();
  const reported = t.report(caught(() => brokenLookup()));
  await t.settle();
  const took = Date.now() - began;
  assert.equal(await pinged, "failed");
  assert.equal(await reported, "failed");
  // Never before the limit; and soon after it (the slack is for a loaded machine, not for a second try).
  assert.ok(took >= 1900 && took < 4500, `settled after ${took} ms`);
  assert.equal(e.requests.length, 2, "one request each, never a second try");
  assert.equal(await sender(env).ping(), "already", "a ping that failed is not sent again");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(e.requests.length, 2);
});

test("an endpoint nothing listens on, and a fetch that throws, are dropped without a throw", async () => {
  const env = machine("http://127.0.0.1:9/api/plugin/telemetry");
  assert.equal(await sender(env).ping(), "failed");
  const throws = () => {
    throw new Error("no network at all");
  };
  assert.equal(await sender(machine("http://127.0.0.1:9/x"), { fetch: throws }).report(caught(() => brokenLookup())), "failed");
});

test("a sender with no usable version, or on a platform the endpoint does not count, sends nothing", async () => {
  const e = await endpoint();
  assert.equal(await sender(machine(e.url), { version: null }).ping(), "off");
  assert.equal(await sender(machine(e.url), { version: "0.4.0-beta" }).ping(), "off");
  assert.equal(await sender(machine(e.url), { platform: "haiku" }).ping(), "off");
  assert.equal(installPing({ installId: "nope", version: VERSION }), null);
  assert.equal(e.requests.length, 0);
});

// ---- a hook that fails -----------------------------------------------------------------------------------------------

/** runHook with the process's exit caught: resolves with the status the hook would have ended with. */
function hook(env, main) {
  return new Promise((done) => {
    void runHook("hook:session-start", main, { version: VERSION, env, exit: done, root: PLUGIN_ROOT });
  });
}

test("a hook that throws reports the fault as its own, then ends with status 0 as it always has", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  assert.equal(await hook(env, async () => brokenLookup("planted-message")), 0);
  assert.equal(e.requests.length, 1);
  const [m] = e.messages();
  assert.equal(m.component, "hook:session-start");
  assert.equal(m.error_name, "TypeError");
  assert.equal(e.requests[0].body.includes("planted-message"), false);
});

test("a hook that fails on the machine's side (a missing program, a full disk) ends with status 0 and reports nothing", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  assert.equal(await hook(env, async () => { throw failure(NOT_REPORTED["gh is not installed"]); }), 0);
  assert.equal(await hook(env, async () => { throw failure(NOT_REPORTED["a full disk"]); }), 0);
  assert.equal(await hook(env, async () => {}), 0, "and one that does not fail");
  assert.equal(e.requests.length, 0);
});

test("a hook is given the sender, and ends only when its ping has gone or run out of time", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  assert.equal(await hook(env, async (telemetry) => void telemetry.ping()), 0);
  assert.equal(e.requests.length, 1, "the hook ended before its ping was sent");
});

// ---- behind a proxy ----------------------------------------------------------------------------------------------------

test("a hook leaves the ping to the channel only where a proxy stands in the way that Node's own fetch does not use", () => {
  assert.equal(needsTunnel({}), false);
  assert.equal(needsTunnel({ HTTPS_PROXY: "http://proxy.corp.example:3128" }), true);
  assert.equal(needsTunnel({ https_proxy: "http://proxy.corp.example:3128", NO_PROXY: "www.runners.io" }), false);
  assert.equal(needsTunnel({ HTTPS_PROXY: "http://proxy.corp.example:3128", no_proxy: ".runners.io" }), false);
  assert.equal(needsTunnel({ HTTPS_PROXY: "socks5://proxy.corp.example:1080" }), false, "a proxy nothing here can use: there is no tunnel to open, and nothing is sent (below)");
});

test("behind a proxy the plugin cannot use, nothing is sent: not the ping, not a fault report, and nothing is counted as sent", async () => {
  const e = await endpoint();
  for (const variable of ["HTTPS_PROXY", "https_proxy"]) {
    const env = machine(e.url, { [variable]: "socks5://ada:s3cr3t@proxy.corp.example:1080" });
    const t = sender(env);
    assert.equal(await t.ping(), "blocked", variable);
    assert.equal(await t.report(caught(() => deepFault(3))), "blocked");
    assert.equal(await t.internalError(INTERNAL_CODES[0]), "blocked");
    assert.equal(e.requests.length, 0, "a request went around the proxy");
    // Nothing was claimed, so once the proxy is one that can be used (here: none), the ping still goes, once.
    const { [variable]: _unusable, ...fixed } = env;
    assert.equal(await sender(fixed).ping(), "sent");
    assert.equal(e.requests.length, 1);
    e.requests.length = 0;
  }
  // A host the no_proxy list names is reached directly, as the user said.
  const named = machine(e.url, { HTTPS_PROXY: "socks5://proxy.corp.example:1080", NO_PROXY: "127.0.0.1" });
  assert.equal(await sender(named).ping(), "sent");
  // ALL_PROXY is not read: it does not stop a message either.
  const all = machine(e.url, { ALL_PROXY: "socks5://proxy.corp.example:1080" });
  assert.equal(await sender(all).ping(), "sent");
});
