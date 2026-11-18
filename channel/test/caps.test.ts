// A session watches a bounded number of pull requests: each costs requests on the user's own GitHub budget, and each
// is a source of text in the conversation. The subscribe tool refuses past the total, and says how to make room.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GitHubClient } from "../src/github.ts";
import { setQuiet } from "../src/log.ts";
import { MAX_HOOK_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS } from "../src/subscriptions.ts";
import { Subscriptions } from "../src/subscriptions.ts";
import { makeTools } from "../src/tools.ts";
import { type FakeGitHub, startFakeGitHub } from "./fake-github.mjs";

setQuiet(true);
const fakes: FakeGitHub[] = [];
after(async () => {
  for (const f of fakes) await f.close();
});

test("the limits are 20 pull requests in all and 5 of them from the hook", () => {
  assert.equal(MAX_SUBSCRIPTIONS, 20);
  assert.equal(MAX_HOOK_SUBSCRIPTIONS, 5);
});

test("subscribe refuses a pull request past the total, and says how to make room", async () => {
  const gh = await startFakeGitHub({ token: "gho_fakeToken123" });
  fakes.push(gh);
  const client = new GitHubClient(gh.base, async () => ({ kind: "ok", token: "gho_fakeToken123", source: "gh" }));
  const subs = new Subscriptions();
  for (let pr = 1; pr <= MAX_SUBSCRIPTIONS; pr++) subs.add({ repo: "acme/widgets", pr, source: "tool" });
  gh.setPull("acme/widgets", 99, {});
  gh.setPull("acme/widgets", 5, {});
  const tools = makeTools({ subs, gh: client, readScope: async () => ({ repo: "acme/widgets", branch: "feat" }) });
  const r = await tools.call("subscribe", { repo: "acme/widgets", pr: 99 });
  assert.equal(r.isError, true);
  assert.match(r.text, /20 pull requests/);
  assert.match(r.text, /unsubscribe/);
  assert.equal(subs.get("acme/widgets", 99), undefined);
  const again = await tools.call("subscribe", { repo: "acme/widgets", pr: 5 });
  assert.equal(again.isError, undefined, "one already watched is not a new one: re-subscribing to it still works");
});
