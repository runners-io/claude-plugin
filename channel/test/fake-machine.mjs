// A "machine" for the setup checks' tests: a folder whose PATH holds only what a case allows (a fake gh, the real git),
// with a home, state, cache and gh settings folder of its own, so nothing reads or writes this user's real ones.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
// A gh that answers `auth token` the way the case says, and notes in a file whether it was handed a token variable.
const FAKE_GH = `#!/bin/sh
[ -n "$GH_TOKEN$GITHUB_TOKEN" ] && echo "saw a token variable" >> "$FAKE_GH_LOG"
echo "$*" >> "$FAKE_GH_LOG"
if [ "$1 $2" = "auth token" ]; then
  [ "$FAKE_GH" = signed-in ] && { echo gho_fakeFakeFake; exit 0; }
  exit 1
fi
exit 0
`;

/** gh: "signed-in", "signed-out" or null (not installed). git: whether git is on PATH. */
export function fakeMachine({ gh = "signed-in", git = true, hosts, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rio-ready-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "gh"));
  // Where this "machine" keeps an organisation's managed Claude Code settings: empty, so the real machine's are never read.
  mkdirSync(join(root, "managed"));
  if (gh) {
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
  }
  if (git) symlinkSync(REAL_GIT, join(bin, "git"));
  if (hosts) writeFileSync(join(root, "gh", "hosts.yml"), hosts);
  return {
    root,
    ghLog: join(root, "gh.log"),
    env: {
      PATH: bin,
      HOME: join(root, "home"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      GH_CONFIG_DIR: join(root, "gh"),
      FAKE_GH: gh ?? "",
      FAKE_GH_LOG: join(root, "gh.log"),
      RUNNERS_IO_TEST_MANAGED_SETTINGS_DIR: join(root, "managed"),
      // This environment is built from nothing, so a hook started in it cannot tell the plugin's own tests are running
      // (no NODE_TEST_CONTEXT): without this line every run of the suite sent a real install ping to runners.io. A case
      // that tests sending passes RUNNERS_IO_TELEMETRY: "" with its own test endpoint (fake-machine-sends-nothing.test.mjs).
      RUNNERS_IO_TELEMETRY: "off",
      ...env,
    },
  };
}

/** A folder for the session. origin: a remote URL or null; workflows: whether .github/workflows holds a file. */
export function project(m, { repo = true, origin = "https://github.com/acme/widgets.git", workflows = true, upstream = null } = {}) {
  const dir = join(m.root, "project");
  mkdirSync(dir);
  if (!repo) return dir;
  execFileSync("git", ["init", "-q", dir]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  if (upstream) execFileSync("git", ["-C", dir, "remote", "add", "upstream", upstream]);
  if (workflows) {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yaml"), "on: push\n");
  }
  return dir;
}

