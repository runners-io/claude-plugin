// Where the channel raises a report of its own fault: a tool that throws instead of answering (mcp.ts onFault), and
// its own consistency checks (faults.ts internalError). What a report holds, and what is never sent, is
// telemetry.test.mjs; the bundle end to end is telemetry-bundle.test.mjs.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";

import { internalError, setTelemetry } from "../src/faults.ts";
import type { GitScope } from "../src/git.ts";
import { GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { startMcp } from "../src/mcp.ts";
import { type Entry, MAX_SUBSCRIPTIONS, Subscriptions } from "../src/subscriptions.ts";
import { type ToolHost, makeTools } from "../src/tools.ts";
import { INTERNAL_CODES } from "../../hooks/telemetry.mjs";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";
import { brokenLookup } from "./faulty.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  setTelemetry(null);
  for (const f of fakes) await f.close();
});

/** The checks that failed, in order, while `fn` ran. */
async function checksDuring(fn: () => Promise<void>): Promise<string[]> {
  const codes: string[] = [];
  setTelemetry({
    internalError: async (code) => {
      codes.push(code);
      return "sent";
    },
  });
  try {
    await fn();
  } finally {
    setTelemetry(null);
  }
  return codes;
}

// ---- a tool that throws ------------------------------------------------------------------------------------------------

/** An MCP server over two streams, with `host` as its tools: answers one tools/call and says what onFault was told. */
async function callThrough(host: ToolHost, name: string): Promise<{ answer: { content: { text: string }[]; isError: boolean }; faults: { error: unknown; tool: string | null }[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const faults: { error: unknown; tool: string | null }[] = [];
  startMcp({ input, output, name: "runners-io", version: "0.0.0", instructions: "", onReady: () => {}, onClose: () => {}, tools: host, onFault: (error, tool) => faults.push({ error, tool }) });
  const answered = new Promise<string>((resolve) => output.once("data", (d) => resolve(String(d))));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } })}\n`);
  const answer = JSON.parse(await answered).result;
  input.end();
  return { answer, faults };
}

test("a tool that throws instead of answering: the client is still answered, and the fault is handed on with the tool's name", async () => {
  const host: ToolHost = {
    list: () => [],
    call: async () => brokenLookup(),
  };
  const { answer, faults } = await callThrough(host, "ci_status");
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /^the ci_status tool failed: /);
  assert.equal(faults.length, 1);
  assert.equal(faults[0].tool, "ci_status");
  assert.ok(faults[0].error instanceof TypeError);
});

test("a tool that answers with an error of the user's, or of GitHub's, is not a fault", async () => {
  const gh = await startFakeGitHub({ token: "gho_fakeToken123" });
  fakes.push(gh);
  gh.state.failNext.push({ pattern: /./, status: 500, count: 1000 });
  const scope: GitScope = { repo: "acme/widgets", branch: "feat" };
  const tools = makeTools({ subs: new Subscriptions(), gh: new GitHubClient(gh.base, async () => ({ kind: "ok", token: "gho_fakeToken123", source: "gh" })), readScope: async () => scope });
  for (const name of ["ci_status", "subscribe", "no_such_tool"]) {
    const { answer, faults } = await callThrough(tools, name);
    assert.equal(answer.isError, true, name);
    assert.deepEqual(faults, [], name);
  }
});

// ---- the channel's own consistency checks ------------------------------------------------------------------------------

const SHA = "e".repeat(40);

async function session(subs: Subscriptions) {
  const gh = await startFakeGitHub({ token: "gho_fakeToken123" });
  fakes.push(gh);
  for (let pr = 1; pr <= 40; pr++) gh.setPull("acme/widgets", pr, { head: { ref: `b${pr}`, sha: SHA }, mergeable_state: "clean" });
  gh.setRuns("acme/widgets", SHA, [{ id: 31, name: "CI", status: "in_progress" }]);
  const scope: GitScope = { repo: "acme/widgets", branch: "b1" };
  return makeTools({ subs, gh: new GitHubClient(gh.base, async () => ({ kind: "ok", token: "gho_fakeToken123", source: "gh" })), readScope: async () => scope });
}

test("no check fails in a session used as it is meant to be: at the cap, past it by the branch's own watch, and with a scope giving way", async () => {
  const subs = new Subscriptions();
  const tools = await session(subs);
  const codes = await checksDuring(async () => {
    for (let pr = 1; pr <= MAX_SUBSCRIPTIONS; pr++) assert.ok(!(await tools.call("subscribe", { pr })).isError);
    // Full: a new one is refused, and one already watched is answered.
    assert.equal((await tools.call("subscribe", { pr: 30 })).isError, true);
    assert.ok(!(await tools.call("subscribe", { pr: 3 })).isError);
    // The branch's own watch is added whatever the count (poller.ts), so a session can hold one more than the cap.
    subs.add({ repo: "acme/widgets", pr: 31, source: "auto" });
    assert.equal(subs.list().length, MAX_SUBSCRIPTIONS + 1);
    assert.ok(!(await tools.call("subscribe", { pr: 3 })).isError);
    // A scope's oldest gives way to one asked for by name.
    subs.remove("acme/widgets", 20);
    subs.add({ repo: "acme/widgets", pr: 20, source: "scope" });
    assert.ok(!(await tools.call("subscribe", { pr: 32 })).isError);
    assert.equal(subs.list().length, MAX_SUBSCRIPTIONS + 1);
  });
  assert.deepEqual(codes, []);
});

test("a subscribe that leaves the session watching more than it may is reported as the channel's own fault: watch_cap_exceeded", async () => {
  /** The fault: every add is made twice over, under a second number. */
  class Doubling extends Subscriptions {
    override add(input: Parameters<Subscriptions["add"]>[0]): Entry {
      super.add({ ...input, pr: input.pr + 1000 });
      return super.add(input);
    }
  }
  const subs = new Doubling();
  const tools = await session(subs);
  const codes = await checksDuring(async () => {
    for (let pr = 1; pr <= 10; pr++) await tools.call("subscribe", { pr });
    assert.deepEqual(subs.list().length, 20);
    // Room for one by the count before it, and two are added.
    subs.remove("acme/widgets", 1001);
    assert.ok(!(await tools.call("subscribe", { pr: 11 })).isError);
  });
  assert.deepEqual(codes, ["watch_cap_exceeded"]);
});

test("every check the channel can raise is one the sender sends, and a failed check never throws", () => {
  for (const code of ["watch_cap_exceeded", "scope_holdings_negative", "scope_holdings_over_cap"] as const) {
    assert.ok(INTERNAL_CODES.includes(code), code);
    setTelemetry(null);
    assert.doesNotThrow(() => internalError(code));
    setTelemetry({
      internalError: () => {
        throw new Error("the sender itself is broken");
      },
    });
    assert.doesNotThrow(() => internalError(code));
  }
  setTelemetry(null);
});
