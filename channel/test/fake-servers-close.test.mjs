// The test servers' close() ends their own connections. A bare `server.close()` waits for every open connection, and
// proxy.test.ts closes the fake GitHub before the fake proxy whose tunnel is still connected to it: that wait could last
// for ever, and `npm test` then never finished. A diagnostic report of a stuck run showed the fake GitHub's listener with
// one established connection from the proxy's side.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";

import { startFakeGitHub } from "./fake-github.mjs";
import { startFakeProxy } from "./fake-proxy.mjs";

/** Resolves with what `promise` gave, or with "timed out" after `ms`; the timer never keeps the process alive. */
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timed out"), ms);
    timer.unref();
  });
  return Promise.race([promise.then(() => "closed"), late]).finally(() => clearTimeout(timer));
}

/**
 * A client connection with a request still in flight: its headers are begun and never finished, so the server holds it
 * as active, which `server.close()` alone never ends (it ends only idle keep-alive connections). A tunnel the proxy cut
 * mid-request leaves the fake GitHub in this state.
 */
async function openConnection(base) {
  const { hostname, port } = new URL(base);
  const socket = connect({ host: hostname, port: Number(port) });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  socket.write(`GET /rate_limit HTTP/1.1\r\nHost: ${hostname}:${port}\r\n`);
  // Long enough for the server to have read the partial request and to count the connection active.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return socket;
}

test("the fake GitHub's close() ends a connection a client left open", async () => {
  const gh = await startFakeGitHub({ token: "gho_closeTest0123456789" });
  const socket = await openConnection(gh.base);
  const ended = new Promise((resolve) => socket.once("close", resolve));
  try {
    assert.equal(await within(gh.close(), 2000), "closed", "close() waited on the open connection");
    assert.equal(await within(ended, 2000), "closed", "the client's connection was not ended");
  } finally {
    socket.destroy();
  }
});

test("control: with no connection open, the fake GitHub's close() resolves", async () => {
  const gh = await startFakeGitHub({ token: "gho_closeTest0123456789" });
  assert.equal(await within(gh.close(), 2000), "closed");
});

test("the fake proxy's close() ends a connection a client left open", async () => {
  const proxy = await startFakeProxy({});
  const socket = connect({ host: "127.0.0.1", port: Number(new URL(proxy.url()).port) });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  try {
    assert.equal(await within(proxy.close(), 2000), "closed", "close() waited on the open connection");
  } finally {
    socket.destroy();
  }
});
