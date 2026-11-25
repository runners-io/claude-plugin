/**
 * runners-io-channel: the runners.io CI channel for Claude Code.
 *
 *   runners-io-channel            the stdio MCP channel server Claude Code starts
 *   runners-io-channel status     the GitHub login, repository, branch and pull request it would watch
 *   runners-io-channel version
 *
 * It reads GitHub directly with the user's own `gh` login, so it needs no runners.io account and sends nothing to
 * runners.io. Bundled to one file (dist/runners-io-channel.mjs) for Node 20
 * or later, so the plugin installs nothing at run time.
 */
import { removeRequests, resetRequests, takeRequests } from "./hookrequests.ts";
import { SharedStore, defaultSharedRoot } from "./shared.ts";
import { loadConfig } from "./config.ts";
import { inOwnHistory, readGitScope, readPushed } from "./git.ts";
import { GitHubClient, readGhAuth } from "./github.ts";
import { log } from "./log.ts";
import { startMcp } from "./mcp.ts";
import { runPoller } from "./poller.ts";
import { Subscriptions } from "./subscriptions.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { makeTools } from "./tools.ts";
import { NO_EVENT_LOG, openEventLog } from "./eventlog.ts";
import { findLaunch, pollsIn } from "../../hooks/launch.mjs";

export const VERSION = "0.3.12";

function serve(): void {
  const config = loadConfig();
  const gh = new GitHubClient(config.githubApi, () => readGhAuth(process.env, undefined, config.githubApi), fetch, {
    shared: new SharedStore(defaultSharedRoot()),
  });
  const subs = new Subscriptions();
  const readScope = () => readGitScope(config.projectDir);
  const stop = new AbortController();
  const eventLog = config.eventLogDir
    ? openEventLog(config.eventLogDir, { session: `${process.pid}-${Date.now().toString(36)}`, project: config.projectDir })
    : NO_EVENT_LOG;
  // Launched without the channel flag, Claude Code drops every event silently (channels-reference), so the
  // poller would spend the user's rate limit on nothing. The tools still answer; the SessionStart hook tells
  // the user how to relaunch.
  const launch = findLaunch(process.ppid).state;
  // The hook's hand-over folder for this Claude process: emptied now and removed at exit, because a pid is reused and a
  // later session must not take an earlier one's requests.
  resetRequests(defaultSharedRoot(), process.ppid);
  process.on("exit", () => removeRequests(defaultSharedRoot(), process.ppid));
  const liveEvents = pollsIn(launch);
  eventLog.write("start", {
    launch,
    version: VERSION,
    claude_pid: process.ppid,
    poll_seconds: config.pollSeconds,
    auto_subscribe: config.autoSubscribe,
    rate_floor: config.rateFloor,
  });
  const server = startMcp({
    input: process.stdin,
    output: process.stdout,
    name: "runners-io",
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: makeTools({ subs, gh, readScope, eventLog, liveEvents }),
    onReady: () => {
      if (!liveEvents) {
        if (launch === "off") eventLog.write("channel_inactive", { launch });
        log(`this session cannot receive channel events (${launch}): not polling GitHub; the tools still answer`);
        return;
      }
      runPoller({
        config,
        gh,
        subs,
        readScope,
        notify: (m) => server.notify(m),
        signal: stop.signal,
        eventLog,
        inOwnHistory: (sha) => inOwnHistory(config.projectDir, sha),
        readPushed: (branches) => readPushed(config.projectDir, branches),
        // The PostToolUse hook's hand-over; this process's parent is the Claude process the hook finds.
        takeHookRequests: () => takeRequests(defaultSharedRoot(), process.ppid),
      }).catch((error) => {
        log(`the poller stopped: ${(error as Error).message}`);
        eventLog.write("stop", { reason: "poller_error", error: (error as Error).message });
        process.exit(1);
      });
    },
    onClose: () => {
      eventLog.write("stop", { reason: "closed" });
      stop.abort();
      process.exit(0);
    },
  });
  log(
    `started ${VERSION}; GitHub API ${config.githubApi}; automatic subscription: ${config.autoSubscribe}; ` +
      `event log: ${config.eventLogDir ?? "off"}`,
  );
}

async function status(): Promise<void> {
  const config = loadConfig();
  const auth = await readGhAuth(process.env, undefined, config.githubApi);
  const scope = await readGitScope(config.projectDir);
  const login =
    auth.kind === "ok"
      ? `signed in to GitHub (token from ${auth.source === "gh" ? "gh auth token" : "GH_TOKEN/GITHUB_TOKEN"})`
      : auth.kind === "not_installed"
        ? "the GitHub CLI (gh) is not installed"
        : "gh is not signed in to github.com";
  let pr = "none";
  if (auth.kind === "ok" && scope.repo && scope.branch) {
    const found = await new GitHubClient(config.githubApi, async () => auth).findOpenPull(scope.repo, scope.branch);
    pr = found.kind === "ok" ? (found.value === null ? "no open pull request" : `#${found.value}`) : `could not ask GitHub (${found.kind})`;
  }
  process.stdout.write(
    `runners-io-channel ${VERSION}\n${login}\nrepository: ${scope.repo ?? "none"}, branch: ${scope.branch ?? "none"}, pull request: ${pr}\n` +
      `automatic subscription: ${config.autoSubscribe}, every ${config.pollSeconds} s; event log: ${config.eventLogDir ?? "off"}\n`,
  );
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "serve";
  switch (command) {
    case "serve":
      serve();
      return;
    case "status":
      await status();
      return;
    case "--version":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      process.stderr.write(`unknown command: ${command}. Commands: status, version.\n`);
      process.exit(64);
  }
}

main(process.argv.slice(2)).catch((error) => {
  log((error as Error).message);
  process.exit(1);
});
