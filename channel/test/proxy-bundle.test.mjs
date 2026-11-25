// A company proxy, end to end: the BUNDLE, as a user's Node.js runs it, with HTTPS_PROXY naming a real CONNECT proxy
// on this machine and the fake GitHub behind it. Once with GitHub on plain http (the other tests' fake), and once
// behind TLS, which is how the real one is reached: the handshake with GitHub happens inside the proxy's tunnel, so
// the proxy carries the token without being able to read it. Plain JavaScript so it also runs on Node 20, the oldest
// Node.js the plugin supports and one that has no proxy support of its own to fall back on.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFakeGitHub } from "./fake-github.mjs";
import { fakeMachine, project } from "./fake-machine.mjs";
import { startFakeProxy } from "./fake-proxy.mjs";

const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "runners-io-channel.mjs");
const TOKEN = "gho_fakeProxyBundleToken0123456789";
const SECRET = "pr0xy-pa55w0rd";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const cleanup = [];
after(async () => {
  for (const c of cleanup.reverse()) await c();
});

/** A certificate for `localhost`, made now and thrown away with the test's folder: no key is kept in the repository. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "rio-proxy-cert-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], {
    stdio: "ignore",
  });
  return { key, cert };
}

/** GitHub behind TLS: an https server on this machine that hands every request to the fake GitHub. */
async function behindTls(gh, { key, cert }) {
  const target = new URL(gh.base);
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const up = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => (server.closeAllConnections(), server.close(r))));
  return `https://localhost:${server.address().port}`;
}

async function world({ proxy: proxyOptions = {} } = {}) {
  const gh = await startFakeGitHub({ token: TOKEN });
  const proxy = await startFakeProxy(proxyOptions);
  cleanup.push(() => gh.close(), () => proxy.close());
  gh.setPull("acme/widgets", 7, { head: { ref: "feat", sha: SHA } });
  const m = fakeMachine();
  cleanup.push(() => rmSync(m.root, { recursive: true, force: true }));
  const dir = project(m);
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "feat"]);
  return { gh, proxy, m, dir };
}

/** `runners-io-channel status` with the bundle, and everything it printed. */
async function status(w, env) {
  const child = spawn(process.execPath, [bundle, "status"], {
    env: { ...w.m.env, CLAUDE_PROJECT_DIR: w.dir, RUNNERS_IO_GITHUB_API: w.gh.base, RUNNERS_IO_TEST_FAKE_GITHUB: "1", RUNNERS_IO_TEST_GITHUB_TOKEN: TOKEN, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}
const line = (out, label) => out.split("\n").find((l) => l.includes(label)) ?? "";

/** Every file under a folder, as text: what the plugin wrote on this "machine". */
function everythingWritten(root) {
  let text = "";
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st?.isDirectory()) text += everythingWritten(path);
    else if (st?.isFile() && st.size < 1024 * 1024) text += readFileSync(path, "latin1");
  }
  return text;
}

test("status behind a proxy: GitHub is asked through the proxy named in HTTPS_PROXY, and the check says so with the proxy's host only", async () => {
  const w = await world({ proxy: { auth: `ada:${SECRET}` } });
  const r = await status(w, { HTTPS_PROXY: w.proxy.url(`ada:${SECRET}`) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}ready .*asked just now/);
  assert.match(r.stdout, /pull request: #7/);
  const authority = new URL(w.gh.base).host;
  assert.ok(w.proxy.connects.length >= 2, "the pull request and the repository were both asked through the proxy");
  assert.deepEqual([...new Set(w.proxy.connects.map((c) => c.authority))], [authority]);
  assert.equal(w.proxy.requests.length, 0);
  assert.match(line(r.stdout, "through a proxy the channel can use"), new RegExp(`^ {2}ready .*through 127\\.0\\.0\\.1:${w.proxy.port}.*HTTPS_PROXY`));
  // The proxy's login is in the environment and in the CONNECT, and nowhere else: not printed, not logged, not kept.
  for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["the plugin's files", everythingWritten(w.m.root)]]) {
    assert.equal(text.includes(SECRET), false, `${where} holds the proxy's password`);
    assert.equal(text.includes("ada:"), false, `${where} holds the proxy's user name`);
  }
});

test("status with NO_PROXY naming GitHub's host: asked directly, and the check says that", async () => {
  const w = await world();
  const r = await status(w, { HTTPS_PROXY: w.proxy.url(), NO_PROXY: "example.com,127.0.0.1" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}ready /);
  assert.equal(w.proxy.connects.length, 0, "the proxy was not asked for anything");
  assert.match(line(r.stdout, "through a proxy the channel can use"), /^ {2}ready .*directly: NO_PROXY names/);
});

