/**
 * A company proxy: the channel's GitHub requests go through the proxy the environment names.
 *
 * Node's own `fetch` does not read HTTPS_PROXY. Node 24 and late Node 22 can be told to (NODE_USE_ENV_PROXY=1), Node
 * 20 cannot, and the plugin runs on all of them. So behind a proxy the channel could not reach GitHub at all, while
 * `gh` (which reads the variables) worked beside it. Here the channel reads them the way gh and curl do
 * (hooks/proxy.mjs) and, when a proxy stands in the way, makes the request itself:
 *
 *   1. CONNECT to the proxy, naming GitHub's host and port. The proxy's own login, when the variable carries one, is
 *      sent here and nowhere else.
 *   2. Through the tunnel the proxy opens, the TLS handshake with GitHub, checked against GitHub's certificate as
 *      always (NODE_EXTRA_CA_CERTS adds a company's root as it does for any Node program).
 *   3. The request, inside that TLS. So the GitHub token is only ever written to GitHub itself: the proxy carries
 *      bytes it cannot read, and is never handed a header of the request.
 *
 * WITH NO PROXY VARIABLE SET NOTHING CHANGES: `githubFetch` hands back Node's `fetch` itself. A host the no_proxy list
 * names is asked directly, by that same `fetch`. And where Node.js was told to read the proxy variables and can
 * (NODE_USE_ENV_PROXY=1, on 24 or 22.21 and later), the channel stands aside: Node's `fetch` is handed back there too.
 *
 * One tunnel per request, closed with it. A kept-alive tunnel would save a handshake, but a proxy closes idle
 * connections on its own clock, and a request written to one it has just closed fails: the channel asks a few times
 * a minute, so it pays the handshake and never meets a dead tunnel.
 *
 * No dependency does this: the plugin installs nothing, and its bundle holds only its own code. What that leaves out:
 * a SOCKS proxy, a proxy found by a PAC file, and a proxy that wants NTLM or Kerberos. For those the request goes as
 * it did before (directly), and the setup checks say that the proxy is one the channel cannot use.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

import { machineError } from "./errors.ts";
import { type Proxy, nodeProxiesItself, proxyFor, proxyVariable } from "../../hooks/proxy.mjs";

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
type Init = NonNullable<Parameters<Fetch>[1]>;

/** How long the proxy has to answer the CONNECT; the request's own limit (the caller's signal) covers the rest too. */
const CONNECT_TIMEOUT_MS = 20_000;
/** The largest answer read into memory. GitHub's largest (a page of 100 runs) is under a megabyte. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** The statuses that carry no body, which `Response` refuses to be given one for. */
const NO_BODY = new Set([204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The `fetch` the GitHub client uses: `direct` itself (Node's `fetch`) when no proxy variable is set, otherwise one
 * that sends each request through the proxy, or directly when the no_proxy list names its host or the proxy is of a
 * kind the channel cannot use. Also `direct` itself when Node.js was told to read the proxy variables and can
 * (NODE_USE_ENV_PROXY=1 on a Node.js that knows it): its `fetch` then goes through the proxy by itself.
 */
export function githubFetch(env: Env, direct: Fetch = fetch, nodeVersion: string = process.versions.node): Fetch {
  if (!proxyVariable(env) || nodeProxiesItself(env, nodeVersion)) return direct;
  return async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const route = proxyFor(env, target);
    if (route.kind !== "proxy") return direct(input, init);
    return throughProxy(route.proxy, new URL(target), init ?? {});
  };
}

/**
 * One line for the channel's log on how GitHub is reached, or null when no proxy variable is set. It names the
 * variable and the proxy's host and port, never the proxy's login.
 */
export function proxyNote(env: Env, target: string, nodeVersion: string = process.versions.node): string | null {
  const route = proxyFor(env, target);
  if (route.kind === "proxy" && nodeProxiesItself(env, nodeVersion)) {
    return `GitHub is reached through the proxy ${route.proxy.display} (${route.variable}), by Node.js itself (NODE_USE_ENV_PROXY=1)`;
  }
  if (route.kind === "proxy") return `GitHub is reached through the proxy ${route.proxy.display} (${route.variable})`;
  if (route.kind === "unusable") return `${route.variable} names a proxy the channel cannot use (only http:// and https:// proxies): GitHub is asked directly`;
  return route.why === "no_proxy" ? `GitHub is asked directly: ${route.variable} names its host` : null;
}

/** Node's own code for a failed connection (ECONNREFUSED, ENOTFOUND, ...), or its message, which names no login. */
function why(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown };
  return typeof e?.code === "string" ? e.code : String(e?.message ?? error);
}

/** The tunnel: a connection to `authority` that the proxy carries. Rejects with a sentence that names the proxy's host only. */
function openTunnel(proxy: Proxy, authority: string, signal: AbortSignal | undefined): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: authority };
    if (proxy.auth !== null) headers["proxy-authorization"] = `Basic ${Buffer.from(proxy.auth).toString("base64")}`;
    const req = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      headers,
      agent: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    let settled = false;
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      act();
    };
    const onAbort = () => {
      req.destroy();
      settle(() => reject(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return settle(() => reject(machineError(`the proxy ${proxy.display} answered HTTP ${res.statusCode} to CONNECT`)));
      }
      // The CONNECT's own time limit ends here: from now on the request's limit (the caller's signal) is the only one.
      socket.setTimeout(0);
      // The request that takes this connection listens for its errors. This listener is for the moments it does not
      // (before it has it, after it is done with it): an error nobody listens for would end the whole channel.
      socket.on("error", () => undefined);
      if (head.length) socket.unshift(head);
      settle(() => resolve(socket));
    });
    // A proxy that answers a CONNECT with an ordinary response (some answer 403 or 407 that way).
    req.once("response", (res) => {
      res.resume();
      req.destroy();
      settle(() => reject(machineError(`the proxy ${proxy.display} answered HTTP ${res.statusCode} to CONNECT`)));
    });
    req.once("timeout", () => {
      req.destroy();
      settle(() => reject(machineError(`the proxy ${proxy.display} did not answer in time`)));
    });
    req.once("error", (error) => settle(() => reject(machineError(`the proxy ${proxy.display} could not be reached (${why(error)})`, { cause: error }))));
    req.end();
  });
}

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const status = res.statusCode ?? 0;
  // A copy in a plain array of bytes, which is what `Response` takes.
  return new Response(NO_BODY.has(status) || body.length === 0 ? null : Uint8Array.from(body), { status, statusText: res.statusMessage ?? "", headers });
}

