// The fake machine builds a child's environment from nothing, so the markers that tell the plugin its own tests are
// running (NODE_TEST_CONTEXT, RUNNERS_IO_TEST_FAKE_GITHUB) do not reach a hook it starts. session-start.test.mjs ran the
// real launch hook that way, and every run of the suite (CI, a release's export, anyone's clone) sent a real install
// ping to the live endpoint. The fake machine says telemetry is off; a case that tests sending turns it back on itself.
import assert from "node:assert/strict";
import { test } from "node:test";

import { telemetrySwitch } from "../../hooks/telemetry.mjs";
import { fakeMachine } from "./fake-machine.mjs";

test("a fake machine's environment sends nothing, even with no test marker in it", () => {
  const m = fakeMachine();
  assert.equal(m.env.NODE_TEST_CONTEXT, undefined, "the case is about an environment with no test marker");
  assert.equal(m.env.RUNNERS_IO_TEST_FAKE_GITHUB, undefined);
  assert.deepEqual(telemetrySwitch(m.env), { on: false, why: "RUNNERS_IO_TELEMETRY=off" });
});

test("control: the same environment without the fake machine's setting would send", () => {
  const { RUNNERS_IO_TELEMETRY: _off, ...env } = fakeMachine().env;
  assert.deepEqual(telemetrySwitch(env), { on: true });
});

test("a case can still turn telemetry on in a fake machine", () => {
  const m = fakeMachine({ env: { RUNNERS_IO_TELEMETRY: "" } });
  assert.deepEqual(telemetrySwitch(m.env), { on: true });
});
