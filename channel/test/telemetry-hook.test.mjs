// The SessionStart hook's install ping, run as Claude Code runs the hook: a process of its own that reads the start on
// stdin. Every send goes to a listener on 127.0.0.1 that this file starts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFakeEndpoint } from "./fake-endpoint.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "session-start.mjs");
const SID = "3f2a9c1e-0b7d-4c55-9a51-6c8e2f0d4b11";
const start = (source = "startup") => JSON.stringify({ hook_event_name: "SessionStart", session_id: SID, source, cwd: tmpdir() });

const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function endpoint(opts) {
  const e = await startFakeEndpoint(opts);
  cleanups.push(() => e.close());
  return e;
}

/** A machine of its own: a home, a state and a cache folder, and nothing of this user's. */
function machine(url, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "rio-hook-telemetry-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    GH_CONFIG_DIR: join(home, "gh"),
    RUNNERS_IO_NO_CLAUDE_GH_OFFER: "1",
    ...(url ? { RUNNERS_IO_TEST_TELEMETRY_URL: url } : {}),
    ...extra,
  };
}

/** Runs the hook to its end. Asynchronously: the listener lives in this process and must be free to answer. */
function run(env, stdin = start()) {
  return new Promise((resolve) => {
    const began = Date.now();
    // The hook's own limit is 10 seconds (hooks.json); past it the hook is killed here as Claude Code would kill it.
    const child = spawn(process.execPath, [HOOK], { env, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.once("exit", (code) => resolve({ code, stdout, stderr, took: Date.now() - began }));
    child.stdin.end(stdin);
  });
}

test("the first launch after an install sends one install ping, and no later launch sends another", async () => {
  const e = await endpoint();
  const env = machine(e.url);
  const first = await run(env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(e.requests.length, 1, `the control: the listener counts a ping. stderr: ${first.stderr}`);
  const [m] = e.messages();
  assert.deepEqual(Object.keys(m).sort(), ["install_id", "kind", "node_major", "os", "version"]);
  assert.equal(m.kind, "install");
  assert.match(m.version, /^\d+\.\d+\.\d+$/, "the version the plugin's manifest names");
  for (const source of ["startup", "resume", "fork", "startup"]) assert.equal((await run(env, start(source))).code, 0);
  assert.equal(e.requests.length, 1, "a ping at every launch");
});

test("no ping after /clear or /compact, for input that is not a start, or with telemetry turned off", async () => {
  const e = await endpoint();
  for (const stdin of [start("clear"), start("compact"), "not json", ""]) assert.equal((await run(machine(e.url), stdin)).code, 0);
  for (const off of [{ RUNNERS_IO_TELEMETRY: "off" }, { DO_NOT_TRACK: "1" }, { DISABLE_TELEMETRY: "1" }, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }]) {
    assert.equal((await run(machine(e.url, off))).code, 0);
  }
  assert.equal(e.requests.length, 0);
  // The control, on the same listener: a plain launch does send.
  await run(machine(e.url));
  assert.equal(e.requests.length, 1);
});

test("behind a company proxy the hook cannot go through, the hook sends nothing: the channel sends the ping", async () => {
  const e = await endpoint();
  const env = machine(e.url, { HTTPS_PROXY: "http://127.0.0.1:9" });
  assert.equal((await run(env)).code, 0);
  assert.equal(e.requests.length, 0);
});

test("an endpoint that never answers holds the hook for the send's 2 seconds at most, and it still answers and ends with status 0", async () => {
  const e = await endpoint({ hang: true });
  const env = machine(e.url);
  const r = await run(env);
  assert.equal(r.code, 0, r.stderr);
  if (r.stdout.trim()) assert.doesNotThrow(() => JSON.parse(r.stdout));
  assert.equal(e.requests.length, 1, "the ping was started");
  // The hook's own limit is 10 seconds (hooks.json). The send has 2; the rest is Node starting and the checks, which
  // the next launch below pays too, with no send: the difference between the two is what the ping cost.
  assert.ok(r.took < 9000, `the hook took ${r.took} ms, close to its 10-second limit`);
  // The next launch does not wait again: a ping that got no answer is not sent a second time.
  const again = await run(env);
  assert.equal(e.requests.length, 1);
  assert.ok(r.took - again.took < 3500, `the unanswered ping cost ${r.took - again.took} ms, more than its 2-second limit and some slack`);
});

test("with an endpoint that answers, the hook ends at once: nothing it started keeps it alive", async () => {
  const e = await endpoint();
  const r = await run(machine(e.url));
  assert.equal(r.code, 0);
  assert.equal(e.requests.length, 1);
  // Well inside the send's 2-second limit on top of what the hook takes anyway: it did not wait for a timer.
  assert.ok(r.took < 7000, `the hook took ${r.took} ms`);
});
