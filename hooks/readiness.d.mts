export type Effect = "blocks" | "degrades" | "info";
export type RowState = "ready" | "not_ready" | "unknown" | "skipped";

/** One check's answer. `effect`, `line` and `fix` are there when it is not_ready; `why` when unknown or skipped. */
export interface Row {
  readonly id: string;
  readonly label: string;
  readonly state: RowState;
  readonly effect?: Effect;
  readonly line?: string;
  readonly fix?: string;
  readonly why?: string;
  readonly once?: boolean;
}

export interface FirstCallEntry {
  readonly n: number;
  readonly first: number;
  readonly last: number;
  readonly source?: "env" | "gh";
  readonly owners?: readonly string[];
}

export interface FirstCallRecord {
  readonly kinds: Record<string, FirstCallEntry>;
  readonly projects: Record<string, Record<string, FirstCallEntry>>;
}

type Env = Record<string, string | undefined>;

export const OPT_OUT: string;
export const DECLINE_FOR_MS: number;
export const FIRST_CALL_MAX_AGE_MS: number;
export const FIRST_CALL_KINDS: readonly string[];

export function stateRoot(env?: Env): string | null;
export function projectKey(dir: string): string;
export function ownerKey(owner: string): string;
export function loginHost(env?: Env): string;

export function launchChecks(options?: { env?: Env; projectDir?: string; platform?: string }): Promise<Row[]>;
export function firstCallRows(record: FirstCallRecord, options?: { env?: Env; projectDir?: string; platform?: string }): Row[];
export function mergeRows(...lists: readonly (readonly Row[])[]): Row[];
export function findings(rows: readonly Row[]): Row[];
export function renderTable(rows: readonly Row[]): string;

export function readFirstCall(env?: Env, now?: number): FirstCallRecord;
export function recordFirstCall(env: Env, kind: string, options?: { source?: "env" | "gh"; owner?: string; project?: string; now?: number }): boolean;
export function clearFirstCall(env: Env, kinds: readonly string[], options?: { owner?: string; project?: string; now?: number }): boolean;
