import assert from "node:assert/strict";
import { chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVENT_LOG_SUBDIR, openEventLog } from "../src/eventlog.ts";
import { setQuiet } from "../src/log.ts";

setQuiet(true);
const tmp = () => mkdtempSync(join(tmpdir(), "rio-eventlog-"));

test("each record is one JSON line in <dir>/<subfolder>/<UTC date>.jsonl, readable only by the user", () => {
  const dir = join(tmp(), "nested");
  const at = new Date("2026-11-18T23:59:59Z");
  const log = openEventLog(dir, { session: "s1", project: "/work/repo", now: () => at });
  log.write("event", { kind: "ci.workflow_failed", pr: 7 });
  log.write("heartbeat", { subscriptions: 1 });
  const own = join(dir, EVENT_LOG_SUBDIR);
  const file = join(own, "2026-11-18.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { t: "2026-11-18T23:59:59.000Z", session: "s1", project: "/work/repo", type: "event", kind: "ci.workflow_failed", pr: 7 });
  assert.equal(lines[1].type, "heartbeat");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(own).mode & 0o777, 0o700);
});

test("a token in any field is masked before it is written", () => {
  const dir = tmp();
  const log = openEventLog(dir, { session: "s", project: "p", now: () => new Date("2026-11-18T00:00:00Z") });
  log.write("api_error", { reason: "failed with gho_abcdefghij1234567890 and Bearer sekret-xyz" });
  const text = readFileSync(join(dir, EVENT_LOG_SUBDIR, "2026-11-18.jsonl"), "utf8");
  assert.ok(!text.includes("gho_abcdefghij1234567890"), text);
  assert.ok(!text.includes("sekret-xyz"), text);
});

test("files older than keepDays are deleted when the log opens; other files are left alone", () => {
  const dir = tmp();
  const own = join(dir, EVENT_LOG_SUBDIR);
  mkdirSync(own, { mode: 0o700 });
  for (const name of ["2026-11-01.jsonl", "2026-11-04.jsonl", "2026-11-05.jsonl", "notes.txt"]) writeFileSync(join(own, name), "x\n");
  openEventLog(dir, { session: "s", project: "p", keepDays: 14, now: () => new Date("2026-11-18T12:00:00Z") });
  assert.deepEqual(readdirSync(own).sort(), ["2026-11-05.jsonl", "notes.txt"]);
});

// The directory is the user's choice and may hold anything: the log changes nothing in it but its own subfolder.
test("only the plugin's own subfolder is pruned or chmodded; a day file directly in the directory is left as it is", () => {
  const dir = tmp();
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "2026-11-01.jsonl"), "theirs\n");
  openEventLog(dir, { session: "s", project: "p", keepDays: 14, now: () => new Date("2026-11-18T12:00:00Z") }).write("start");
  assert.deepEqual(readdirSync(dir).sort(), ["2026-11-01.jsonl", EVENT_LOG_SUBDIR]);
  assert.equal(statSync(dir).mode & 0o777, 0o755, "the user's directory keeps its mode");
  assert.deepEqual(readdirSync(join(dir, EVENT_LOG_SUBDIR)), ["2026-11-18.jsonl"]);
});

/** Runs fn with the channel's stderr captured, and returns its lines. */
function stderrOf(fn: () => void): string[] {
  const lines: string[] = [];
  const write = process.stderr.write;
  setQuiet(false);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = write;
    setQuiet(true);
  }
  return lines;
}

test("a log directory that is a symlink is refused: nothing is written through it, with one line on stderr", () => {
  const target = tmp();
  const link = join(tmp(), "link");
  symlinkSync(target, link);
  const lines = stderrOf(() => {
    const log = openEventLog(link, { session: "s", project: "p" });
    log.write("event", { kind: "pr.closed" });
    log.write("event", { kind: "pr.closed" });
  });
  assert.deepEqual(readdirSync(target), [], "nothing created through the link");
  assert.equal(lines.length, 1, lines.join(""));
  assert.match(lines[0], /event log/);
});

test("a log directory owned by another user is refused", () => {
  const dir = tmp();
  const someoneElse = (process.getuid?.() ?? 0) + 1;
  const lines = stderrOf(() => openEventLog(dir, { session: "s", project: "p", uid: someoneElse }).write("start"));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(lines.length, 1);
  // The control: the same directory, owned by this user, is used.
  openEventLog(dir, { session: "s", project: "p" }).write("start");
  assert.deepEqual(readdirSync(dir), [EVENT_LOG_SUBDIR]);
});

test("the plugin's subfolder replaced by a symlink is refused too", () => {
  const dir = tmp();
  const target = tmp();
  symlinkSync(target, join(dir, EVENT_LOG_SUBDIR));
  stderrOf(() => openEventLog(dir, { session: "s", project: "p" }).write("start"));
  assert.deepEqual(readdirSync(target), []);
  assert.ok(lstatSync(join(dir, EVENT_LOG_SUBDIR)).isSymbolicLink(), "left as it was");
});

test("a day file that is a symlink is never written through", { skip: constants.O_NOFOLLOW === undefined ? "no O_NOFOLLOW here" : false }, () => {
  const dir = tmp();
  const own = join(dir, EVENT_LOG_SUBDIR);
  mkdirSync(own, { mode: 0o700 });
  const victim = join(tmp(), "victim");
  writeFileSync(victim, "untouched\n");
  symlinkSync(victim, join(own, "2026-11-18.jsonl"));
  const log = openEventLog(dir, { session: "s", project: "p", now: () => new Date("2026-11-18T12:00:00Z") });
  stderrOf(() => log.write("event", { kind: "pr.closed" }));
  assert.equal(readFileSync(victim, "utf8"), "untouched\n");
  assert.ok(existsSync(victim));
});

test("a log that cannot be written never throws", () => {
  const file = join(tmp(), "a-file");
  writeFileSync(file, "");
  const log = openEventLog(join(file, "sub"), { session: "s", project: "p" });
  assert.doesNotThrow(() => log.write("event", { kind: "pr.closed" }));
});
