// The setup-github skill's `claude-gh` command: a separate command that starts Claude
// Code with the channel on, written between markers into the user's shell rc file, so it can be added again
// without duplicating and taken out exactly. It never overrides `claude`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BEGIN, END, addBlock, blockFor, removeBlock, rcFor } from "../../skills/setup-github/claude-gh.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "setup-github", "claude-gh.mjs");
const CACHED = "/Users/me/.claude/plugins/cache/runners-io/runners-io/0.2.0";

test("zsh and bash get a function named claude-gh, fish a fish function; none redefines claude", () => {
  for (const shell of ["zsh", "bash"]) {
    const b = blockFor(shell, CACHED, "/usr/local/bin/claude");
    assert.ok(b.startsWith(`${BEGIN}\n`) && b.endsWith(`${END}\n`));
    assert.match(b, /^claude-gh\(\) \{ \/usr\/local\/bin\/claude --dangerously-load-development-channels plugin:runners-io@runners-io "\$@"; \}$/m);
    assert.doesNotMatch(b, /^(alias claude=|claude\(\))/m);
  }
  const fish = blockFor("fish", CACHED, "/usr/local/bin/claude");
  assert.match(fish, /^function claude-gh\b/m);
  assert.match(fish, /^    \/usr\/local\/bin\/claude --dangerously-load-development-channels plugin:runners-io@runners-io \$argv$/m);
  assert.match(fish, /^end$/m);
});

test("a plugin loaded with --plugin-dir keeps its --plugin-dir, quoted, and uses the inline entry; claude unknown falls back to `command claude`", () => {
  const b = blockFor("zsh", "/Users/me/My Plugins/runners-io", null);
  assert.match(b, /command claude --plugin-dir '\/Users\/me\/My Plugins\/runners-io' --dangerously-load-development-channels plugin:runners-io@inline "\$@"/);
});

test("the block says what it is, that it shows a confirmation screen at every launch, and how to remove it", () => {
  const b = blockFor("zsh", CACHED, "/usr/local/bin/claude");
  assert.match(b, /confirmation screen at every launch/);
  assert.match(b, /remove/i);
});

test("adding twice leaves one block, an update replaces it in place, and removing gives back the file exactly", () => {
  const original = "export PATH=/x:$PATH\nalias ll='ls -l'\n";
  const one = addBlock(original, blockFor("zsh", CACHED, "/a/claude"));
  const two = addBlock(one, blockFor("zsh", CACHED, "/a/claude"));
  assert.equal(two, one);
  assert.equal(two.split(BEGIN).length - 1, 1);
  const moved = addBlock(two, blockFor("zsh", CACHED, "/b/claude"));
  assert.equal(moved.split(BEGIN).length - 1, 1);
  assert.match(moved, /\/b\/claude --/);
  assert.equal(removeBlock(moved), original);
  assert.equal(removeBlock(original), original, "nothing to remove is not an error");
  assert.equal(removeBlock(addBlock("", blockFor("bash", CACHED, null))), "");
  assert.equal(removeBlock(addBlock("no newline at end", blockFor("bash", CACHED, null))), "no newline at end");
});

test("a claude-gh the user already defined outside the block is refused, never overwritten", () => {
  assert.throws(() => addBlock("alias claude-gh=\"$HOME/bin/claude-gh\"\n", blockFor("zsh", CACHED, null)), /already defines claude-gh/);
});

test("the rc file follows the shell: ~/.zshrc (or $ZDOTDIR), ~/.bashrc, fish's config.fish", () => {
  assert.equal(rcFor("zsh", { HOME: "/h" }), "/h/.zshrc");
  assert.equal(rcFor("zsh", { HOME: "/h", ZDOTDIR: "/z" }), "/z/.zshrc");
  assert.equal(rcFor("bash", { HOME: "/h" }), "/h/.bashrc");
  assert.equal(rcFor("fish", { HOME: "/h" }), "/h/.config/fish/config.fish");
  assert.equal(rcFor("fish", { HOME: "/h", XDG_CONFIG_HOME: "/c" }), "/c/fish/config.fish");
  assert.throws(() => rcFor("tcsh", { HOME: "/h" }), /zsh, bash or fish/);
});

function which(name) {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const ZSH = which("zsh");

test("end to end on a throwaway zsh: show changes nothing, add makes `type claude-gh` a function, remove takes it out", { skip: ZSH ? false : "no zsh on this machine (CI's Linux runner): the bash case below runs the same path" }, () => {
  const home = mkdtempSync(join(tmpdir(), "claude-gh-"));
  const rc = join(home, ".zshrc");
  writeFileSync(rc, "# mine\n");
  const env = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: ZSH };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
  const shown = cli("show");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(rc.replaceAll("/", "\\/")));
  assert.equal(readFileSync(rc, "utf8"), "# mine\n");
  assert.equal(cli("add").status, 0);
  assert.equal(cli("add").status, 0);
  const type = execFileSync(ZSH, ["-ic", "type claude-gh"], { env, encoding: "utf8" });
  assert.match(type, /claude-gh is a shell function/);
  assert.ok(existsSync(`${rc}.before-runners-io`), "the first add keeps a copy of the file as it was");
  assert.equal(cli("remove").status, 0);
  assert.equal(readFileSync(rc, "utf8"), "# mine\n");
  const gone = spawnSync(ZSH, ["-ic", "type claude-gh"], { env, encoding: "utf8" });
  assert.notEqual(gone.status, 0);
});

test("a block between the same markers that this script did not write is left alone by add and remove", () => {
  const foreign = `# mine\n${BEGIN}\n# someone's own launcher\nalias claude-gh="$HOME/bin/claude-gh"\nalias cgh="$HOME/bin/claude-gh"\n${END}\n`;
  assert.throws(() => addBlock(foreign, blockFor("zsh", CACHED, null)), /not written by this script/);
  assert.throws(() => removeBlock(foreign), /not written by this script/);
  const ours = addBlock("# mine\n", blockFor("zsh", CACHED, null));
  assert.equal(removeBlock(ours), "# mine\n", "its own block still comes out");
});

test("end to end on a throwaway bash: add makes claude-gh a function in an interactive bash, remove restores the file exactly", () => {
  const bash = which("bash");
  assert.ok(bash, "bash is on every machine this runs on");
  const home = mkdtempSync(join(tmpdir(), "claude-gh-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "# mine, no final newline");
  const env = { ...process.env, HOME: home, SHELL: bash };
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
  assert.equal(cli("add").status, 0);
  const type = spawnSync(bash, ["--rcfile", rc, "-ic", "type claude-gh"], { env, encoding: "utf8" });
  assert.match(type.stdout, /claude-gh is a function/);
  assert.equal(cli("remove").status, 0);
  assert.equal(readFileSync(rc, "utf8"), "# mine, no final newline");
});

test("show says up front that add would refuse a file whose claude-gh it did not write, and add exits 3 leaving it unchanged", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-gh-"));
  const rc = join(home, ".zshrc");
  const text = `${BEGIN}\nalias claude-gh="$HOME/bin/claude-gh"\n${END}\n`;
  writeFileSync(rc, text);
  const env = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh" };
  const shown = spawnSync(process.execPath, [SCRIPT, "show"], { env, encoding: "utf8" });
  assert.match(shown.stdout, /add would refuse: .*not written by this script/);
  const added = spawnSync(process.execPath, [SCRIPT, "add"], { env, encoding: "utf8" });
  assert.equal(added.status, 3);
  assert.equal(readFileSync(rc, "utf8"), text);
});
