#!/usr/bin/env node
// SessionStart hook, at every launch:
//   - when the machine is missing something the plugin needs (the GitHub CLI, its login, git, a writable data
//     folder, ...), tell the user in one line and give Claude the fix to offer, asking first (readiness.mjs: the
//     setup checks). A machine that is ready adds nothing. RUNNERS_IO_NO_SETUP_CHECKS=1 turns the offers off;
//   - when this session was launched without the runners-io channel flag, tell the user how to relaunch it with
//     live CI events on;
//   - when the user has no `claude-gh` command, have Claude offer to set it up. A no is recorded (claude-gh.mjs
//     decline) and the offer is not made again for 7 days, then once more. RUNNERS_IO_NO_CLAUDE_GH_OFFER=1 turns
//     the offer off for good.
//
// Claude Code drops a channel's events silently in a session that did not opt in (channels-reference), so without
// this a user who typed plain `claude` sees nothing and concludes the plugin is broken; and the channel's own word
// that gh is missing or signed out is one of those dropped events, which is why the setup checks are made here. The
// signal for the channel is the claude process's own flags (hooks/launch.mjs). The hook is silent in `claude -p`
// (which ignores the flag anyway: scripts and other headless runs get no noise), and after /clear or /compact, which
// are not launches: no check is even run then. Where the flags cannot be read (no `ps`), the channel line is
// conditional, never a claim.
//
// Every path exits 0 and prints JSON or nothing. Dependency-free plain JavaScript, Node 20. It is run through
// hooks/node.sh, which says so when there is no Node.js to run it.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { claudeGhForOffer } from "../skills/setup-github/claude-gh.mjs";
import { SESSION_ID, channelFlags, findLaunch, relaunchSentence, shellWord } from "./launch.mjs";
import { setupFor } from "./readiness.mjs";

const LAUNCHES = new Set(["startup", "resume", "fork"]);

export const OFFER_QUESTION =
  "Set up `claude-gh` so live CI events are on whenever you start Claude Code with it? It starts Claude Code with " +
  "its development flag for channels, which shows a confirmation screen at every launch; `claude` itself is unchanged.";

/** Whether this start is a launch with a person at it: not /clear or /compact, and not a headless run. */
export function isLaunch(input, launch) {
  if (!input || typeof input !== "object") return false;
  if (!LAUNCHES.has(input.source ?? "startup")) return false;
  return Boolean(launch) && launch.state !== "headless";
}

/**
 * The hook's output, or null. `launch` is findLaunch()'s answer; `pluginRoot` is CLAUDE_PLUGIN_ROOT;
 * `claudeGh` is claudeGhForOffer()'s answer (null: cannot tell, or turned off, so no offer); `setup` is the setup
 * checks' answer (readiness.mjs setupFor: a line for the user and the context for Claude, or null on a ready machine).
 * A setup problem comes first: it is why nothing else would work.
 */
export function noticeFor(input, launch, pluginRoot, { claudeGh = null, setup = null } = {}) {
  if (!isLaunch(input, launch)) return null;

  const id = typeof input.session_id === "string" && SESSION_ID.test(input.session_id) ? input.session_id : null;
  const resume = id ? `--resume ${id}` : "--continue";
  let line = null;
  if (launch.state === "off" || launch.state === "unknown") {
    const plain = ["claude", resume, ...channelFlags(pluginRoot)].join(" ");
    // The one relaunch sentence (launch.mjs relaunchSentence), then the plain command for a user with no claude-gh.
    const relaunch =
      `${relaunchSentence(id)} (/runners-io:setup-github sets up claude-gh and makes this permanent) ` +
      `or \`${plain}\`. CI checks on request (ci_status) still work.`;
    line =
      launch.state === "off"
        ? `runners.io: live CI events are OFF in this session (it was started without the channel flag): ${relaunch}`
        : `runners.io: if this session was not started with the channel flag, live CI events are off: ${relaunch}`;
  }
  const offer =
    claudeGh === false
      ? "runners.io plugin: this user has no `claude-gh` command, which starts Claude Code with the plugin's live CI " +
        "events on. Once in this session, early and at a natural moment (never in the middle of a task), ask the " +
        `user exactly: "${OFFER_QUESTION}" If they say yes, follow the /runners-io:setup-github skill's step 5 (show ` +
        "the lines, ask, add them, check with type)" +
        (line ? `, then tell them to ${relaunchSentence(id)} for live CI events` : "") +
        ". If they say no, " +
        (pluginRoot
          ? `run \`node ${shellWord(`${pluginRoot}/skills/setup-github/claude-gh.mjs`)} decline\`, which records it so the offer is not made again for 7 days, `
          : "") +
        "do not ask again in this session and do not mention it again."
      : null;
  if (!line && !offer && !setup) return null;
  const context = [setup?.context, line && `${line} The user has been shown this line. Do not repeat it unless they ask why CI events are not arriving.`, offer]
    .filter(Boolean)
    .join("\n\n");
  const shown = [setup?.line, line].filter(Boolean);
  return {
    ...(shown.length ? { systemMessage: shown.join("\n") } : {}),
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  };
}

/** The setup checks are local and take well under a second; past this they are given up on, inside the hook's 10 s. */
const SETUP_LIMIT_MS = 5000;

function within(ms, promise) {
  return new Promise((resolve) => {
    // Not unref'd: checks that hang hold nothing open, and the hook must still answer when the limit passes.
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Everything the hook does for one start, or null when it has nothing to say. Nothing is run for a start that is
 * not a launch with a person at it. The claude-gh question and the setup checks run side by side; either failing
 * or running out of time leaves the other's answer standing.
 */
export async function hookOutput(input, { env = process.env, launch = findLaunch(process.ppid), platform = process.platform, claudeGhFor = claudeGhForOffer, setup = setupFor, setupLimitMs = SETUP_LIMIT_MS } = {}) {
  if (!isLaunch(input, launch)) return null;
  const [claudeGh, found] = await Promise.all([
    Promise.resolve()
      .then(() => claudeGhFor(env))
      .catch(() => null),
    within(setupLimitMs, Promise.resolve().then(() => setup(input, env, { platform }))),
  ]);
  return noticeFor(input, launch, env.CLAUDE_PLUGIN_ROOT, { claudeGh, setup: found });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      data += d;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const out = await hookOutput(input);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