test("status with no proxy variable: nothing goes near a proxy, and the check is plain ready", async () => {
  const w = await world();
  const r = await status(w, {});
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}ready /);
  assert.equal(w.proxy.connects.length, 0);
  assert.match(line(r.stdout, "through a proxy the channel can use"), /^ {2}ready {6}GitHub is reached directly, or through a proxy the channel can use$/);
});

test("GitHub behind TLS, as the real one is: the handshake is made inside the tunnel, so the proxy carries a token it cannot read", async () => {
  const w = await world();
  const tls = certificate();
  const base = await behindTls(w.gh, tls);
  const r = await status(w, { RUNNERS_IO_GITHUB_API: base, https_proxy: w.proxy.url(), NODE_EXTRA_CA_CERTS: tls.cert });
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}ready .*asked just now/, r.stdout + r.stderr);
  assert.match(r.stdout, /pull request: #7/);
  assert.deepEqual([...new Set(w.proxy.connects.map((c) => c.authority))], [new URL(base).host]);
  const carried = w.proxy.sent();
  assert.ok(carried.length > 500, `the requests went through the proxy (${carried.length} bytes)`);
  assert.equal(carried.includes(TOKEN), false, "the token is inside TLS: the proxy cannot read it");
  assert.equal(carried.toLowerCase().includes("authorization"), false);
  assert.equal(w.gh.requests.some((q) => q.status === 401), false, "GitHub got the token intact");
});

test("with NODE_USE_ENV_PROXY=1, whichever of Node.js and the channel does the work, GitHub is still reached through the proxy and the token stays unread", async () => {
  // On a Node.js that reads the proxy variables itself the channel stands aside; on one that does not, it does the
  // work. Either way the same holds, so this runs unchanged on every Node.js the plugin supports.
  const w = await world();
  const tls = certificate();
  const base = await behindTls(w.gh, tls);
  const r = await status(w, { RUNNERS_IO_GITHUB_API: base, HTTPS_PROXY: w.proxy.url(), NODE_EXTRA_CA_CERTS: tls.cert, NODE_USE_ENV_PROXY: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}ready .*asked just now/, r.stdout + r.stderr);
  assert.match(r.stdout, /pull request: #7/);
  assert.deepEqual([...new Set(w.proxy.connects.map((c) => c.authority))], [new URL(base).host]);
  assert.equal(w.proxy.sent().includes(TOKEN), false);
  assert.match(line(r.stdout, "through a proxy the channel can use"), /^ {2}ready .*through 127\.0\.0\.1:/);
});

test("behind the proxy GitHub's certificate is still checked: one that does not verify is refused, and the next launch is told why", async () => {
  const w = await world();
  const base = await behindTls(w.gh, certificate());
  // No NODE_EXTRA_CA_CERTS: the certificate is one this Node.js has no reason to trust.
  const r = await status(w, { RUNNERS_IO_GITHUB_API: base, HTTPS_PROXY: w.proxy.url() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(line(r.stdout, "GitHub answers for this repository"), /^ {2}unknown .*could not ask GitHub/);
  assert.match(line(r.stdout, "GitHub's certificate verifies"), /^ {2}NOT READY .*\[blocks; cert_error\]/);
  assert.ok(w.proxy.connects.length >= 1, "the connection was made through the proxy, and refused inside its tunnel");
  assert.equal(w.gh.requests.length, 0, "no request, and so no token, was sent over a connection that did not verify");
});

test("the channel itself, started behind a proxy: a tool's read of GitHub goes through it", async () => {
  const w = await world();
  const child = spawn(process.execPath, [bundle], {
    env: { ...w.m.env, CLAUDE_PROJECT_DIR: w.dir, RUNNERS_IO_GITHUB_API: w.gh.base, RUNNERS_IO_TEST_FAKE_GITHUB: "1", RUNNERS_IO_TEST_GITHUB_TOKEN: TOKEN, HTTPS_PROXY: w.proxy.url(`ada:${SECRET}`) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let buf = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      messages.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const until = async (what, fn) => {
    const begin = Date.now();
    while (!fn()) {
      if (Date.now() - begin > 15_000) throw new Error(`timed out waiting for ${what}; stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } } });
    await until("initialize", () => messages.some((m) => m.id === 1));
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "ci_status", arguments: {} } });
    await until("ci_status", () => messages.some((m) => m.id === 2));
    const answer = messages.find((m) => m.id === 2).result;
    assert.equal(answer.isError, false, answer.content[0].text);
    assert.match(answer.content[0].text, /PR #7/);
    assert.ok(w.proxy.connects.length >= 1, "the tool's read went through the proxy");
    assert.match(stderr, new RegExp(`through the proxy 127\\.0\\.0\\.1:${w.proxy.port} \\(HTTPS_PROXY\\)`), "the channel's log says which way GitHub is reached");
    assert.equal(stderr.includes(SECRET) || stderr.includes("ada"), false, "and never the proxy's login");
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
  }
});
