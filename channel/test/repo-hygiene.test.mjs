// The repository's own supply chain: what its CI runs, what keeps that up to date, and where a vulnerability is
// reported. Runs in the published repository and in the tree it is published from.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflows = join(root, ".github", "workflows");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("every action a workflow uses is pinned to a full commit SHA, so a moved tag cannot change what runs", () => {
  const files = readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0);
  let seen = 0;
  for (const f of files)
    for (const line of read(".github", "workflows", f).split("\n")) {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (!m) continue;
      seen++;
      assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${line.trim()}`);
    }
  assert.ok(seen > 0, "no uses: line was read, so nothing was checked");
});

test("npm ci runs no package's install scripts", () => {
  let seen = 0;
  for (const f of readdirSync(workflows))
    for (const line of read(".github", "workflows", f).split("\n"))
      if (/\bnpm ci\b/.test(line)) {
        seen++;
        assert.match(line, /--ignore-scripts/, `${f}: ${line.trim()}`);
      }
  assert.ok(seen > 0);
});

test("Dependabot watches the workflow actions and the channel's npm packages", () => {
  const file = join(root, ".github", "dependabot.yml");
  assert.ok(existsSync(file), ".github/dependabot.yml");
  const text = readFileSync(file, "utf8");
  assert.match(text, /package-ecosystem:\s*"?github-actions"?/);
  assert.match(text, /package-ecosystem:\s*"?npm"?[\s\S]*?directory:\s*"?\/channel"?/);
});

test("SECURITY.md offers GitHub's private vulnerability reporting as well as the email address", () => {
  const text = read("SECURITY.md");
  assert.match(text, /security@runners\.io/);
  assert.match(text, /https:\/\/github\.com\/runners-io\/claude-plugin\/security\/advisories\/new/);
});

test(".gitignore keeps local and packed files out", () => {
  const lines = new Set(read(".gitignore").split("\n").map((l) => l.trim()));
  for (const entry of ["node_modules/", ".env*", ".DS_Store", "*.tgz", ".claude/settings.local.json", "coverage/"])
    assert.ok(lines.has(entry), entry);
});
