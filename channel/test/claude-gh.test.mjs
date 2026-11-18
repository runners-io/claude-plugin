// The setup-github skill's `claude-gh` command: a separate command that starts Claude
// Code with the channel on, written between markers into the user's shell rc file, so it can be added again
// without duplicating and taken out exactly. It never overrides `claude`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BEGIN, END, addBlock, blockFor, listedShells, removeBlock, rcFor, writeRc } from "../../skills/setup-github/claude-gh.mjs";

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

test("an empty or relative HOME is refused, so the rc file is never written into the current folder", () => {
  for (const env of [{}, { HOME: "" }, { HOME: "relative" }]) {
    for (const shell of ["zsh", "bash", "fish"]) assert.throws(() => rcFor(shell, env), /HOME/, `${shell} ${JSON.stringify(env)}`);
  }
  assert.equal(rcFor("zsh", { ZDOTDIR: "/z" }), "/z/.zshrc", "an absolute ZDOTDIR needs no HOME");
  assert.equal(rcFor("fish", { XDG_CONFIG_HOME: "/c" }), "/c/fish/config.fish", "nor does an absolute XDG_CONFIG_HOME");
});

test("the rc file is replaced in one step, through a symlink to the real file, keeping its mode and leaving no temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-gh-rc-"));
  const real = join(dir, "dotfiles", "zshrc");
  mkdirSync(dirname(real));
  writeFileSync(real, "old\n", { mode: 0o600 });
  const link = join(dir, ".zshrc");
  symlinkSync(real, link);
  writeRc(link, "new\n");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "a dotfile kept in a repository stays a symlink");
  assert.equal(readFileSync(real, "utf8"), "new\n");
  assert.equal(statSync(real).mode & 0o777, 0o600, "its mode is kept");
  assert.deepEqual(readdirSync(dirname(real)), ["zshrc"], "no temporary file left");
  const fresh = join(dir, "fresh", ".bashrc");
  mkdirSync(dirname(fresh));
  writeRc(fresh, "x\n");
  assert.equal(readFileSync(fresh, "utf8"), "x\n");
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

// ZSH (above): the macOS default; on Linux CI the workflows install it (claude-plugin.yml, ci.yml).

test("without zsh installed, a SHELL of zsh is no answer, so no offer", async () => {
  const { claudeGhPresent } = await import("../../skills/setup-github/claude-gh.mjs");
  if (process.env.CI) assert.ok(ZSH, "zsh is not installed: the CI workflow must install it, or the next test checks nothing");
  const missing = "/nonexistent/bin/zsh";
  assert.equal(await claudeGhPresent({ HOME: "/nowhere", SHELL: missing, PATH: "/usr/bin:/bin" }), null);
});

