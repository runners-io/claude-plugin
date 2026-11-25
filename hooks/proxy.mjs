// Which way a request to GitHub goes: straight there, or through the proxy the environment names.
//
// Read the way curl and the GitHub CLI read it, so the channel goes where `gh` already goes: `https_proxy` (then
// `HTTPS_PROXY`) names the proxy, and `no_proxy` (then `NO_PROXY`) the hosts that are reached without it. Two callers
// share this one module, so the setup checks say what the channel does: the channel sends its GitHub requests by it
// (channel/src/proxy.ts), and the checks print which way they go (readiness.mjs).
//
// A proxy address can carry a user name and a password. They are parsed here, for the proxy's own login and nothing
// else: `display` is the proxy's host and port only, and it is the only part that is ever put into a sentence, a log
// line or a file.
//
// Nothing here opens a connection. Dependency-free plain JavaScript, Node 20.

/** Lower case first, as curl reads them: a shell that sets both means the lower-case one. */
const PROXY_VARS = ["https_proxy", "HTTPS_PROXY"];
const NO_PROXY_VARS = ["no_proxy", "NO_PROXY"];

const set = (env, names) => names.find((n) => (env[n] ?? "").trim()) ?? null;

/** The variable that names the proxy for GitHub, or null when none is set. */
export function proxyVariable(env = process.env) {
  return set(env, PROXY_VARS);
}

/**
 * Whether this Node.js reads the proxy variables itself: it was asked to (NODE_USE_ENV_PROXY=1) and is new enough to
 * know the variable (24, or 22.21 and later; an older one ignores it). The channel then stands aside and uses Node's
 * own `fetch`, so a user who chose Node's way keeps it; everywhere else the channel does the work.
 */
export function nodeProxiesItself(env = process.env, version = process.versions.node) {
  if (env.NODE_USE_ENV_PROXY !== "1") return false;
  const [major, minor] = String(version).split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

/**
 * A proxy address as the channel can use it, or null: an http:// or https:// proxy (a bare `host:port` is http, as
 * curl takes it). A SOCKS proxy, or anything that is not an address, is null: the channel cannot use it.
 */
export function parseProxy(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  let auth = null;
  if (url.username || url.password) {
    try {
      auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    } catch {
      auth = `${url.username}:${url.password}`;
    }
  }
  return { protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ""), port, auth, display: `${url.hostname}:${port}` };
}

/**
 * Whether a no_proxy list names this host: `*` is every host; a name matches itself and every name below it
 * (`example.com`, `.example.com` and `*.example.com` all match `api.example.com`); an entry with a port matches that
 * port only. An address matches only when written out in full: a range (`10.0.0.0/8`) is not read.
 */
export function bypassed(noProxy, hostname, port) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  for (const raw of String(noProxy ?? "").split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort = null;
    // `[::1]:8080`, or `name:8080`; a bare IPv6 address has more than one colon and no port to read.
    const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry) ?? (entry.split(":").length === 2 ? /^([^:]+):(\d{1,5})$/.exec(entry) : null);
    if (m) {
      entry = m[1];
      entryPort = m[2] === undefined ? null : Number(m[2]);
    }
    entry = entry.replace(/^\*?\./, "");
    if (!entry || (entryPort !== null && entryPort !== port)) continue;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * The way to `target` (an address such as https://api.github.com):
 *   { kind: "direct", why: "unset" }                       no proxy variable is set
 *   { kind: "direct", why: "no_proxy", variable }          the no_proxy list names the target's host
 *   { kind: "proxy", variable, proxy }                     through `proxy` (parseProxy's answer)
 *   { kind: "unusable", variable }                         the variable is set to something the channel cannot use
 */
export function proxyFor(env = process.env, target = "https://api.github.com") {
  const variable = proxyVariable(env);
  if (!variable) return { kind: "direct", why: "unset" };
  let host = "";
  let port = 443;
  try {
    const url = new URL(target);
    host = url.hostname;
    port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  } catch {}
  const noProxy = set(env, NO_PROXY_VARS);
  if (noProxy && bypassed(env[noProxy], host, port)) return { kind: "direct", why: "no_proxy", variable: noProxy };
  const proxy = parseProxy(env[variable]);
  return proxy ? { kind: "proxy", variable, proxy } : { kind: "unusable", variable };
}
