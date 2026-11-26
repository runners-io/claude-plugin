#!/usr/bin/env node
// SessionStart hook, at every launch:
//   - when the machine is missing something the plugin needs (the GitHub CLI, its login, git, a writable data
//     folder, ...), tell the user in one line and give Claude the fix to offer, asking first (readiness.mjs: the
//     setup checks). A machine that is ready adds nothing. RUNNERS_IO_NO_SETUP_CHECKS=1 turns the offers off;
//   - when this session was launched without the runners-io channel flag, tell the user how to relaunch it with
//     live CI events on;
//   - once after an install, and once more when the plugin's version changes, tell runners.io that this version is
//     installed (telemetry.mjs: the install ping, what it holds and how it is turned off). Sent while the checks
//     run, with a 2-second limit, and never again whether or not it arrived;
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
// conditional, never a claim. And where Claude Code cannot deliver channel events at all (on Amazon Bedrock, Google
// Cloud or Microsoft Foundry), the relaunch line and the claude-gh offer are left out: the setup checks say why.
//
// Every path exits 0 and prints JSON or nothing. Dependency-free plain JavaScript, Node 20. It is run through
// hooks/node.sh, which says so when there is no Node.js to run it.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { claudeGhForOffer } from "../skills/setup-github/claude-gh.mjs";
import { SESSION_ID, channelFlags, findLaunch, relaunchSentence, shellWord } from "./launch.mjs";
import { liveEventsBlocker, setupFor } from "./readiness.mjs";
import { needsTunnel, runHook } from "./telemetry.mjs";

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
 * A setup problem comes first: it is why nothing else would work. `liveEventsUnavailable`: Claude Code cannot deliver
 * channel events here whatever flag it is started with (readiness.mjs liveEventsBlocker), so neither the relaunch line
 * nor the claude-gh offer is made: both would send the user after something that cannot work. The setup checks say so.
 */
export function noticeFor(input, launch, pluginRoot, { claudeGh = null, setup = null, liveEventsUnavailable = false } = {}) {
  if (!isLaunch(input, launch)) return null;
  if (liveEventsUnavailable) {
    if (!setup) return null;
    return {
      ...(setup.line ? { systemMessage: setup.line } : {}),
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: setup.context },
    };
  }

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
export async function hookOutput(input, { env = process.env, launch = findLaunch(process.ppid), platform = process.platform, claudeGhFor = claudeGhForOffer, setup = setupFor, setupLimitMs = SETUP_LIMIT_MS, telemetry = null } = {}) {
  if (!isLaunch(input, launch)) return null;
  // The install ping: only at a launch with a person at it (a script's headless runs are not installs), started before
  // the checks so that it reads the state folder as the last launch left it, and sent while they run. Nothing here
  // waits for it: whoever runs the hook gives it its 2 seconds once the hook's answer is written (runHook). Behind a
  // company proxy that only the channel can go through, the channel sends it instead.
  if (telemetry && !needsTunnel(env)) void telemetry.ping();
  const [claudeGh, found] = await Promise.all([
    Promise.resolve()
      .then(() => claudeGhFor(env))
      .catch(() => null),
    within(setupLimitMs, Promise.resolve().then(() => setup(input, env, { platform, launchState: launch.state }))),
  ]);
  return noticeFor(input, launch, env.CLAUDE_PLUGIN_ROOT, { claudeGh, setup: found, liveEventsUnavailable: liveEventsBlocker(env) !== null });
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

async function main(telemetry) {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const out = await hookOutput(input, { telemetry });
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  // Ends with status 0 whatever happened. A failure nothing caught is reported as the plugin's own fault first, unless
  // it is the machine's (telemetry.mjs: the deny-list).
  void runHook("hook:session-start", main);
}
