// The telemetry endpoint, as a listener on 127.0.0.1 that keeps what it was sent. A test names it with
// RUNNERS_IO_TEST_TELEMETRY_URL, the only way a test may send at all. `answer` is the status it gives (204 as the real
// one does); `hang: true` takes the request and never answers, as an address nothing listens behind would.
import { createServer } from "node:http";

export async function startFakeEndpoint({ answer = 204, hang = false, redirectTo = null } = {}) {
  const requests = []; // { method, path, headers, body } for each request received
  const sockets = new Set();
  const state = { answer, hang, redirectTo };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (state.hang) return;
      if (state.redirectTo) return void res.writeHead(302, { location: state.redirectTo }).end();
      res.writeHead(state.answer).end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/plugin/telemetry`,
    requests,
    state,
    /** The bodies received, parsed. */
    messages: () => requests.map((r) => JSON.parse(r.body)),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
