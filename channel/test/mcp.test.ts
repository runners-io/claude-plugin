import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { CAPABILITIES, SUPPORTED_PROTOCOLS, capabilities, chooseProtocol, startMcp } from "../src/mcp.ts";
import type { ToolHost } from "../src/tools.ts";

function harness(tools?: ToolHost) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  output.on("data", (d: Buffer) => {
    buf += d.toString();
    let i = buf.indexOf("\n");
    while (i >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });
  let ready = 0;
  const server = startMcp({
    input,
    output,
    name: "runners-io",
    version: "0.0.0-test",
    instructions: "test",
    onReady: () => {
      ready++;
    },
    onClose: () => {},
    tools,
  });
  const send = (m: Record<string, unknown>) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const next = async (n: number) => {
    for (let t = 0; t < 100 && lines.length < n; t++) await new Promise((r) => setTimeout(r, 10));
    return lines[n - 1];
  };
  return { server, send, next, lines, ready: () => ready };
}

test("initialize declares the channel and nothing else: no tools, no permission relay", async () => {
  const h = harness();
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } } });
  const r = (await h.next(1)) as { result: { capabilities: Record<string, unknown>; protocolVersion: string; instructions: string } };
  assert.deepEqual(r.result.capabilities, { experimental: { "claude/channel": {} } });
  assert.deepEqual(CAPABILITIES, r.result.capabilities);
  assert.ok(!("tools" in r.result.capabilities));
  assert.ok(!("claude/channel/permission" in (r.result.capabilities.experimental as object)));
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.equal(r.result.instructions, "test");
});

test("the protocol is pinned below revision 2026-07-28, which cannot carry channel messages", () => {
  assert.equal(chooseProtocol("2026-07-28"), "2025-06-18");
  assert.equal(chooseProtocol("2099-01-01"), "2025-06-18");
  assert.equal(chooseProtocol(undefined), "2025-06-18");
  assert.equal(chooseProtocol("2024-11-05"), "2024-11-05");
  assert.ok(!(SUPPORTED_PROTOCOLS as readonly string[]).includes("2026-07-28"));
});

test("a notification is refused before the client is initialized, and sent after", async () => {
  const h = harness();
  await assert.rejects(h.server.notify({ content: "x", meta: {} }), /not finished initializing/);
  h.send({ method: "notifications/initialized" });
  for (let t = 0; t < 50 && h.ready() === 0; t++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.ready(), 1);
  await h.server.notify({ content: "CI failed", meta: { kind: "ci.workflow_failed" } });
  assert.deepEqual(await h.next(1), {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: "CI failed", meta: { kind: "ci.workflow_failed" } },
  });
});

test("ping answers, a tool call is refused, an unknown request is method-not-found", async () => {
  const h = harness();
  h.send({ id: 7, method: "ping" });
  assert.deepEqual(await h.next(1), { jsonrpc: "2.0", id: 7, result: {} });
  h.send({ id: 8, method: "tools/list" });
  assert.deepEqual(await h.next(2), { jsonrpc: "2.0", id: 8, result: { tools: [] } });
  h.send({ id: 9, method: "tools/call", params: { name: "reply" } });
  assert.equal(((await h.next(3)) as { error: { code: number } }).error.code, -32601);
  h.send({ id: 10, method: "server/discover" });
  assert.equal(((await h.next(4)) as { error: { code: number } }).error.code, -32601);
});

const fakeTools: ToolHost = {
  list: () => [
    {
      name: "subscribe",
      title: "Watch",
      description: "d",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Watch", readOnlyHint: true, openWorldHint: true },
    },
  ],
  call: async (name, args) => (name === "subscribe" ? { text: `ok ${JSON.stringify(args)}` } : { text: `unknown tool: ${name}`, isError: true }),
};

test("with tools, the capabilities are tools and the channel, and never the permission relay", async () => {
  assert.deepEqual(capabilities(true), { tools: {}, experimental: { "claude/channel": {} } });
  assert.deepEqual(capabilities(false), CAPABILITIES);
  const h = harness(fakeTools);
  h.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  const r = (await h.next(1)) as { result: { capabilities: { experimental: object } } };
  assert.deepEqual(r.result.capabilities, { tools: {}, experimental: { "claude/channel": {} } });
  assert.ok(!("claude/channel/permission" in r.result.capabilities.experimental));
});

test("tools/list lists the host's tools and tools/call routes and wraps the text", async () => {
  const h = harness(fakeTools);
  h.send({ id: 2, method: "tools/list" });
  const list = (await h.next(1)) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ["subscribe"]);
  h.send({ id: 3, method: "tools/call", params: { name: "subscribe", arguments: { pr: 7 } } });
  assert.deepEqual(await h.next(2), { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: 'ok {"pr":7}' }], isError: false } });
  h.send({ id: 4, method: "tools/call", params: { name: "reply", arguments: {} } });
  assert.deepEqual(await h.next(3), {
    jsonrpc: "2.0",
    id: 4,
    result: { content: [{ type: "text", text: "unknown tool: reply" }], isError: true },
  });
});