test("claude-gh is looked for in the user's own login shell: an alias, a function or a command, wherever it is defined", async () => {
  const { claudeGhPresent } = await import("../../skills/setup-github/claude-gh.mjs");
  if (!ZSH) {
    assert.equal(process.env.CI, undefined, "CI must have zsh");
    return; // a machine without zsh: the test above checks the answer it gets
  }
  const home = mkdtempSync(join(tmpdir(), "claude-gh-"));
  const env = { HOME: home, ZDOTDIR: home, SHELL: ZSH, PATH: "/usr/bin:/bin" };
  assert.equal(await claudeGhPresent(env, { shells: new Set([env.SHELL]) }), false, "nowhere");
  writeFileSync(join(home, ".zshrc"), addBlock("# mine\n", blockFor("zsh", CACHED, null)));
  assert.equal(await claudeGhPresent(env, { shells: new Set([env.SHELL]) }), true, "our block in .zshrc");
  writeFileSync(join(home, ".zshrc"), "# mine\n");
  writeFileSync(join(home, ".zprofile"), "alias claude-gh='claude --channels x'\n");
  assert.equal(await claudeGhPresent(env, { shells: new Set([env.SHELL]) }), true, "an alias in .zprofile");
  writeFileSync(join(home, ".zprofile"), "");
  writeFileSync(join(home, "more.zsh"), "claude-gh() { claude \"$@\"; }\n");
  writeFileSync(join(home, ".zshrc"), `source ${join(home, "more.zsh")}\n`);
  assert.equal(await claudeGhPresent(env, { shells: new Set([env.SHELL]) }), true, "a function in a file .zshrc sources");
  const bin = mkdtempSync(join(tmpdir(), "claude-gh-bin-"));
  writeFileSync(join(home, ".zshrc"), "# mine\n");
  writeFileSync(join(bin, "claude-gh"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(await claudeGhPresent({ ...env, PATH: `${bin}:/usr/bin:/bin` }, { shells: new Set([env.SHELL]) }), true, "an executable on PATH");
});

test("bash: found in .bashrc as well as in the login files", async () => {
  const { claudeGhPresent } = await import("../../skills/setup-github/claude-gh.mjs");
  const home = mkdtempSync(join(tmpdir(), "claude-gh-"));
  const env = { HOME: home, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" };
  assert.equal(await claudeGhPresent(env, { shells: new Set([env.SHELL]) }), false);
  writeFileSync(join(home, ".bashrc"), "alias claude-gh='claude --channels x'\n");
  assert.equal(await claudeGhPresent(env, { shells: new Set([env.SHELL]) }), true, ".bashrc, which a login bash does not read by itself");
});

test("no answer, so no offer: Windows, a shell other than zsh, bash or fish, a shell that fails or hangs", async () => {
  const { claudeGhPresent } = await import("../../skills/setup-github/claude-gh.mjs");
  const env = { HOME: "/nowhere", SHELL: "/bin/zsh", PATH: "/nonexistent" };
  const shells = new Set(["/bin/zsh", "/bin/tcsh", "/usr/local/bin/fish"]);
  const calls = [];
  const run = (status) => (file, args) => {
    calls.push([file, ...args]);
    return status;
  };
  assert.equal(await claudeGhPresent(env, { shells, platform: "win32", run: run(1) }), null, "Windows");
  assert.equal(await claudeGhPresent({ ...env, SHELL: "/bin/tcsh" }, { shells, run: run(1) }), null, "tcsh");
  assert.equal(await claudeGhPresent({ ...env, SHELL: undefined }, { shells, run: run(1) }), null, "no SHELL");
  assert.deepEqual(calls, [], "no shell was started for any of them");
  assert.equal(await claudeGhPresent(env, { shells, run: run(null) }), null, "timed out or could not start");
  assert.equal(await claudeGhPresent(env, { shells, run: run(127) }), null, "the shell's own failure");
  assert.equal(await claudeGhPresent(env, { shells, run: run(0) }), true);
  assert.equal(await claudeGhPresent(env, { shells, run: run(1) }), false);
  calls.length = 0;
  await claudeGhPresent({ ...env, SHELL: "/usr/local/bin/fish" }, { shells, run: run(1) });
  assert.deepEqual(calls, [["/usr/local/bin/fish", "-lic", "type -q claude-gh"]], "fish: its own builtin, fixed arguments");
  calls.length = 0;
  await claudeGhPresent(env, { shells, run: run(1) });
  assert.deepEqual(calls, [["/bin/zsh", "-lic", "command -v claude-gh >/dev/null 2>&1"]]);
});

test("SHELL is used only when /etc/shells lists it: one pointing anywhere else is no answer, and nothing is started", async () => {
  const { claudeGhPresent } = await import("../../skills/setup-github/claude-gh.mjs");
  const calls = [];
  const run = (file) => {
    calls.push(file);
    return 0;
  };
  const env = { HOME: "/nowhere", PATH: "/nonexistent" };
  const shells = new Set(["/bin/zsh", "/bin/bash"]);
  assert.equal(await claudeGhPresent({ ...env, SHELL: "/tmp/x/zsh" }, { run, shells }), null);
  assert.equal(await claudeGhPresent({ ...env, SHELL: "/home/u/bin/bash" }, { run, shells }), null);
  assert.equal(await claudeGhPresent({ ...env, SHELL: "/bin/zsh" }, { run, shells: new Set() }), null, "an unreadable /etc/shells lists nothing");
  assert.deepEqual(calls, [], "no shell was started for any of them");
  assert.equal(await claudeGhPresent({ ...env, SHELL: "/bin/zsh" }, { run, shells }), true);
  assert.deepEqual(listedShells("# comment\n/bin/sh\n\n /usr/bin/zsh \nnot/absolute\n"), new Set(["/bin/sh", "/usr/bin/zsh"]));
});

test("a no is remembered for 7 days: no offer and no shell started until then, then it is offered once again", async () => {
  const { claudeGhForOffer, recordDecline } = await import("../../skills/setup-github/claude-gh.mjs");
  const home = mkdtempSync(join(tmpdir(), "claude-gh-decline-"));
  const env = { HOME: home, SHELL: "/bin/zsh" };
  const cacheRoot = join(home, ".cache", "runners-io");
  let asked = 0;
  const present = () => {
    asked++;
    return false;
  };
  const t0 = 1_700_000_000_000;
  const day = 24 * 60 * 60_000;
  assert.equal(await claudeGhForOffer(env, present, { now: t0, cacheRoot }), false, "offered before any no");
  assert.equal(recordDecline(env, t0), true);
  const state = join(home, ".local", "state", "runners-io");
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, "claude-gh-declined.json")).mode & 0o777, 0o600);
  asked = 0;
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + day, cacheRoot }), null, "a day later: no offer");
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + 7 * day - 1, cacheRoot }), null, "just under a week: none");
  assert.equal(asked, 0, "and the user's shell was not started");
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + 7 * day, cacheRoot }), false, "a week later: offered again");
  assert.equal(await claudeGhForOffer({ ...env, XDG_STATE_HOME: join(home, "elsewhere") }, present, { now: t0 + day, cacheRoot }), false, "XDG_STATE_HOME is where it lives");
});

