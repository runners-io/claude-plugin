/**
 * The channel's own consistency checks: places where its state can only be wrong if the channel's code is.
 *
 * A check that fails calls `internalError(code)`. The channel carries on (the caller repairs or ignores the state as it
 * did before), and the failure is reported to runners.io as a fault of the plugin's own, by its code and the line of
 * the check, never with any of the state: hooks/telemetry.mjs says what a report holds, how often one is sent and how
 * it is turned off. Until main.ts gives this module the process's sender, and in every test that does not, a failed
 * check does nothing at all.
 */
import type { Telemetry } from "../../hooks/telemetry.mjs";

/** The checks there are. hooks/telemetry.mjs INTERNAL_CODES is the list that is sent; a code missing there is dropped. */
export type InternalCode = "watch_cap_exceeded" | "scope_holdings_negative" | "scope_holdings_over_cap";

let telemetry: Pick<Telemetry, "internalError"> | null = null;

/** The process's sender (main.ts), or null to stop reporting. */
export function setTelemetry(sender: Pick<Telemetry, "internalError"> | null): void {
  telemetry = sender;
}

/** One of the channel's own checks failed. Never throws and never waits. */
export function internalError(code: InternalCode): void {
  try {
    void telemetry?.internalError(code);
  } catch {
    // A check that cannot be reported is still only a check.
  }
}
