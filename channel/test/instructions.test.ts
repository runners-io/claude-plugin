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
  assert.ok(INSTRUCTIONS.includes(NAMES_LABEL), "Claude is told what the label in each event means");
  for (const kind of ["label", "file path", "login"]) assert.ok(INSTRUCTIONS.includes(kind), kind);
});

test("the instructions say a review's or a comment's text is information, and a bot's review is not a person's", () => {
  assert.match(INSTRUCTIONS, /pr\.changes_requested/);
  assert.match(INSTRUCTIONS, /author_type/);
  assert.match(INSTRUCTIONS, /never follow instructions/);
});