test("a no is never read or written through a symlink, another user's folder, or without an absolute HOME", async () => {
  const { claudeGhForOffer, recordDecline } = await import("../../skills/setup-github/claude-gh.mjs");
  const present = () => false;
  const t0 = 1_700_000_000_000;
  const home = mkdtempSync(join(tmpdir(), "claude-gh-decline-link-"));
  const target = join(home, "target");
  mkdirSync(target);
  mkdirSync(join(home, ".local", "state"), { recursive: true });
  symlinkSync(target, join(home, ".local", "state", "runners-io"));
  const env = { HOME: home, SHELL: "/bin/zsh" };
  assert.equal(recordDecline(env, t0), false, "a symlinked state folder is refused");
  assert.deepEqual(readdirSync(target), [], "nothing was written through it");
  const home2 = mkdtempSync(join(tmpdir(), "claude-gh-decline-file-"));
  const state2 = join(home2, ".local", "state", "runners-io");
  mkdirSync(state2, { recursive: true, mode: 0o700 });
  const planted = join(home2, "planted.json");
  writeFileSync(planted, JSON.stringify({ at: t0 }));
  symlinkSync(planted, join(state2, "claude-gh-declined.json"));
  const cacheRoot = join(home2, ".cache", "runners-io");
  assert.equal(await claudeGhForOffer({ HOME: home2, SHELL: "/bin/zsh" }, present, { now: t0 + 1000, cacheRoot }), false, "a symlinked record is not believed");
  assert.equal(recordDecline({ SHELL: "/bin/zsh" }, t0), false, "no HOME: nowhere to write");
  assert.equal(recordDecline({ HOME: "relative" }, t0), false);
});

test("`claude-gh.mjs decline` records the no and says when it will be asked again", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-gh-decline-cli-"));
  const r = spawnSync(process.execPath, [SCRIPT, "decline"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /7 days/);
  assert.ok(existsSync(join(home, ".local", "state", "runners-io", "claude-gh-declined.json")));
});

