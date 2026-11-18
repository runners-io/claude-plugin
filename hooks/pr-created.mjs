#!/usr/bin/env node
// PostToolUse hook: after Claude opens a pull request, prompt it to subscribe
// the runners-io channel to that PR.
//
// It PROMPTS, it does not subscribe: the subscribe tool stays the one path, so
// Claude decides, and the hook needs no line to the channel process.
//
// It never blocks anything: every path exits 0, and it prints nothing unless
// it found the PR it is talking about. Dependency-free plain JavaScript, so it
// runs on Node 20 with nothing installed.
//
// Input (stdin): Claude Code's PostToolUse JSON. It acts on
//   - a Bash call whose command runs `gh pr create`, reading the PR URL gh prints;
//   - an MCP tool named like `create_pull_request` (the GitHub MCP server), reading the URL in its result.
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)\/pull\/(\d{1,9})(?![\d])/;
const GH_PR_CREATE = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;
const CREATE_TOOL = /^mcp__.+__create_pull_request$/;

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

function text(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function contextFor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  let haystack = "";
  if (tool === "Bash") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (!GH_PR_CREATE.test(command)) return null;
    const res = input.tool_response;
    haystack = typeof res?.stdout === "string" ? res.stdout : text(res);
  } else if (CREATE_TOOL.test(tool)) {
    haystack = text(input.tool_response);
  } else {
    return null;
  }
  const m = PR_URL.exec(haystack);
  if (!m) return null;
  const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  const pr = Number(m[3]);
  if (!Number.isSafeInteger(pr) || pr < 1) return null;
  return (
    `You opened ${repo} PR #${pr}. To have its CI results (workflows starting, passing, failing or waiting for approval) ` +
    "and merge conflicts pushed into this session, call the runners-io channel's subscribe tool " +
    `(mcp__plugin_runners-io_runners-io__subscribe) with repo="${repo}" pr=${pr}. ` +
    'Results arrive as <channel source="runners-io"> events if this session was started with the runners-io channel; ' +
    "if none arrive, call ci_status to check."
  );
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const context = contextFor(input);
  if (!context) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } })}\n`);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
