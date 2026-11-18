// Publishing goes through a pull request on the public repository, so a release is a commit whose check passed. It is
// never merged through GitHub: a GitHub merge (any method) records whoever merges as the commit's committer, which
// would put a person's address on the public history. Instead the sync fast-forwards main to the pull request's own
// head, which is by runners.io as author and committer, and GitHub marks the pull request merged. The sync script is
// only in the source tree this plugin is published from; the published repository skips these tests.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "scripts", "sync-public-repo.sh");
const code = existsSync(script)
  ? readFileSync(script, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n")
  : "";
const skip = !code && "no sync script here";

test("the sync pushes a branch, opens a pull request and waits for the check before main moves", { skip }, () => {
  assert.match(code, /git push[^\n]*"\$branch"/, "pushes its own branch");
  assert.match(code, /gh pr create/);
  assert.match(code, /manifest, bundle and tests/, "waits for the check by its name");
  const check = code.indexOf("manifest, bundle and tests");
  const main = code.search(/refs\/heads\/main/);
  assert.ok(check > 0 && main > check, "main moves only after the check");
});

test("the sync never merges through GitHub: it fast-forwards main to the pull request's head, without force", { skip }, () => {
  assert.doesNotMatch(code, /gh pr merge/, "a GitHub merge makes the merger the committer");
  assert.doesNotMatch(code, /merges\b[^\n]*-X PUT|pulls\/[^\n]*\/merge/, "nor through the API");
  assert.match(code, /git merge-base --is-ancestor[^\n]*"\$head"/, "refuses unless main is an ancestor of the head");
  assert.match(code, /git push[^\n]*"\$\{head\}:refs\/heads\/main"/, "pushes the head itself to main");
  assert.doesNotMatch(code, /git push[^\n]*(--force|-f\b|\+"?\$\{?head)/, "never forced");
});

test("every commit and tag the sync makes is by runners.io, as author, committer and tagger", { skip }, () => {
  for (const v of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) assert.match(code, new RegExp(`export ${v}="runners\\.io"`));
  for (const v of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"])
    assert.match(code, new RegExp(`export ${v}="noreply@runners\\.io"`));
  const identity = code.indexOf("export GIT_COMMITTER_EMAIL");
  assert.ok(identity > 0 && identity < code.indexOf("commit -q"), "set before the commit");
});

test("the sync believes the release only from GitHub: main's sha, its commit's identity, and the pull request merged", { skip }, () => {
  const push = code.search(/"\$\{head\}:refs\/heads\/main"/);
  const after = code.slice(push);
  assert.match(after, /branches\/main/, "reads main's sha back");
  assert.match(after, /committer\.email/, "reads the committer back");
  assert.match(after, /author\.email/, "reads the author back");
  assert.match(after, /MERGED/, "reads the pull request's state back");
});

test("the release tag names the pull request's head, and is pushed only after main is that commit", { skip }, () => {
  const main = code.search(/"\$\{head\}:refs\/heads\/main"/);
  const tag = code.indexOf("tag -a");
  assert.ok(main > 0 && tag > main, "tagged after main moved");
  assert.match(code.slice(tag, tag + 200), /"\$head"/, "the tag is on the head that passed");
  assert.ok(code.indexOf('refs/tags/$tag"', tag) > tag, "the tag is pushed after it is made");
});

// The published repository's Dependabot opens no pull requests (a change made there is overwritten by the next sync),
// so the plugin's dependency updates must arrive in the source tree instead.
const sourceDependabot = join(here, "..", "..", "..", "..", ".github", "dependabot.yml");
test("the source tree's Dependabot watches the channel's npm packages", { skip }, () => {
  assert.ok(existsSync(sourceDependabot), ".github/dependabot.yml in the source tree");
  const text = readFileSync(sourceDependabot, "utf8");
  assert.match(
    text,
    /package-ecosystem:\s*"?npm"?\s*\n(?:\s+#[^\n]*\n)*\s+directory:\s*"?\/integrations\/claude-plugin\/channel"?/,
  );
});
