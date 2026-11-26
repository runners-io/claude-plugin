// The two rows only the channel adds to the setup checks' table (doctor.ts): whether live CI events are on in the
// session `status` was run from, and what GitHub answered just now.
import assert from "node:assert/strict";
import { test } from "node:test";

import { channelRow, liveRow } from "../src/doctor.ts";
import { type GhAuth, GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { relaunchSentence } from "../../hooks/launch.mjs";

setQuiet(true);

test("live CI events: ready when the channel flag is on, and never a claim when the launch cannot be read", () => {
  assert.equal(channelRow("on").state, "ready");
  assert.equal(channelRow("unknown").state, "unknown");
  assert.equal(channelRow("headless").state, "skipped");
});

test("live CI events off: it degrades, says CI on request still works, and gives the one relaunch sentence", () => {
  const r = channelRow("off");
  assert.equal(r.state, "not_ready");
  assert.equal(r.effect, "degrades");
  assert.match(r.line ?? "", /started without the channel flag, so CI results are not pushed into it; CI on request \(ci_status\) still works/);
  assert.ok(r.fix?.includes(relaunchSentence(null)), r.fix);
  assert.match(r.fix ?? "", /setup-github skill's step 5, asking first/);
});

test("live CI events where they cannot arrive at all: the row is skipped with the reason, never an instruction to relaunch", () => {
  for (const state of ["off", "on", "unknown"] as const) {
    const r = channelRow(state, "Amazon Bedrock");
    assert.equal(r.state, "skipped", state);
    assert.equal(r.why, "live CI events are not available on Amazon Bedrock");
    assert.equal(r.fix, undefined);
  }
  assert.equal(channelRow("off", null).state, "not_ready");
});

const auth = async (): Promise<GhAuth> => ({ kind: "ok", token: "gho_fakeToken123", source: "gh" });
const answering = (status: number, body: unknown) =>
  new GitHubClient("https://api.github.com", auth, async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("the live call: ready on an answer, and a fork is handed to the recorder", async () => {
  const forks: boolean[] = [];
  const recorder = { fork: (f: boolean) => forks.push(f) };
  const row = await liveRow(answering(200, { fork: true }), "acme/widgets", recorder);
  assert.deepEqual(row, { id: "github_answers", label: "GitHub answers for this repository", state: "ready", why: "asked just now" });
  assert.deepEqual(forks, [true]);
});

test("the live call in a folder with no repository asks about the login itself", async () => {
  const row = await liveRow(answering(200, { login: "octocat" }), null, null);
  assert.equal(row.label, "GitHub answers for this login");
  assert.equal(row.state, "ready");
});

test("the live call when GitHub does not show the repository: it blocks, with the three usual causes and each one's fix", async () => {
  const row = await liveRow(answering(404, { message: "Not Found" }), "acme/widgets", null);
  assert.equal(row.state, "not_ready");
  assert.equal(row.effect, "blocks");
  assert.equal(row.line, "GitHub doesn't show this repository to the signed-in login, so its CI can't be read.");
  assert.match(row.fix ?? "", /`! gh auth refresh --scopes repo`/);
  assert.match(row.fix ?? "", /single sign-on/);
  assert.match(row.fix ?? "", /wrong GitHub account/);
  assert.match(row.fix ?? "", /asking first/);
});

test("the live call when GitHub cannot be reached is unknown, with the reason, never ready", async () => {
  const down = new GitHubClient("https://api.github.com", auth, async () => {
    throw new TypeError("fetch failed");
  });
  const row = await liveRow(down, "acme/widgets", null);
  assert.equal(row.state, "unknown");
  assert.match(row.why ?? "", /could not ask GitHub: fetch failed/);
});

test("the live call where the plugin makes no request (certificate checks off, or a proxy it cannot use): unknown, with the reason and what to set", async () => {
  const never: typeof fetch = async () => {
    throw new Error("a request was made");
  };
  const tls = new GitHubClient("https://api.github.com", auth, never, { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
  assert.deepEqual(await liveRow(tls, "acme/widgets", null), {
    id: "github_answers",
    label: "GitHub answers for this repository",
    state: "unknown",
    why:
      "could not ask GitHub: NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, so the GitHub login is not sent and no request is made: " +
      "unset it (NODE_EXTRA_CA_CERTS adds a company's root certificate)",
  });
  const proxy = new GitHubClient("https://api.github.com", auth, never, { env: { https_proxy: "socks5://proxy.corp.example:1080" } });
  assert.equal(
    (await liveRow(proxy, null, null)).why,
    "could not ask GitHub: https_proxy names a proxy the plugin cannot use, so no request is made: set it to an http:// or https:// proxy, or name the host in NO_PROXY",
  );
});
