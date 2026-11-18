/**
 * The channel's settings, all from the environment Claude Code gives the
 * subprocess (plugin.json `mcpServers.runners-io.env`). None of them is a
 * secret: the GitHub token is read from `gh auth token` at run time and kept
 * in memory (github.ts), never in argv, env set by the plugin, or a file.
 */
import { isAbsolute } from "node:path";

export type AutoSubscribe = "pr" | "off";

export interface Config {
  /** GitHub's REST API, `https://api.github.com`. A test points it at a loopback fake. */
  readonly githubApi: string;
  /** Where the session's repository is. Claude Code exports CLAUDE_PROJECT_DIR to a plugin's stdio server. */
  readonly projectDir: string;
  /** `pr` (default): watch the current branch's pull request without being asked. `off`: only what Claude subscribes to. */
  readonly autoSubscribe: AutoSubscribe;
  /** Seconds between looks at GitHub, 5 to 300. */
  readonly pollSeconds: number;
  /** RUNNERS_IO_EVENT_LOG_DIR: where the event log (eventlog.ts) goes. Null, the default, writes none. */
  readonly eventLogDir: string | null;
  /**
   * RUNNERS_IO_RATE_FLOOR: below this many GitHub requests left in the hour, the channel looks four times
   * less often. 200 by default; raise it when the same gh login also drives other tools.
   */
  readonly rateFloor: number;
  /**
   * RUNNERS_IO_REVIEW_REQUESTS=on: hear review.requested when somebody asks this GitHub login (or one of its
   * teams) to review a pull request (requests.ts). Off by default: every session with it on hears every request.
   */
  readonly reviewRequests?: boolean;
}

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** This machine's own addresses: whatever process listens there could read a token sent to it. */
export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/** The plugin's own tests point it at a fake GitHub on this machine; nothing else may. */
export function fakeGitHubAllowed(env: Env): boolean {
  return env.RUNNERS_IO_TEST_FAKE_GITHUB === "1";
}

/**
 * A token is only ever sent over https, and never to this machine, where any local process could be listening,
 * unless RUNNERS_IO_TEST_FAKE_GITHUB=1 (the tests' fake GitHub, which may use plain http). Anything else is refused at
 * start, not at the first request, so a typo cannot leak a token in clear text.
 */
export function checkTokenUrl(raw: string, what: string, env: Env = process.env): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL: ${raw}`);
  }
  if (isLoopback(url.hostname)) {
    if (fakeGitHubAllowed(env) && (url.protocol === "https:" || url.protocol === "http:")) return raw.replace(/\/+$/, "");
    throw new Error(`${what} may name this machine only in the plugin's own tests (RUNNERS_IO_TEST_FAKE_GITHUB=1): ${raw}`);
  }
  if (url.protocol === "https:") return raw.replace(/\/+$/, "");
  throw new Error(`${what} must be https: ${raw}`);
}

function parseAuto(raw: string | undefined): AutoSubscribe {
  // An unset plugin option arrives as the literal `${user_config.auto_subscribe}`
  // on some Claude Code versions; anything not recognised is the default.
  return (raw ?? "").trim().toLowerCase() === "off" ? "off" : "pr";
}

export function loadConfig(env: Env = process.env): Config {
  const poll = Number(env.RUNNERS_IO_POLL_SECONDS ?? "20");
  return {
    githubApi: checkTokenUrl(env.RUNNERS_IO_GITHUB_API || "https://api.github.com", "RUNNERS_IO_GITHUB_API", env),
    projectDir: env.CLAUDE_PROJECT_DIR || process.cwd(),
    autoSubscribe: parseAuto(env.RUNNERS_IO_AUTO_SUBSCRIBE),
    pollSeconds: Number.isFinite(poll) ? Math.max(5, Math.min(300, Math.floor(poll))) : 20,
    eventLogDir: isAbsolute(env.RUNNERS_IO_EVENT_LOG_DIR ?? "") ? (env.RUNNERS_IO_EVENT_LOG_DIR as string) : null,
    rateFloor: parseFloor(env.RUNNERS_IO_RATE_FLOOR),
    // An unset plugin option arrives as the literal `${user_config.review_requests}`: anything but "on" is off.
    reviewRequests: (env.RUNNERS_IO_REVIEW_REQUESTS ?? "").trim().toLowerCase() === "on",
  };
}

function parseFloor(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return 200;
  return Math.max(0, Math.min(5000, Math.floor(n)));
}

