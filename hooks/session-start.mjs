#!/usr/bin/env node
// SessionStart hook: when this session was launched without the runners-io channel flag, tell the user, once per
// launch, how to relaunch it with live CI events on.
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

import { channelFlags, findLaunch } from "./launch.mjs";

const LAUNCHES = new Set(["startup", "resume", "fork"]);
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The line to show, or null. `launch` is findLaunch()'s answer; `pluginRoot` is CLAUDE_PLUGIN_ROOT. */
export function noticeFor(input, launch, pluginRoot) {
  if (!input || typeof input !== "object") return null;
  if (!LAUNCHES.has(input.source ?? "startup")) return null;
  if (launch?.state !== "off" && launch?.state !== "unknown") return null;

  const id = typeof input.session_id === "string" && SESSION_ID.test(input.session_id) ? input.session_id : null;
  const resume = id ? `--resume ${id}` : "--continue";
  const plain = ["claude", resume, ...channelFlags(pluginRoot)].join(" ");
  const relaunch =
    `relaunch with \`claude-gh ${resume}\` (/runners-io:setup-github sets up claude-gh and makes this permanent) ` +
    `or \`${plain}\`. CI checks on request (ci_status) still work.`;
  const line =
    launch.state === "off"
      ? `runners.io: live CI events are OFF in this session (it was started without the channel flag): ${relaunch}`
      : `runners.io: if this session was not started with the channel flag, live CI events are off: ${relaunch}`;
  return {
    systemMessage: line,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `${line} The user has been shown this line. Do not repeat it unless they ask why CI events are not arriving.`,
    },
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
  const out = noticeFor(input, findLaunch(process.ppid), process.env.CLAUDE_PLUGIN_ROOT);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
