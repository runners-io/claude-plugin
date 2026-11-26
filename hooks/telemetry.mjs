// The two messages the plugin sends to runners.io, and everything that decides whether one is sent.
//
//   1. AN INSTALL PING: once after an install, and once more when the plugin's version changes.
//   2. A REPORT OF THE PLUGIN'S OWN FAULT: an exception nothing caught in the channel or a hook, a tool that threw
//      instead of answering, or one of the plugin's own consistency checks failing (internalError).
//
// Both go to ONE address, https://www.runners.io/api/plugin/telemetry, as a fixed set of fields under 1 KB. Each is
// sent once with a 2-second limit: a send that fails is dropped, never retried, and nothing waits on its answer for
// longer than that.
//
// WHAT A MESSAGE HOLDS, IN FULL (README, "What is sent"):
//   both       kind, install_id (a random UUID made on this machine, tied to nothing), version, os, node_major
//   a ping     previous_version, when a version was replaced
//   a report   component (channel, hook:session-start, tool:ci_status), error_name (TypeError), fingerprint (16 hex
//              characters), frames (at most 8 lines, `function file.mjs:line:column` for the plugin's own files and
//              `<external>` for everything else), and code when one of the plugin's own checks failed
//
// WHAT IT NEVER HOLDS: the error's message (it can quote a repository, a path or a token), a path (a frame keeps the
// file's base name only, and only for the plugin's own files), a user or machine name, the session's folder, a
// repository, branch or pull request, a GitHub login, a token, an environment variable, or anything from the event log.
// Nothing here reads any of those, so there is nothing to strip: a message is built from the list above and nothing else.
//
// THE PLUGIN'S OWN FAULTS ONLY, CHECKED TWICE. A report is raised only where nothing handled the failure (the top-level
// handlers and internalError). And `denied` below is checked just before sending: GitHub answering with a status, the
// network, a proxy, TLS, git, gh and the file system failing, and a setting that is wrong, are this machine's or
// GitHub's and are never sent, even when one is thrown. So is a failure whose stack never passes through the plugin.
//
// HOW OFTEN: a ping once per version; a fault once per version per UTC day; at most 5 reports per UTC day from one
// install, whatever fails. Each is claimed by making a file that can be made only once (O_EXCL), so two sessions
// started together cannot both send. Where the plugin's state folder cannot be written nothing is sent at all, rather
// than something at every launch.
//
// TO TURN IT OFF: RUNNERS_IO_TELEMETRY=off or DO_NOT_TRACK=1 in the environment Claude Code runs in. Claude Code's own
// DISABLE_TELEMETRY and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC are honoured too, where they reach the plugin.
//
// THE ADDRESS CANNOT BE REPOINTED. It is the constant below. The plugin's own tests name a listener of their own with
// RUNNERS_IO_TEST_TELEMETRY_URL, which is accepted only as plain http on 127.0.0.1 (this machine); any other value
// sends nothing. And under the tests (node --test, or the tests' fake GitHub) nothing is sent unless that is set.
//
// An answer of 410 Gone means "this version must stop": nothing is sent from it for 7 days (and its install ping, if
// that is what was answered, is never sent again). 429 and every other answer are dropped without a word.
//
// Dependency-free plain JavaScript, Node 20: the hooks run it as it is, and the channel's bundle carries a copy.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeProxiesItself, proxyFor } from "./proxy.mjs";
import { stateRoot } from "./readiness.mjs";

/** The one address a message is sent to. */
export const TELEMETRY_URL = "https://www.runners.io/api/plugin/telemetry";
/** The plugin's own tests only: a listener on 127.0.0.1 to send to in place of TELEMETRY_URL. */
export const TEST_URL_ENV = "RUNNERS_IO_TEST_TELEMETRY_URL";
export const SEND_TIMEOUT_MS = 2000;
export const MAX_BODY_BYTES = 1024;
export const MAX_FRAMES = 8;
/** Reports of the plugin's own faults one install sends in a UTC day, at most. */
export const MAX_REPORTS_PER_DAY = 5;
/** After the endpoint answers 410 Gone, this version sends nothing for this long. */
export const GONE_FOR_MS = 7 * 24 * 60 * 60_000;

