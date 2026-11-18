#!/usr/bin/env node
// SessionStart hook, at every launch:
//   - when this session was launched without the runners-io channel flag, tell the user how to relaunch it with
//     live CI events on;
//   - when the user has no `claude-gh` command, have Claude offer to set it up. Asked again at every launch while
//     it is missing, whatever the user answered before: nothing records a no. RUNNERS_IO_NO_CLAUDE_GH_OFFER=1
//     turns the offer off for good.
//
// Claude Code drops a channel's events silently in a session that did not opt in (channels-reference), so without
// this a user who typed plain `claude` sees nothing and concludes the plugin is broken. The signal is the claude
// process's own flags (hooks/launch.mjs). It is silent when the channel is on, in `claude -p` (which ignores the
// flag anyway: scripts and other headless runs get no noise), and after /clear or /compact, which are not
// launches. Where the flags cannot be read (no `ps`), the line is conditional, never a claim.
//
// Every path exits 0 and prints JSON or nothing. Dependency-free plain JavaScript, Node 20.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { claudeGhForOffer } from "../skills/setup-github/claude-gh.mjs";
import { channelFlags, findLaunch } from "./launch.mjs";

const LAUNCHES = new Set(["startup", "resume", "fork"]);
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export const OFFER_QUESTION = "Set up `claude-gh` so live CI events are on whenever you start Claude Code with it?";

/**
 * The hook's output, or null. `launch` is findLaunch()'s answer; `pluginRoot` is CLAUDE_PLUGIN_ROOT;
 * `claudeGh` is claudeGhForOffer()'s answer (null: cannot tell, or turned off, so no offer).
 */
export function noticeFor(input, launch, pluginRoot, { claudeGh = null } = {}) {
  if (!input || typeof input !== "object") return null;
  if (!LAUNCHES.has(input.source ?? "startup")) return null;
  if (launch?.state === "headless" || !launch) return null;

  const id = typeof input.session_id === "string" && SESSION_ID.test(input.session_id) ? input.session_id : null;
  const resume = id ? `--resume ${id}` : "--continue";
  let line = null;
  if (launch.state === "off" || launch.state === "unknown") {
    const plain = ["claude", resume, ...channelFlags(pluginRoot)].join(" ");
    const relaunch =
      `relaunch with \`claude-gh ${resume}\` (/runners-io:setup-github sets up claude-gh and makes this permanent) ` +
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
        (line ? `, then tell them to relaunch this session with \`claude-gh ${resume}\` for live CI events` : "") +
        ". If they say no, do not ask again in this session and do not mention it again."
      : null;
  if (!line && !offer) return null;
  const context = [line && `${line} The user has been shown this line. Do not repeat it unless they ask why CI events are not arriving.`, offer]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(line ? { systemMessage: line } : {}),
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  };
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
  let claudeGh = null;
  try {
    claudeGh = await claudeGhForOffer(process.env);
  } catch {}
  const out = noticeFor(input, findLaunch(process.ppid), process.env.CLAUDE_PLUGIN_ROOT, { claudeGh });
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
