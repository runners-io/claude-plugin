export const FINISHED_MAX_MS: number;
export const BASE_EVERY_MS: number;
export const BASE_IDLE_MS: number;

export interface BaseRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export function latestPerWorkflow<T extends BaseRun>(runs: readonly T[]): T[];
export function baseVerdict(runs: readonly BaseRun[]): { red: boolean; failing: string[]; at: string | null };
