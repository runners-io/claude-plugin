/**
 * runners-io-channel: the runners.io CI channel for Claude Code.
 *
 *   runners-io-channel            the stdio MCP channel server Claude Code starts
 *   runners-io-channel status     the GitHub login, repository, branch and pull request it would watch, and every
 *                                 setup check as ready or NOT READY, with one live GitHub call (the doctor skill)
 *   runners-io-channel version
 *   runners-io-channel telemetry-test   sends one report of a fault made on purpose, and says whether it was sent
 *   (status and telemetry-test take --telemetry-setting <on|off>: the plugin's own setting, as the doctor skill passes it)
 *
 * It reads GitHub directly with the user's own `gh` login, so it needs no runners.io account. Two things are sent to
 * runners.io and nothing else: a ping when the plugin is installed or updated, and a report when the plugin's own code
 * fails (hooks/telemetry.mjs: what each holds, and how to turn both off). Bundled to one file (dist/runners-io-channel.mjs) for Node 20
 * or later, so the plugin installs nothing at run time.
 */
import { removeRequests, resetRequests, takeRequests } from "./hookrequests.ts";
import { SharedStore, defaultSharedRoot } from "./shared.ts";
import { apiHost, fakeGitHubAllowed, loadConfig } from "./config.ts";
import { channelRow, liveRow } from "./doctor.ts";
import { setTelemetry } from "./faults.ts";
import { FirstCallRecorder } from "./firstcall.ts";
import { ForkParents, findBranchPull } from "./forks.ts";
import { inOwnHistory, readGitScope, readPushed } from "./git.ts";
import { GitHubClient, readGhAuth } from "./github.ts";
import { log } from "./log.ts";
import { startMcp } from "./mcp.ts";
import { runPoller } from "./poller.ts";
import { githubFetch, proxyNote } from "./proxy.ts";
import { ScopeStore, defaultScopeRoot, scopeFile } from "./scopes.ts";
import { Subscriptions } from "./subscriptions.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { TOOL_NAMES, makeTools } from "./tools.ts";
import { NO_EVENT_LOG, openEventLog } from "./eventlog.ts";
import { findLaunch, pollsIn } from "../../hooks/launch.mjs";
import { firstCallRows, launchChecks, liveEventsBlocker, mergeRows, readFirstCall, renderTable } from "../../hooks/readiness.mjs";
import { SETTING_ENV, createTelemetry, needsTunnel, telemetryLine } from "../../hooks/telemetry.mjs";

export const VERSION = "0.4.2";

/**
 * What the channel sends to runners.io (hooks/telemetry.mjs): reports of its own faults, and the install ping where
 * the launch hook cannot send it. Through a company proxy as the GitHub requests go (proxy.ts). With telemetry off, or
 * under the tests, every call on it does nothing.
 */
const telemetry = createTelemetry({ component: "channel", version: VERSION, fetch: githubFetch(process.env) });
setTelemetry(telemetry);

let ending = false;

/**
 * A failure nothing caught ends the process with status 1, as it always has. First it is reported as the channel's own
 * fault, unless it is the machine's or GitHub's (the deny-list), with the send's 2 seconds at most.
 */
function fatal(error: unknown, component = "channel"): void {
  if (ending) return;
  ending = true;
  void telemetry.report(error, { component }).finally(() => process.exit(1));
}

process.on("uncaughtException", (error) => {
  log(`uncaught: ${(error as Error)?.message ?? "an error with no message"}`);
  fatal(error);
});
process.on("unhandledRejection", (error) => {
  log(`unhandled: ${(error as Error)?.message ?? "a rejection with no message"}`);
  fatal(error);
});

/**
 * Notes what GitHub answers, for the next launch's setup checks (firstcall.ts). Not under the tests' fake GitHub
 * unless the test names a state folder of its own: a fake's refusals must never be filed as this user's.
 */
function firstCallRecorder(projectDir: string): FirstCallRecorder | null {
  if (fakeGitHubAllowed(process.env) && !process.env.XDG_STATE_HOME) return null;
  return new FirstCallRecorder(process.env, projectDir);
}