/** The plugin's own consistency checks: the only codes internalError sends. */
export const INTERNAL_CODES = Object.freeze([
  // A subscribe that found room left the session watching more pull requests than it may (channel/src/tools.ts).
  "watch_cap_exceeded",
  // A scope worked out that it leaves out fewer than no pull requests, or holds more than the session may (poller.ts).
  "scope_holdings_negative",
  "scope_holdings_over_cap",
  // `runners-io-channel telemetry-test`: a report made on purpose, to see one arrive.
  "telemetry_self_test",
]);

const VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,23}(:[a-z][a-z0-9_-]{0,39})?$/;
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FUNCTION_NAME = /^[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79}$/;
const OWN_FILE = /^[a-z0-9][a-z0-9.-]{0,59}\.mjs$/;
const FRAME = /^[A-Za-z_$<][A-Za-z0-9_$.<>]{0,79} [a-z0-9][a-z0-9.-]{0,59}\.mjs:[1-9][0-9]{0,6}:[1-9][0-9]{0,5}$/;
const EXTERNAL = "<external>";
/** Node's process.platform values the endpoint counts. On any other the plugin sends nothing. */
const PLATFORMS = ["darwin", "linux", "win32", "freebsd", "openbsd", "netbsd", "sunos", "aix", "android"];

// ---- whether anything is sent at all ---------------------------------------------------------------------------------

const truthy = (value) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
};

/**
 * Whether the plugin may send, and when not, which setting says so: { on: true } or { on: false, why }. `why` names a
 * variable and never a value that could be private.
 */
