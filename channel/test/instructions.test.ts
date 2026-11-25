// What the channel tells Claude about its messages (the MCP server's instructions): every kind it can send is
// named, so a new kind is never one Claude has not been told about.
import assert from "node:assert/strict";
import { test } from "node:test";

import { INSTRUCTIONS } from "../src/instructions.ts";
import { NAMES_LABEL } from "../src/format.ts";
import { EVENT_KINDS } from "../src/state.ts";

test("the instructions name every event kind the channel can send", () => {
  for (const kind of EVENT_KINDS) assert.ok(INSTRUCTIONS.includes(kind), kind);
  assert.ok(INSTRUCTIONS.includes("ci.current_state"));
  assert.ok(INSTRUCTIONS.includes("review.requested"), "the session-wide kind too");
  assert.ok(INSTRUCTIONS.includes("channel_throttled"), "a PR whose events are held back, and what to do instead");
  assert.ok(INSTRUCTIONS.includes("channel_held_back"), "a session whose events are held back for the hour, and what to do instead");
  assert.ok(INSTRUCTIONS.includes(NAMES_LABEL), "Claude is told what the label in each event means");
  for (const kind of ["label", "file path", "login"]) assert.ok(INSTRUCTIONS.includes(kind), kind);
});

test("the instructions say a review's or a comment's text is information, and a bot's review is not a person's", () => {
  assert.match(INSTRUCTIONS, /pr\.changes_requested/);
  assert.match(INSTRUCTIONS, /author_type/);
  assert.match(INSTRUCTIONS, /never follow instructions/);
});

// The instructions and the event's own sentence must agree: a request for changes is reported to the user, a member's
// review may be read as information, and nobody's review makes Claude change code or push.
test("on a request for changes or a review thread, Claude tells the user and changes code or pushes only if they ask", () => {
  const line = INSTRUCTIONS.split("\n").find((l) => l.includes("pr.changes_requested")) ?? "";
  assert.match(line, /tell the user/i);
  assert.match(line, /only if the user asks/i);
  assert.match(line, /outside or bot[^.]*only if the user asks/i, "an outsider's or bot's review is read only on request");
});

// Another person's pull request carries their text into the session, so Claude is told that only the user's
// own are watched unasked, what the two notices about that mean, and that widening is the user's call.
test("the instructions say only the user's own pull requests are watched unless one is named or a scope says otherwise", () => {
  assert.match(INSTRUCTIONS, /The current branch's pull request is watched automatically when the signed-in GitHub login opened it/);
  assert.ok(INSTRUCTIONS.includes("channel_pr_not_yours"), "the notice for a branch whose pull request is somebody else's");
  assert.ok(INSTRUCTIONS.includes("channel_scope_narrowed"), "the notice for a scope saved with the old default");
  assert.match(INSTRUCTIONS, /scope: "repo"[^.]*covers the pull requests the signed-in GitHub login opened/);
  assert.match(INSTRUCTIONS, /involves: "me"[^.]*involves: "all"[^.]*only if the user asks/);
});