function serve(): void {
  const config = loadConfig();
  const firstCall = firstCallRecorder(config.projectDir);
  // Behind a company proxy (HTTPS_PROXY), GitHub is asked through it; with none set this is Node's own fetch (proxy.ts).
  const gh = new GitHubClient(config.githubApi, () => readGhAuth(process.env, undefined, config.githubApi), githubFetch(process.env), {
    shared: new SharedStore(defaultSharedRoot()),
    observe: (o) => firstCall?.observe(o),
  });
  const subs = new Subscriptions();
  // Which repository the clone was forked from: one answer for the poller and the tools (forks.ts).
  const parents = new ForkParents(gh);
  // This project's repository scopes (scopes.ts): the one choice kept beyond the session, in the plugin's own data
  // folder. The tools set and end them; the poller holds their pull requests.
  const scopes = new ScopeStore(scopeFile(defaultScopeRoot(), config.projectDir));
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
    tools: makeTools({ subs, gh, readScope, eventLog, liveEvents, scopes, parents }),
    // A tool that threw instead of answering, or a message that could not be answered: the client has been told; this
    // reports it as the channel's own fault. The tool's name is sent only when it is one of the channel's own.
    onFault: (error, tool) => {
      const component = tool === null ? "channel:mcp" : (TOOL_NAMES as readonly string[]).includes(tool) ? `tool:${tool}` : "tool:unknown";
      void telemetry.report(error, { component });
    },
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
        scopes,
        parents,
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
        fatal(error, "channel:poller");
      });
    },
    onClose: () => {
      eventLog.write("stop", { reason: "closed" });
      stop.abort();
      process.exit(0);
    },
  });
  log(
    `started ${VERSION}; GitHub API host ${apiHost(config.githubApi)}; automatic subscription: ${config.autoSubscribe}; ` +
      `event log: ${config.eventLogDir ?? "off"}`,
  );
  const proxy = proxyNote(process.env, config.githubApi);
  if (proxy) log(proxy);
  // The install ping is the launch hook's to send. Behind a company proxy the hook cannot go through, it is sent
  // from here, where the request can (the same once-only claim, so never both). Never in a headless run.
  if (launch !== "headless" && needsTunnel(process.env)) void telemetry.ping();
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
  const firstCall = firstCallRecorder(config.projectDir);
  const client = new GitHubClient(config.githubApi, async () => auth, githubFetch(process.env), { observe: (o) => firstCall?.observe(o) });
  const checks = { env: process.env, projectDir: config.projectDir };
  const launch = findLaunch(process.ppid).state;
  const local = await launchChecks({ ...checks, launchState: launch });
  // The checks' one live call, made first: its answer also says whether the repository is a fork, so finding the
  // branch's pull request below does not ask GitHub the same thing again.
  const parents = new ForkParents(client);
  const live = auth.kind === "ok" ? [await liveRow(client, scope.repo, firstCall, parents)] : [];
  let pr = "none";
  // Found as the automatic watch finds it: in a fork, on the repository it was forked from first (forks.ts).
  if (auth.kind === "ok" && scope.repo && scope.branch) {
    const found = await findBranchPull(client, { repo: scope.repo, branch: scope.branch, upstream: scope.upstream }, parents);
    const where = found.kind === "ok" && found.value && found.value.repo.toLowerCase() !== scope.repo.toLowerCase() ? ` on ${found.value.repo} (this clone is a fork of it)` : "";
    pr = found.kind === "ok" ? (found.value === null ? "no open pull request" : `#${found.value.pr}${where}`) : `could not ask GitHub (${found.kind})`;
  }
  const rows = mergeRows(local, live, firstCallRows(readFirstCall(process.env), checks), [channelRow(launch, liveEventsBlocker(process.env)?.provider ?? null)]);
  process.stdout.write(
    `runners-io-channel ${VERSION}\n${login}\nrepository: ${scope.repo ?? "none"}, branch: ${scope.branch ?? "none"}, pull request: ${pr}\n` +
      `automatic subscription: ${config.autoSubscribe}, every ${config.pollSeconds} s; event log: ${config.eventLogDir ?? "off"}\n` +
      `${telemetryLine(process.env)}\n` +
      `setup checks (/runners-io:doctor):\n${renderTable(rows)}\n`,
  );
}

/**
 * `--telemetry-setting <on|off>`, taken out of a command's arguments: the plugin's own telemetry setting, as the doctor
 * skill passes it. A command Claude runs for a skill gets none of the plugin's settings in its environment, so without
 * this `status` would say telemetry is on in a session whose hooks and channel have it off. The skill's reference
 * arrives unreplaced when nobody saved the setting: that, and any other word, changes nothing.
 */
export function takeTelemetrySetting(argv: string[], env: Record<string, string | undefined> = process.env): string[] {
  const at = argv.indexOf("--telemetry-setting");
  if (at < 0) return argv;
  const value = (argv[at + 1] ?? "").trim().toLowerCase();
  if (value === "on" || value === "off") env[SETTING_ENV] = value;
  return [...argv.slice(0, at), ...argv.slice(at + 2)];
}

async function main(args: string[]): Promise<void> {
  const argv = takeTelemetrySetting(args);
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
    case "telemetry-test": {
      // One report of a fault made on purpose, inside the same limits as a real one (once a day), so that somebody
      // checking what the plugin sends, or that it arrives, has something to look at.
      const word = await telemetry.internalError("telemetry_self_test");
      process.stdout.write(`${telemetryLine(process.env)}\ntest report: ${word}\n`);
      return;
    }
    default:
      process.stderr.write(`unknown command: ${command}. Commands: status, version, telemetry-test.\n`);
      process.exit(64);
  }
}

main(process.argv.slice(2)).catch((error) => {
  log((error as Error).message);
  fatal(error);
});