export function telemetrySwitch(env = process.env) {
  const own = String(env.RUNNERS_IO_TELEMETRY ?? "").trim().toLowerCase();
  if (own === "off" || own === "0" || own === "false" || own === "no") return { on: false, why: "RUNNERS_IO_TELEMETRY=off" };
  if (truthy(env.DO_NOT_TRACK)) return { on: false, why: "DO_NOT_TRACK is set" };
  if (truthy(env.DISABLE_TELEMETRY)) return { on: false, why: "DISABLE_TELEMETRY is set" };
  if (truthy(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)) return { on: false, why: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set" };
  const test = env[TEST_URL_ENV];
  if (test !== undefined && test !== "") {
    return testEndpoint(test) ? { on: true } : { on: false, why: `${TEST_URL_ENV} is not a listener on 127.0.0.1` };
  }
  if (env.NODE_TEST_CONTEXT || env.RUNNERS_IO_TEST_FAKE_GITHUB === "1") return { on: false, why: "the plugin's own tests are running" };
  return { on: true };
}

/** A test listener's address as it is used, or null: plain http, on 127.0.0.1 and nowhere else, with no login in it. */
function testEndpoint(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Where a message goes: TELEMETRY_URL, the tests' own listener, or null when nothing may be sent. */
export function telemetryEndpoint(env = process.env) {
  if (!telemetrySwitch(env).on) return null;
  const test = env[TEST_URL_ENV];
  return test !== undefined && test !== "" ? testEndpoint(test) : TELEMETRY_URL;
}

/**
 * Whether a message to TELEMETRY_URL has to go through a company proxy that Node's own fetch does not use. A hook
 * cannot open that tunnel (the channel can: channel/src/proxy.ts), so there the channel sends the install ping.
 */
export function needsTunnel(env = process.env) {
  return proxyFor(env, TELEMETRY_URL).kind === "proxy" && !nodeProxiesItself(env);
}

/** One line for `status` and the doctor skill: on, or off and which setting turned it off. Never the install id. */
export function telemetryLine(env = process.env) {
  const s = telemetrySwitch(env);
  return s.on
    ? "telemetry: on (an install ping and reports of the plugin's own faults; RUNNERS_IO_TELEMETRY=off turns it off)"
    : `telemetry: off (${s.why}): nothing is sent to runners.io`;
}

// ---- the plugin's own files ------------------------------------------------------------------------------------------

/**
 * The plugin's folder, worked out from where this code runs: hooks/telemetry.mjs as the hooks load it, or
 * channel/dist/runners-io-channel.mjs as the channel's bundle carries it.
 */
function pluginRoot() {
  try {
    const self = fileURLToPath(import.meta.url);
    return basename(self) === "telemetry.mjs" ? dirname(dirname(self)) : dirname(dirname(dirname(self)));
  } catch {
    return null;
  }
}

export const PLUGIN_ROOT = pluginRoot();

/** The plugin's version as its manifest names it, or null. The channel passes its own constant instead. */
export function manifestVersion(root = PLUGIN_ROOT) {
  try {
    const v = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" && VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

// ---- what is never reported ------------------------------------------------------------------------------------------

/** Names that mean the network, GitHub or a cancelled request failed, or a setting is wrong: not the plugin's code. */
const DENIED_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "FetchError",
  "HttpError",
  "RequestError",
  "GraphqlResponseError",
  "ResponseStatusCodeError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
  "RequestAbortedError",
  "ClientClosedError",
  "ClientDestroyedError",
  "SecureProxyConnectionError",
  // Thrown by the plugin on purpose for a setting it refuses, a folder that is not this user's, a proxy that will not
  // carry a request (channel/src/errors.ts): the machine's to fix, never the plugin's own fault.
  "MachineError",
  "ConfigError",
]);

/** Codes for a handled answer, the network, and the file system, git and gh on this machine, lower-cased. */
const DENIED_CODES = new Set([
  "auth",
  "retry",
  "not_found",
  "rate_limit",
  "rate_limited",
  "sso",
  "forbidden",
  "unauthorized",
  "offline",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "enotfound",
  "etimedout",
  "eai_again",
  "epipe",
  "ehostunreach",
  "enetunreach",
  "eproto",
  "enoent",
  "eacces",
  "eperm",
  "enospc",
  "erofs",
  "emfile",
  "enfile",
  "eexist",
  "eisdir",
  "enotdir",
  "ebusy",
  "eio",
]);

/** Families of codes: an HTTP status, Node's transport errors, a certificate that did not verify, a channel notice. */
const DENIED_CODE_PATTERN =
  /^(http_[0-9]{3}|err_(tls|ssl|socket|http|http2|network|proxy|stream)_[a-z0-9_]+|und_err_[a-z0-9_]+|cert_[a-z0-9_]+|self_signed_[a-z0-9_]+|unable_to_[a-z0-9_]+|depth_zero_[a-z0-9_]+|channel_[a-z0-9_]+|problem[a-z0-9_]*)$/;
/** Any operating-system error code (ENOTEMPTY, EXDEV, ...), listed above or not. Node's own ERR_ codes are not these. */
const ERRNO = /^E[A-Z0-9]+$/;

function deniedCode(code) {
  if (typeof code !== "string" || code === "") return false;
  const lower = code.toLowerCase();
  return DENIED_CODES.has(lower) || DENIED_CODE_PATTERN.test(lower) || ERRNO.test(code);
}

function deniedOne(e) {
  if (e === null || typeof e !== "object") return false;
  if (typeof e.name === "string" && DENIED_NAMES.has(e.name)) return true;
  if (deniedCode(e.code)) return true;
  // The operating system answered: a file, a socket or a program on this machine.
  if (typeof e.errno === "number" || typeof e.syscall === "string") return true;
  // An HTTP answer carried on the error, whatever it is called.
  if (typeof e.status === "number" || typeof e.statusCode === "number") return true;
  // A program that was run (git, gh, ps) and failed, was killed or was not there.
  if (typeof e.cmd === "string" || Array.isArray(e.spawnargs) || typeof e.killed === "boolean") return true;
  // Node's fetch names every failed connection this, with the reason in `cause`.
  if (e.name === "TypeError" && e.message === "fetch failed") return true;
  return false;
}

/**
 * True when a failure is not the plugin's own, so it is never sent: checked on the error, on each `cause` behind it and
 * on each member of an AggregateError. Reads names, codes and shapes only.
 */
export function denied(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length && seen.size < 16) {
    const e = queue.shift();
    if (e === null || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    if (deniedOne(e)) return true;
    if (e.cause !== undefined) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors.slice(0, 8));
  }
  return false;
}

// ---- what a message holds --------------------------------------------------------------------------------------------

function errorName(error) {
  if (error !== null && typeof error === "object") {
    if (typeof error.name === "string" && ERROR_NAME.test(error.name)) return error.name;
    const made = error.constructor?.name;
    if (typeof made === "string" && ERROR_NAME.test(made)) return made;
  }
  return "Error";
}

/** One stack line as it is sent: `function file.mjs:line:column` for a file of the plugin's, else `<external>`. */
function frameOf(line, root) {
  const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
  if (!m || !root) return EXTERNAL;
  let file = m[2].replace(/^async /, "");
  try {
    if (file.startsWith("file://")) file = fileURLToPath(file);
  } catch {
    return EXTERNAL;
  }
  if (!isAbsolute(file) || !file.startsWith(root + sep) || file.includes(`${sep}node_modules${sep}`)) return EXTERNAL;
  const name = basename(file);
  if (!OWN_FILE.test(name)) return EXTERNAL;
  let fn = (m[1] ?? "").replace(/^async /, "").replace(/^new /, "").replace(/ \[as [^\]]*\]$/, "");
  if (!FUNCTION_NAME.test(fn)) fn = "<anonymous>";
  const frame = `${fn} ${name}:${m[3]}:${m[4]}`;
  return FRAME.test(frame) ? frame : EXTERNAL;
}