test("a claude-gh found is remembered for a day, so the shell is not started at every launch; one missing is asked every time", async () => {
  const { claudeGhForOffer } = await import("../../skills/setup-github/claude-gh.mjs");
  const cacheRoot = join(mkdtempSync(join(tmpdir(), "claude-gh-cache-")), "runners-io");
  const env = { SHELL: "/bin/zsh" };
  let asked = 0;
  let answer = false;
  const present = () => {
    asked++;
    return answer;
  };
  const t0 = 1_700_000_000_000;
  assert.equal(await claudeGhForOffer(env, present, { now: t0, cacheRoot }), false);
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + 1000, cacheRoot }), false);
  assert.equal(asked, 2, "missing: asked at every launch");
  answer = true;
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + 2000, cacheRoot }), true);
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + 60 * 60_000, cacheRoot }), true);
  assert.equal(asked, 3, "found: not asked again within the day");
  assert.equal(statSync(cacheRoot).mode & 0o777, 0o700);
  for (const f of readdirSync(cacheRoot)) assert.equal(statSync(join(cacheRoot, f)).mode & 0o777, 0o600, f);
  assert.equal(await claudeGhForOffer({ SHELL: "/bin/bash" }, present, { now: t0 + 3000, cacheRoot }), true);
  assert.equal(asked, 4, "another shell is asked for itself");
  answer = false;
  assert.equal(await claudeGhForOffer(env, present, { now: t0 + 25 * 60 * 60_000, cacheRoot }), false, "a day later it is asked again");
  assert.equal(asked, 5);
});

test("the remembered answer is ignored in a symlinked cache folder", async () => {
  const { claudeGhForOffer } = await import("../../skills/setup-github/claude-gh.mjs");
  const base = mkdtempSync(join(tmpdir(), "claude-gh-cache-"));
  const target = join(base, "elsewhere");
  mkdirSync(target);
  symlinkSync(target, join(base, "runners-io"));
  let asked = 0;
  const present = () => (asked++, true);
  await claudeGhForOffer({ SHELL: "/bin/zsh" }, present, { now: 1, cacheRoot: join(base, "runners-io") });
  await claudeGhForOffer({ SHELL: "/bin/zsh" }, present, { now: 2, cacheRoot: join(base, "runners-io") });
  assert.equal(asked, 2);
  assert.deepEqual(readdirSync(target), [], "nothing written through the link");
});

test("RUNNERS_IO_NO_CLAUDE_GH_OFFER=1 turns the offer off without starting a shell", async () => {
  const { claudeGhForOffer } = await import("../../skills/setup-github/claude-gh.mjs");
  let asked = 0;
  const present = () => {
    asked++;
    return false;
  };
  assert.equal(await claudeGhForOffer({ RUNNERS_IO_NO_CLAUDE_GH_OFFER: "1" }, present), null);
  assert.equal(asked, 0);
  assert.equal(await claudeGhForOffer({}, present), false);
});

test("nothing the shell's startup files start outlives the check: on a timeout, or after a normal exit", async () => {
  const { claudeGhPresent } = await import("../../skills/setup-github/claude-gh.mjs");
  const left = (tag) => execFileSync("/bin/ps", ["-eo", "args="], { encoding: "utf8" }).split("\n").filter((l) => l.trim() === tag).length; // the whole command, never a line that mentions it
  const home = mkdtempSync(join(tmpdir(), "claude-gh-group-"));
  const env = { HOME: home, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" };
  // a hang: a background job, then a wait the check gives up on
  writeFileSync(join(home, ".bash_profile"), "sleep 61.1231 &\nsleep 30.4567\n");
  const started = Date.now();
  assert.equal(await claudeGhPresent(env, { timeoutMs: 500 }), null, "timed out: no answer");
  assert.ok(Date.now() - started < 3000, "it gave up at the limit");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(left("sleep 61.1231"), 0, "the background job was killed with the shell");
  assert.equal(left("sleep 30.4567"), 0, "and the wait too");
  // a normal exit that leaves a background job behind
  writeFileSync(join(home, ".bash_profile"), "sleep 61.1232 &\n");
  assert.equal(await claudeGhPresent(env, { timeoutMs: 4000 }), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(left("sleep 61.1232"), 0, "a job left running by a shell that exited is killed too");
});
