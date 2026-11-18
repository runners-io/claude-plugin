// Publishing goes through a pull request on the public repository: main there requires the CI check, with no
// bypass, so a direct push would be refused, and a release tag must name a commit that passed. The sync script is
// only in the source tree this plugin is published from; the published repository skips this test.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "sync-public-repo.sh");
const code = existsSync(script)
  ? readFileSync(script, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n")
  : "";

test("the sync never pushes to main: it pushes a branch, opens a pull request, waits for the check, and merges", { skip: !code && "no sync script here" }, () => {
  assert.doesNotMatch(code, /git push[^\n]*\borigin\s+main\b/, "a direct push to main");
  assert.match(code, /git push[^\n]*"\$branch"/, "pushes its own branch");
  assert.match(code, /gh pr create/);
  assert.match(code, /manifest, bundle and tests/, "waits for the check by its name");
  assert.match(code, /gh pr merge/);
  assert.match(code, /MERGED/, "believes the merge only from the pull request's state");
});

test("the release tag names the merged commit, and is pushed only after the merge", { skip: !code && "no sync script here" }, () => {
  const merge = code.indexOf("gh pr merge");
  const tag = code.indexOf("tag -a");
  assert.ok(merge > 0 && tag > merge, "tagged after the merge");
  assert.match(code.slice(tag, tag + 300), /\$merged/, "the tag is on the merge commit");
});
