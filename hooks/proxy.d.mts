type Env = Record<string, string | undefined>;

export interface Proxy {
  readonly protocol: "http:" | "https:";
  /** The proxy's host, an IPv6 address without its brackets. */
  readonly hostname: string;
  readonly port: number;
  /** `user:password` for the proxy's own login, or null. Never put into a sentence, a log line or a file. */
  readonly auth: string | null;
  /** The proxy's host and port, with no login: the only part that is ever shown. */
  readonly display: string;
}

export type Route =
  | { readonly kind: "direct"; readonly why: "unset" }
  | { readonly kind: "direct"; readonly why: "no_proxy"; readonly variable: string }
  | { readonly kind: "proxy"; readonly variable: string; readonly proxy: Proxy }
  | { readonly kind: "unusable"; readonly variable: string };

export function proxyVariable(env?: Env): string | null;
export function nodeProxiesItself(env?: Env, version?: string): boolean;
export function parseProxy(raw: unknown): Proxy | null;
export function bypassed(noProxy: unknown, hostname: string, port: number): boolean;
export function proxyFor(env?: Env, target?: string): Route;

export type Refusal =
  | { readonly why: "tls_checks_off"; readonly reason: string }
  | { readonly why: "proxy_unusable"; readonly variable: string; readonly reason: string };

/** Whether NODE_TLS_REJECT_UNAUTHORIZED=0 has switched certificate checks off. */
export function tlsChecksOff(env?: Env): boolean;
/** Why no request to `target` may be made (certificate checks off, a proxy that cannot be used), or null. */
export function sendRefusal(env?: Env, target?: string, options?: { login?: boolean }): Refusal | null;
/** Whether the plugin reads github.com (RUNNERS_IO_GITHUB_API unset or naming api.github.com), not another GitHub host. */
export function readsGitHubCom(env?: Env): boolean;
