// A forward proxy on 127.0.0.1 that does the one thing a client asks of a proxy for an https address: CONNECT, then
// bytes both ways. It keeps what it was asked and what went through it, so a test can say a request passed through,
// and what the proxy could and could not read. Plain JavaScript so the Node 20 bundle test can use it too.
import { createServer } from "node:http";
import { connect } from "node:net";

/** auth: the `user:password` the proxy asks for, or null for none. refuse: a status to answer every CONNECT with. */
export async function startFakeProxy({ auth = null, refuse = null } = {}) {
  const connects = []; // { authority, headers }: each CONNECT the proxy was sent
  const requests = []; // anything that was not a CONNECT, which a client that tunnels never sends
  const sent = []; // the bytes clients sent through their tunnels
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(405).end();
  });
  server.on("connect", (req, client, head) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    connects.push({ authority: req.url, headers: req.headers });
    if (refuse) return void client.end(`HTTP/1.1 ${refuse} Refused\r\n\r\n`);
    if (auth && req.headers["proxy-authorization"] !== `Basic ${Buffer.from(auth).toString("base64")}`) {
      return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n');
    }
    const at = req.url.lastIndexOf(":");
    const upstream = connect(Number(req.url.slice(at + 1)), req.url.slice(0, at).replace(/^\[|\]$/g, ""), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.on("data", (d) => sent.push(d));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    port,
    /** The proxy's address as a proxy variable names it, with a login when one is given. */
    url: (login = "") => `http://${login ? `${login}@` : ""}127.0.0.1:${port}`,
    connects,
    requests,
    /** Everything clients sent through their tunnels, as text. */
    sent: () => Buffer.concat(sent).toString("latin1"),
    // Every connection is ended, not only the tunnels: server.close() alone waits for any connection still mid-request,
    // and that wait has no end (fake-servers-close.test.mjs).
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
