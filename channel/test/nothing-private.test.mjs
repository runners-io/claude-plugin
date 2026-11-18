// Nothing in this plugin may name the private tracker, its tickets or the people and machines behind it, and no
// private block may survive into what is published. Where the export script is present (the source tree this plugin
// is published from), its own rules are applied to every file it would publish, after its private blocks are taken
// out. Where it is not (the published repository), a generic scan covers the shapes that matter, the bundle included.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exporter = join(root, "scripts", "export-public.mjs");
const isSource = existsSync(exporter);
const TEXT = /\.(m?[jt]s|d\.mts|json|md|ya?ml|sh|txt)$|(^|\/)(LICENSE|\.gitignore)$/;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(relative(root, p));
  }
  return out.sort();
}

/** Each text file as it would be published: in the source tree, without the private paths and blocks. */
async function published() {
  const ex = isSource ? await import(exporter) : null;
  const out = [];
  for (const f of files(root)) {
    if (!TEXT.test(f)) continue;
    if (ex && ex.PRIVATE_PATHS.some((p) => f === p || f.startsWith(`${p}/`))) continue;
    const text = readFileSync(join(root, f), "utf8");
    out.push({ f, text: ex ? ex.stripPrivate(text, f) : text });
  }
  return out;
}

test("every file that would be published passes the export's rules", { skip: !isSource && "the published tree has no export script" }, async () => {
  const { deniedBy } = await import(exporter);
  const texts = await published();
  assert.ok(texts.length > 20, `only ${texts.length} files found under ${root}`);
  const hits = [];
  for (const { f, text } of texts)
    text.split("\n").forEach((line, i) => {
      const rule = deniedBy(line, f);
      if (rule) hits.push(`${f}:${i + 1} [${rule}] ${line.trim().slice(0, 100)}`);
    });
  assert.deepEqual(hits, [], `the public export would refuse:\n${hits.join("\n")}`);
});

test("the export's rules refuse a ticket id, a private path and an internal name, and pass plain text", { skip: !isSource && "the published tree has no export script" }, async () => {
  const { deniedBy } = await import(exporter);
  const ticket = (k) => `// fixed in ${k}-12`;
  for (const line of [ticket("RUN"), ticket("WARP"), `const p = "~/.${"ci"}hero-coord/bin";`]) assert.ok(deniedBy(line, "x.ts"), line);
  assert.equal(deniedBy("// a branch name is chosen by whoever opens the pull request", "x.ts"), null);
});

test("what is published holds no tracker ticket id and no leftover private marker, the bundle included", async () => {
  const ticket = /\b(?:RUN|WARP)-\d/;
  const marker = /^\s*(?:\/\/|#|<!--)\s*<\/?private>/;
  const hits = [];
  for (const { f, text } of await published())
    text.split("\n").forEach((line, i) => {
      if (ticket.test(line) || marker.test(line)) hits.push(`${f}:${i + 1} ${line.trim().slice(0, 100)}`);
    });
  assert.deepEqual(hits, [], `found:\n${hits.join("\n")}`);
});
