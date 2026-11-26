/** Throws a TypeError from inside the plugin's folder; `planted` goes into its message. */
export function brokenLookup(planted?: string): never;
/** Throws a RangeError `depth` calls deep. */
export function deepFault(depth: number, planted?: string): never;
/** Eight different faults, each thrown from a line of its own. */
export const faults: readonly (() => never)[];
/** The error a call threw. */
export function caught(fn: () => unknown): Error;