/**
 * The stack as it is sent: at most 8 lines, a run of lines outside the plugin's files written once as `<external>`.
 * The stack's opening lines are the error's name and message, which are cut off whole (a message can run over several
 * lines), so no word of the message can pass for a frame.
 */
export function frameLines(error, root = PLUGIN_ROOT) {
  const stack = error !== null && typeof error === "object" && typeof error.stack === "string" ? error.stack : "";
  let text = stack;
  const message = typeof error?.message === "string" ? error.message : "";
  if (message) {
    const at = text.indexOf(message);
    if (at >= 0) text = text.slice(at + message.length);
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!/^\s*at /.test(line)) continue;
    const frame = frameOf(line, root);
    if (frame === EXTERNAL && out[out.length - 1] === EXTERNAL) continue;
    out.push(frame);
    if (out.length === MAX_FRAMES) break;
  }
  return out;
}

/**
 * 16 hex characters that name a fault: the error's name, the check's code and the top 3 of the plugin's own frames.
 * The top ones only, so one fault reached by two routes is one fault.
 */
export function fingerprintOf(name, frames, code = null) {
  const own = frames.filter((f) => f !== EXTERNAL).slice(0, 3);
  return createHash("sha256").update([name, code ?? "", ...own].join("\n")).digest("hex").slice(0, 16);
}

const platformOf = (platform) => (PLATFORMS.includes(platform) ? platform : null);

function nodeMajorOf(version) {
  const major = Number(String(version).split(".")[0]);
  return Number.isInteger(major) && major >= 18 && major <= 99 ? major : null;
}

/** The install ping's fields, and no others. null when a field would not be one the endpoint takes. */
export function installPing({ installId, version, previousVersion = null, updated = false, platform = process.platform, nodeVersion = process.versions.node }) {
  const os = platformOf(platform);
  const nodeMajor = nodeMajorOf(nodeVersion);
  if (!UUID_V4.test(String(installId)) || !VERSION.test(String(version)) || !os || nodeMajor === null) return null;
  const previous = typeof previousVersion === "string" && VERSION.test(previousVersion) && previousVersion !== version ? previousVersion : null;
  return {
    kind: updated || previous ? "update" : "install",
    install_id: installId,
    version,
    ...(previous ? { previous_version: previous } : {}),
    os,
    node_major: nodeMajor,
  };
}

/**
 * The fault report's fields, and no others, or null when the failure is not one to send: it is on the deny-list, its
 * stack never passes through the plugin's own files, or a field would not be one the endpoint takes.
 */
export function errorReport(error, { installId, version, component, code = null, root = PLUGIN_ROOT, platform = process.platform, nodeVersion = process.versions.node }) {
  if (denied(error)) return null;
  if (code !== null && (!CODE.test(String(code)) || deniedCode(code))) return null;
  const os = platformOf(platform);
  const nodeMajor = nodeMajorOf(nodeVersion);
  if (!UUID_V4.test(String(installId)) || !VERSION.test(String(version)) || !COMPONENT.test(String(component)) || !os || nodeMajor === null) return null;
  const frames = frameLines(error, root);
  const name = errorName(error);
  if (DENIED_NAMES.has(name)) return null;
  const report = {
    kind: "error",
    install_id: installId,
    version,
    os,
    node_major: nodeMajor,
    component,
    error_name: name,
    fingerprint: fingerprintOf(name, frames, code),
    frames,
    ...(code !== null ? { code } : {}),
  };
  // Under 1 KB whatever the stack holds: the deepest lines go first. A stack with no line of the plugin's own, before
  // or after that, does not say the fault is the plugin's, and is not sent.
  while (Buffer.byteLength(JSON.stringify(report)) > MAX_BODY_BYTES && report.frames.length > 1) report.frames = report.frames.slice(0, -1);
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_BODY_BYTES || !report.frames.some((f) => f !== EXTERNAL)) return null;
  return report;
}

// ---- what has been sent: files that can be made only once ------------------------------------------------------------

