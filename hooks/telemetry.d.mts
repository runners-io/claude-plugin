type Env = Record<string, string | undefined>;

export const TELEMETRY_URL: string;
export const TEST_URL_ENV: string;
/** The variable the plugin's own `telemetry` setting reaches a hook and the channel in. */
export const SETTING_ENV: string;
export const SEND_TIMEOUT_MS: number;
export const MAX_BODY_BYTES: number;
export const MAX_FRAMES: number;
export const MAX_REPORTS_PER_DAY: number;
export const GONE_FOR_MS: number;
export const INTERNAL_CODES: readonly string[];
export const PLUGIN_ROOT: string | null;

export type TelemetrySwitch = { readonly on: true } | { readonly on: false; readonly why: string };

/** What a send came to: "sent", or the word for why nothing was sent or counted. */
export type Outcome = "sent" | "off" | "blocked" | "no_state" | "gone" | "already" | "denied" | "duplicate" | "capped" | "limited" | "failed";

export interface InstallPing {
  kind: "install" | "update";
  install_id: string;
  version: string;
  previous_version?: string;
  os: string;
  node_major: number;
}

export interface ErrorReport {
  kind: "error";
  install_id: string;
  version: string;
  os: string;
  node_major: number;
  component: string;
  error_name: string;
  fingerprint: string;
  frames: string[];
  code?: string;
}

export interface Telemetry {
  ping(): Promise<Outcome>;
  report(error: unknown, options?: { component?: string; code?: string | null }): Promise<Outcome>;
  internalError(code: string): Promise<Outcome>;
  settle(): Promise<void>;
}

export interface TelemetryOptions {
  component: string;
  version: string | null;
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
  root?: string | null;
  platform?: string;
  nodeVersion?: string;
  timeoutMs?: number;
}

export function telemetrySwitch(env?: Env): TelemetrySwitch;
export function telemetryEndpoint(env?: Env): string | null;
export function telemetryLine(env?: Env): string;
export function needsTunnel(env?: Env): boolean;
export function manifestVersion(root?: string | null): string | null;
export function denied(error: unknown): boolean;
export function frameLines(error: unknown, root?: string | null): string[];
export function fingerprintOf(name: string, frames: readonly string[], code?: string | null): string;
export function installPing(fields: { installId: string; version: string; previousVersion?: string | null; updated?: boolean; platform?: string; nodeVersion?: string }): InstallPing | null;
export function errorReport(
  error: unknown,
  fields: { installId: string; version: string; component: string; code?: string | null; root?: string | null; platform?: string; nodeVersion?: string },
): ErrorReport | null;
export function createTelemetry(options: TelemetryOptions): Telemetry;
export function runHook(
  component: string,
  main: (telemetry: Telemetry) => Promise<void> | void,
  options?: { version?: string | null; env?: Env; exit?: (code: number) => void; fetch?: typeof fetch; root?: string | null },
): Promise<void>;
