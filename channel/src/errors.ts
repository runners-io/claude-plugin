/**
 * A failure that is this machine's, its settings' or a proxy's: a setting the plugin refuses, a folder that is not this
 * user's own, a proxy that will not carry the request. The plugin throws it on purpose and it is never the plugin's own
 * fault, so it is never reported to runners.io: hooks/telemetry.mjs refuses the name. The message is unchanged, and it
 * still reads as any error does wherever it is caught.
 */
export function machineError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.name = "MachineError";
  return error;
}