/** The folder the claims are kept in, made if missing, or null when it is not this user's own folder to write in. */
function claimFolder(env) {
  const root = stateRoot(env);
  if (!root) return null;
  const dir = join(root, "telemetry");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of [root, dir]) {
      const st = lstatSync(d);
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid !== undefined && st.uid !== process.getuid())) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

/** Makes a file that must not exist yet. "made", "exists" (somebody claimed it first) or "failed" (cannot write here). */
function claim(dir, name, text = "") {
  let fd;
  try {
    fd = openSync(join(dir, name), "wx", 0o600);
    if (text) writeFileSync(fd, text);
    return "made";
  } catch (e) {
    return e?.code === "EEXIST" ? "exists" : "failed";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const names = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** A small file of this user's own as text, or null: never through a symlink. */
function readOwn(dir, name) {
  try {
    const st = lstatSync(join(dir, name));
    if (!st.isFile() || st.size > 256 || (process.getuid !== undefined && st.uid !== process.getuid())) return null;
    return readFileSync(join(dir, name), "utf8").trim();
  } catch {
    return null;
  }
}

/** This install's random id: made once and kept. null when it cannot be kept, and then nothing is sent. */
function installId(dir) {
  const have = readOwn(dir, "install-id");
  if (have !== null && UUID_V4.test(have)) return have;
  if (have !== null) rmSync(join(dir, "install-id"), { force: true });
  const made = claim(dir, "install-id", randomUUID());
  if (made === "failed") return null;
  const now = readOwn(dir, "install-id");
  return now !== null && UUID_V4.test(now) ? now : null;
}

/** A state folder younger than this is a new install's own: its files were made by this launch. */
const NEW_INSTALL_WINDOW_MS = 10 * 60_000;

/**
 * Whether the plugin was on this machine before it sent anything: its state folder, or a file in it, is older than a
 * launch could have made it. Such a first ping says `update`, not `install`. Ages only; no file is read.
 */
function installedBefore(root, nowMs) {
  const ages = [];
  try {
    const st = statSync(root);
    if (st.birthtimeMs > 0) ages.push(st.birthtimeMs);
  } catch {}
  for (const n of names(root)) {
    if (n === "telemetry") continue;
    try {
      ages.push(statSync(join(root, n)).mtimeMs);
    } catch {}
  }
  return ages.some((at) => nowMs - at > NEW_INSTALL_WINDOW_MS);
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---- sending ---------------------------------------------------------------------------------------------------------

/** One POST, once. The answer's status, or null when none came in time. Never throws. */
async function post(endpoint, message, send, timeoutMs) {
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    const answer = await send(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: stop.signal,
      // A redirect is never followed: a message goes to the address above or nowhere.
      redirect: "error",
    });
    try {
      await answer.body?.cancel();
    } catch {}
    return answer.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The plugin's sender for one process. `component` names the part that is running (channel, hook:session-start);
 * `version` is the plugin's; `fetch` is how a request is made (the channel passes the one that goes through a company
 * proxy). Every method answers a word saying what happened and never throws: "sent", or why nothing was sent.
 */
export function createTelemetry({
  component,
  version,
  env = process.env,
  fetch: send = globalThis.fetch,
  now = Date.now,
  root = PLUGIN_ROOT,
  platform = process.platform,
  nodeVersion = process.versions.node,
  timeoutMs = SEND_TIMEOUT_MS,
} = {}) {
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };

  /** Where to send and where the claims are, or the word for why nothing is sent. */
  const ready = () => {
    const endpoint = telemetryEndpoint(env);
    if (!endpoint) return "off";
    if (!VERSION.test(String(version)) || typeof send !== "function") return "off";
    const dir = claimFolder(env);
    if (!dir) return "no_state";
    const until = Number(readOwn(dir, `gone-${version}`));
    if (Number.isFinite(until) && until > now()) return "gone";
    if (until) rmSync(join(dir, `gone-${version}`), { force: true });
    return { endpoint, dir };
  };

  const gone = (dir) => {
    rmSync(join(dir, `gone-${version}`), { force: true });
    claim(dir, `gone-${version}`, String(now() + GONE_FOR_MS));
  };

  const answerWord = (status) => (status === null ? "failed" : status === 410 ? "gone" : status === 429 ? "limited" : "sent");

  async function ping() {
    const at = ready();
    if (typeof at === "string") return at;
    const { endpoint, dir } = at;
    const mine = `ping-${version}`;
    const before = names(dir);
    if (before.includes(mine)) return "already";
    const id = installId(dir);
    if (!id) return "no_state";
    // The versions pinged before: the newest of them is the one this version replaced.
    const earlier = before
      .filter((n) => n.startsWith("ping-") && VERSION.test(n.slice(5)))
      .map((n) => {
        try {
          return { name: n, at: statSync(join(dir, n)).mtimeMs };
        } catch {
          return { name: n, at: 0 };
        }
      })
      .sort((a, b) => b.at - a.at);
    const hadState = installedBefore(dirname(dir), now());
    const message = installPing({ installId: id, version, previousVersion: earlier[0]?.name.slice(5) ?? null, updated: hadState, platform, nodeVersion });
    if (!message) return "off";
    const made = claim(dir, mine);
    if (made !== "made") return made === "exists" ? "already" : "no_state";
    const status = await post(endpoint, message, send, timeoutMs);
    // Sent once, whatever came of it: a ping that was refused, lost or told to stop is not sent again for this
    // version. "It tells us once" is a promise of the privacy policy, and a second try would break it.
    for (const e of earlier) rmSync(join(dir, e.name), { force: true });
    if (status === 410) gone(dir);
    return answerWord(status);
  }

  async function report(error, { component: part = component, code = null } = {}) {
    try {
      // The deny-list first: a failure that is not the plugin's own touches no file and uses up no report.
      if (denied(error)) return "denied";
      const at = ready();
      if (typeof at === "string") return at;
      const { endpoint, dir } = at;
      const id = installId(dir);
      if (!id) return "no_state";
      const message = errorReport(error, { installId: id, version, component: part, code, root, platform, nodeVersion });
      if (!message) return "denied";
      const day = utcDay(now());
      // Yesterday's claims are of no more use.
      for (const n of names(dir)) if ((n.startsWith("fault-") || n.startsWith("slot-")) && !n.startsWith(`fault-${day}-`) && !n.startsWith(`slot-${day}-`)) rmSync(join(dir, n), { force: true });
      // Once per fault per version per day ...
      const fault = claim(dir, `fault-${day}-${version}-${message.fingerprint}`);
      if (fault !== "made") return fault === "exists" ? "duplicate" : "no_state";
      // ... and at most 5 a day from this install, whatever failed.
      let slot = "exists";
      for (let n = 1; n <= MAX_REPORTS_PER_DAY && slot === "exists"; n++) slot = claim(dir, `slot-${day}-${n}`);
      if (slot !== "made") return slot === "exists" ? "capped" : "no_state";
      const status = await post(endpoint, message, send, timeoutMs);
      if (status === 410) gone(dir);
      return answerWord(status);
    } catch {
      // Reporting a fault must never be one.
      return "failed";
    }
  }

  function internalError(code) {
    if (!INTERNAL_CODES.includes(code)) return Promise.resolve("denied");
    const error = new Error(code);
    error.name = "InternalError";
    // The stack starts at the check that failed, not in here.
    Error.captureStackTrace?.(error, internalError);
    return track(report(error, { code }));
  }

  return {
    /** The install ping, when this version has not sent one. */
    ping: () => track(ping().catch(() => "failed")),
    /** A fault of the plugin's own. `component` overrides the process's (tool:ci_status); `code` is internalError's. */
    report: (error, options) => track(report(error, options)),
    /** One of the plugin's own consistency checks failed. Only the codes in INTERNAL_CODES are sent. */
    internalError,
    /** Resolves when every send that was started has ended: at most the 2-second limit away. */
    settle: () => Promise.allSettled([...pending]).then(() => undefined),
  };
}

/**
 * Runs a hook's main function. A failure nothing caught is reported as the plugin's own fault (unless the deny-list
 * says it is not), the send is given its 2 seconds at most, and the hook then ends with status 0 as it always has: a
 * hook never fails the session, whatever happened.
 */
export async function runHook(component, main, { version = manifestVersion(), env = process.env, exit = (code) => process.exit(code), fetch: send = globalThis.fetch, root = PLUGIN_ROOT } = {}) {
  const telemetry = createTelemetry({ component, version, env, fetch: send, root });
  let failed = false;
  const fault = (error) => {
    if (failed) return;
    failed = true;
    telemetry.report(error).finally(() => exit(0));
  };
  process.on("uncaughtException", fault);
  process.on("unhandledRejection", fault);
  try {
    await main(telemetry);
  } catch (error) {
    fault(error);
    return;
  }
  if (failed) return;
  await telemetry.settle();
  exit(0);
}
