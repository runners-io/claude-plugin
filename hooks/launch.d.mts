export type LaunchState = "on" | "off" | "headless" | "unknown";

export function parseLaunch(args: string): { state: Exclude<LaunchState, "unknown"> };

export function findLaunch(
  pid?: number,
  ps?: (pid: number) => { ppid: number; args: string } | null,
): { state: LaunchState; claudePid?: number };

/** One process's parent and command line from ps (by its absolute path); null on Windows; throws with no ps on PATH. */
export function psRow(pid: number, options?: { platform?: string; env?: Record<string, string | undefined> }): { ppid: number; args: string } | null;

export function pollsIn(state: LaunchState): boolean;

export function shellWord(s: string, shell?: string): string;

export function channelFlags(pluginRoot: string, shell?: string): string[];

export const SESSION_ID: RegExp;

export function relaunchSentence(sessionId?: string | null): string;
