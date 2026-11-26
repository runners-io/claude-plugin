/**
 * The smallest MCP stdio server a one-way channel needs, written by hand so
 * the bundle carries no SDK and installs nothing at run time.
 *
 * WHAT IT DECLARES, AND WHAT IT DOES NOT:
 * - `capabilities.experimental['claude/channel']: {}`, which is what makes
 *   Claude Code register it as a channel;
 * - `tools`, when it is given a ToolHost: the subscribe tools (tools.ts),
 *   which change only what this process watches. There is still no reply
 *   tool: nothing Claude does is sent anywhere through the channel;
 * - NO `claude/channel/permission`: declaring it would let Claude Code forward
 *   tool-approval prompts here, and a CI event must never approve Bash, Write
 *   or Edit. The key is absent rather than `false`, because Claude Code before
 *   v2.1.234 read `false` as declared (channels-reference, "Server options").
 *
 * THE PROTOCOL IS PINNED below revision 2026-07-28. On Claude Code's v2 MCP
 * client a channel server that negotiates revision 2026-07-28 is not registered as a
 * channel, because that revision cannot carry channel messages (mcp.md, "Push
 * messages with channels"). `MCP_PROTOCOL_NEGOTIATION=legacy` fixes that from
 * the CLIENT side, which a plugin cannot set for the user; answering
 * `initialize` with an earlier revision fixes it from ours, whatever the
 * client's setting.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { ChannelMessage } from "./format.ts";
import { log } from "./log.ts";
import type { ToolHost } from "./tools.ts";

/** Newest first. Revision 2026-07-28 is deliberately absent. */
export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export function chooseProtocol(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
    ? requested
    : "2025-06-18";
}

export const CAPABILITIES = { experimental: { "claude/channel": {} } } as const;

export function capabilities(withTools: boolean): Record<string, unknown> {
  return withTools ? { tools: {}, ...CAPABILITIES } : CAPABILITIES;
}

export interface McpOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly name: string;
  readonly version: string;
  readonly instructions: string;
  /** Called once, when the client sends `notifications/initialized`. */
  readonly onReady: () => void;
  /** Called when the client closes stdin: Claude Code exited or dropped the server. */
  readonly onClose: () => void;
  /** The subscribe tools. Absent: the server declares no tools at all. */
  readonly tools?: ToolHost;
  /**
   * Told when a tool threw instead of answering, and when a message could not be handled or answered at all (`tool`
   * null). The client is answered as before; this is where the channel reports a fault of its own (main.ts).
   */
  readonly onFault?: (error: unknown, tool: string | null) => void;
}

export interface McpServer {
  /** Pushes one channel event. Resolves when it is written, which is all Claude Code acknowledges. */
  notify(message: ChannelMessage): Promise<void>;
}

type Id = string | number;

export function startMcp(opts: McpOptions): McpServer {
  let ready = false;

  const write = (payload: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      opts.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`, (error) => (error ? reject(error) : resolve()));
    });
  const reply = (id: Id, result: unknown) => write({ id, result });
  const fail = (id: Id, code: number, message: string) => write({ id, error: { code, message } });

  const handle = async (msg: Record<string, unknown>) => {
    const method = typeof msg.method === "string" ? msg.method : null;
    const id = msg.id as Id | undefined;
    const isRequest = id !== undefined && id !== null;
    if (!method) return; // a response to a request we never send
    if (!isRequest) {
      if (method === "notifications/initialized" && !ready) {
        ready = true;
        opts.onReady();
      }
      return;
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize":
        await reply(id, {
          protocolVersion: chooseProtocol(params.protocolVersion),
          capabilities: capabilities(Boolean(opts.tools)),
          serverInfo: { name: opts.name, version: opts.version },
          instructions: opts.instructions,
        });
        return;
      case "ping":
        await reply(id, {});
        return;
      case "tools/list":
        await reply(id, { tools: opts.tools ? opts.tools.list() : [] });
        return;
      case "tools/call": {
        if (!opts.tools) {
          await fail(id, -32601, "method not found: tools/call");
          return;
        }
        const name = typeof params.name === "string" ? params.name : "";
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        let result: { text: string; isError?: boolean };
        try {
          result = await opts.tools.call(name, args);
        } catch (error) {
          log(`tool ${name}: ${(error as Error).message}`);
          opts.onFault?.(error, name);
          result = { text: `the ${name} tool failed: ${(error as Error).message}`, isError: true };
        }
        await reply(id, { content: [{ type: "text", text: result.text }], isError: result.isError === true });
        return;
      }
      // Not declared, so a client should not ask; answered empty so one that
      // does sees a server with nothing to offer rather than an error.
      case "prompts/list":
        await reply(id, { prompts: [] });
        return;
      case "resources/list":
        await reply(id, { resources: [] });
        return;
      case "resources/templates/list":
        await reply(id, { resourceTemplates: [] });
        return;
      default:
        await fail(id, -32601, `method not found: ${method}`);
    }
  };

  const unhandled = (e: unknown) => {
    log(`mcp: ${(e as Error).message}`);
    opts.onFault?.(e, null);
  };

  const lines = createInterface({ input: opts.input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      void write({ id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (Array.isArray(msg)) {
      for (const m of msg) void handle(m as Record<string, unknown>).catch(unhandled);
    } else if (msg && typeof msg === "object") {
      void handle(msg as Record<string, unknown>).catch(unhandled);
    }
  });
  lines.on("close", () => opts.onClose());

  return {
    async notify(message) {
      if (!ready) throw new Error("the client has not finished initializing");
      await write({ method: "notifications/claude/channel", params: { content: message.content, meta: message.meta } });
    },
  };
}
