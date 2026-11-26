// Which file a program's bare name runs: its absolute path, found in PATH's absolute folders and nowhere else.
//
// gh, git and ps are started with the session's folder as the working folder, and a repository holds whatever its
// authors put there. Started by bare name, a program is looked for by the system: Windows looks in the working folder
// before PATH, and anywhere a PATH with an empty entry, `.` or a relative folder does the same. A file named gh or
// git in the repository would then run, as this user, at every launch. So every program the plugin starts is first
// resolved here, and started by the absolute path this gives. A name that is not found is "not installed", exactly as
// before.
//
// Shared by the hooks, the setup checks, the setup-github skill and the channel (bundled). Nothing is run here.
// Dependency-free plain JavaScript, Node 20.
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** A program's bare name: no folder in it, so it can only ever be looked up, never name a file by itself. */
const BARE = /^[A-Za-z0-9._-]{1,64}$/;
/** An ending PATHEXT may give (`.EXE`): a dot and a few letters, nothing that could step out of the folder. */
const ENDING = /^\.[A-Za-z0-9]{1,8}$/;
/**
 * Windows starts a .bat or .cmd only through its command interpreter, which the plugin never uses: started without
 * one they fail, so they are not programs here. gh and git are both .exe.
 */
const NEEDS_A_SHELL = new Set([".bat", ".cmd"]);

/** A regular file, and on POSIX one this user may execute. */
function runnable(file, win) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, win ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of the program `name` (a bare name: gh, git, ps), or null when PATH's absolute folders hold none.
 * An empty entry, `.` and any relative folder are skipped, so the working folder is never looked in. On Windows the
 * endings in PATHEXT are tried in its order. `isProgram` is the tests' seam for a file system that is not this one.
 */
export function findProgram(name, env = process.env, platform = process.platform, isProgram = runnable) {
  const command = String(name ?? "");
  if (!BARE.test(command) || command === "." || command === "..") return null;
  const win = platform === "win32";
  const path = win ? win32 : posix;
  const endings = win
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => ENDING.test(e) && !NEEDS_A_SHELL.has(e.toLowerCase()))
    : [""];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(win ? ";" : ":")) {
    // On Windows `\folder` and `C:folder` are relative too (to the current drive, or to that drive's current folder).
    if (!dir || !path.isAbsolute(dir) || (win && !/^([A-Za-z]:[\\/]|[\\/]{2})/.test(dir))) continue;
    for (const ending of endings) {
      const file = path.join(dir, command + ending);
      if (isProgram(file, win)) return file;
    }
  }
  return null;
}
