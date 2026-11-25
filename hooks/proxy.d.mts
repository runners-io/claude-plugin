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
