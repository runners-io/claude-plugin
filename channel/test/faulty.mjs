// Faults of the plugin's own, for the telemetry tests: each throws from a file inside the plugin's folder, so its
// stack has a line the plugin would send. `planted` is put into the message, which must never be sent.
export function brokenLookup(planted = "") {
  throw new TypeError(`Cannot read properties of null (reading 'value') ${planted}`);
}

/** A fault some way down a stack: `depth` calls deep. */
export function deepFault(depth, planted = "") {
  if (depth > 0) return deepFault(depth - 1, planted);
  throw new RangeError(`out of range ${planted}`);
}

/** A second, different fault, numbered so that each has a fingerprint of its own. */
export const faults = Array.from({ length: 8 }, (_, i) =>
  // Each on a line of its own: the line is part of what names a fault.
  [
    () => { throw new TypeError("fault 0"); },
    () => { throw new TypeError("fault 1"); },
    () => { throw new TypeError("fault 2"); },
    () => { throw new TypeError("fault 3"); },
    () => { throw new TypeError("fault 4"); },
    () => { throw new TypeError("fault 5"); },
    () => { throw new TypeError("fault 6"); },
    () => { throw new TypeError("fault 7"); },
  ][i],
);

/** The error a call threw. */
export function caught(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
}
