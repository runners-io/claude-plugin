// One relaunch instruction: the launch notice, the channel's tools and the watch-this-pr skill say the
// same sentence, built once in hooks/launch.mjs. Three different instructions had been given: `claude-gh --continue`
// (the tools), `claude-gh --resume <id>` (the notice) and a README pointer to a `--channels` flag the preview refuses.
// Plain JavaScript, so it runs on Node 20.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { relaunchSentence } from "../../hooks/launch.mjs";
import { noticeFor } from "../../hooks/session-start.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const ID = "0f6c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5";

test("with the id known, the sentence is --resume with it; with none, it is the placeholder, and --continue only as the fallback", () => {
  assert.equal(relaunchSentence(ID), `relaunch with \`claude-gh --resume ${ID}\``);
  const unknown = relaunchSentence(null);
  assert.match(unknown, /^relaunch with `claude-gh --resume <this session's id>`/);
  assert.match(unknown, /`claude-gh --continue` only when it is not known/);
  assert.equal(relaunchSentence("x; rm -rf /"), unknown, "a session id that is not an id is never put into a command");
});

test("the launch notice says the sentence for its own session", () => {
  const out = noticeFor({ source: "startup", session_id: ID }, { state: "off" }, "/x");
  assert.ok(out.systemMessage.includes(relaunchSentence(ID)), out.systemMessage);
});

test("the channel's tools say the sentence, built from the same function", () => {
  const tools = read("channel/src/tools.ts");
  assert.match(tools, /import \{ relaunchSentence \} from "\.\.\/\.\.\/hooks\/launch\.mjs";/);
  assert.match(tools, /\$\{relaunchSentence\(null\)\}/);
  assert.doesNotMatch(tools.replace(/\/\*[\s\S]*?\*\//g, ""), /Relaunch with `claude-gh --continue`/);
});

test("the watch-this-pr skill says the sentence word for word, and sends nobody to a --channels flag", () => {
  const skill = flat(read("skills/watch-this-pr/SKILL.md"));
  assert.ok(skill.includes(relaunchSentence(null)), "the skill's relaunch line is not launch.mjs's sentence");
  assert.doesNotMatch(skill, /--channels/);
});

test("CONTROL: a skill with the old pointer, or another wording, fails", () => {
  const old = "see the plugin's README for the `--channels` flag";
  assert.equal(old.includes(relaunchSentence(null)), false);
  assert.match(old, /--channels/);
});