async function throughProxy(proxy: Proxy, url: URL, init: Init): Promise<Response> {
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new TypeError("a request through the proxy takes a text body only");
  const body = typeof init.body === "string" ? init.body : null;
  const secure = url.protocol === "https:";
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const tunnel = await openTunnel(proxy, `${url.hostname}:${port}`, signal);
  if (signal?.aborted) {
    tunnel.destroy();
    throw signal.reason;
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  // The answer is read as it is sent: no compression is asked for, so none has to be undone.
  headers["accept-encoding"] = "identity";
  if (body !== null) headers["content-length"] = String(Buffer.byteLength(body));

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      tunnel.destroy();
      // The caller's limit ran out: its own reason (a TimeoutError), as fetch gives it.
      if (signal?.aborted) return reject(signal.reason);
      // As fetch reports a failed connection: Node's own error is the cause, where a certificate's code is read.
      reject(error instanceof TypeError ? error : machineError(`GitHub through the proxy ${proxy.display}: ${why(error)}`, { cause: error }));
    };
    const onAbort = () => {
      req.destroy();
      fail(signal?.reason);
    };
    const req = (secure ? httpsRequest : httpRequest)({
      host,
      port,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
      // No `agent` is named, on purpose: Node uses `createConnection` only then. With `agent: false` it makes an
      // agent of its own, which opens a connection of its own, straight to GitHub and past the proxy.
      // GitHub's certificate is checked here, inside the tunnel, against GitHub's own name.
      createConnection: () => (secure ? tlsConnect({ socket: tunnel, host, ...(isIP(host) ? {} : { servername: host }) }) : tunnel),
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    req.once("error", fail);
    req.once("response", (res) => {
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status) && init.redirect !== "manual") {
        res.resume();
        req.destroy();
        // It carries the status, as an HTTP answer does: an answer of GitHub's is never a fault of the plugin's.
        return fail(Object.assign(new TypeError(`GitHub answered a redirect (HTTP ${status}), which is never followed: the token stays with the address it was read for`), { status }));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          return fail(machineError("the answer is larger than the channel reads"));
        }
        chunks.push(chunk);
      });
      res.once("error", fail);
      res.once("end", () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        tunnel.destroy();
        try {
          resolve(toResponse(res, Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.end(body ?? undefined);
  });
}
