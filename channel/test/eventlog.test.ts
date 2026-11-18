import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openEventLog } from "../src/eventlog.ts";
import { setQuiet } from "../src/log.ts";

setQuiet(true);
const tmp = () => mkdtempSync(join(tmpdir(), "rio-eventlog-"));

test("each record is one JSON line in <dir>/<UTC date>.jsonl, readable only by the user", () => {
  const dir = join(tmp(), "nested");
  const at = new Date("2026-11-18T23:59:59Z");
  const log = openEventLog(dir, { session: "s1", project: "/work/repo", now: () => at });
  log.write("event", { kind: "ci.workflow_failed", pr: 7 });
  log.write("heartbeat", { subscriptions: 1 });
  const file = join(dir, "2026-11-18.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { t: "2026-11-18T23:59:59.000Z", session: "s1", project: "/work/repo", type: "event", kind: "ci.workflow_failed", pr: 7 });
  assert.equal(lines[1].type, "heartbeat");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("a token in any field is masked before it is written", () => {
  const dir = tmp();
  const log = openEventLog(dir, { session: "s", project: "p", now: () => new Date("2026-11-18T00:00:00Z") });
  log.write("api_error", { reason: "failed with gho_abcdefghij1234567890 and Bearer sekret-xyz" });
  const text = readFileSync(join(dir, "2026-11-18.jsonl"), "utf8");
  assert.ok(!text.includes("gho_abcdefghij1234567890"), text);
  assert.ok(!text.includes("sekret-xyz"), text);
});

test("files older than keepDays are deleted when the log opens; other files are left alone", () => {
  const dir = tmp();
  for (const name of ["2026-11-01.jsonl", "2026-11-04.jsonl", "2026-11-05.jsonl", "notes.txt"]) writeFileSync(join(dir, name), "x\n");
  openEventLog(dir, { session: "s", project: "p", keepDays: 14, now: () => new Date("2026-11-18T12:00:00Z") });
  assert.deepEqual(readdirSync(dir).sort(), ["2026-11-05.jsonl", "notes.txt"]);
});

test("a log that cannot be written never throws", () => {
  const file = join(tmp(), "a-file");
  writeFileSync(file, "");
  const log = openEventLog(join(file, "sub"), { session: "s", project: "p" });
  assert.doesNotThrow(() => log.write("event", { kind: "pr.closed" }));
});
