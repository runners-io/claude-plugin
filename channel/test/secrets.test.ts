import assert from "node:assert/strict";
import { test } from "node:test";

import { apiHost, checkTokenUrl, loadConfig } from "../src/config.ts";
import { redact } from "../src/log.ts";

test("a log line never carries a bearer token or a GitHub token", () => {
  const line = redact(
    "Authorization: Bearer fake-access-AbC123 token gho_abcdefghij1234567890 and ghp_ZYXWVUTSRQ0987654321 " +
      "and github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  );
  for (const secret of ["fake-access-AbC123", "gho_abcdefghij", "ghp_ZYXWVUTSRQ", "github_pat_11ABCDEFG"]) {
    assert.ok(!line.includes(secret), `${secret} in ${line}`);
  }
  assert.match(line, /Bearer \[redacted\]/);
  // The control: an ordinary word that starts like a token is left alone.
  assert.equal(redact("ghost_town"), "ghost_town");
});

test("the GitHub API is only ever reached over https, or plain http to this machine", () => {
  assert.equal(checkTokenUrl("https://api.github.com/", "x"), "https://api.github.com");
  assert.equal(checkTokenUrl("http://127.0.0.1:8790", "x", { RUNNERS_IO_TEST_FAKE_GITHUB: "1" }), "http://127.0.0.1:8790");
  assert.throws(() => checkTokenUrl("http://api.github.com", "x"), /must be https/);
  assert.throws(() => checkTokenUrl("http://10.0.0.5", "x"), /must be https/);
  assert.throws(() => loadConfig({ RUNNERS_IO_GITHUB_API: "http://example.com" }), /RUNNERS_IO_GITHUB_API/);
});

test("an address on this machine is accepted only under the tests' switch: any local process could listen there", () => {
  for (const local of ["http://127.0.0.1:8790", "https://localhost:8443", "http://[::1]:9"]) {
    assert.throws(() => checkTokenUrl(local, "x", {}), /RUNNERS_IO_TEST_FAKE_GITHUB/, local);
    assert.throws(() => loadConfig({ RUNNERS_IO_GITHUB_API: local }), /RUNNERS_IO_GITHUB_API/, local);
  }
  assert.equal(loadConfig({ RUNNERS_IO_GITHUB_API: "http://127.0.0.1:8790", ...{ RUNNERS_IO_TEST_FAKE_GITHUB: "1" } }).githubApi, "http://127.0.0.1:8790");
});

test("the defaults are api.github.com, the branch's PR watched automatically, every 20 seconds", () => {
  const c = loadConfig({ HOME: "/home/u", CLAUDE_PROJECT_DIR: "/w/repo" });
  assert.equal(c.githubApi, "https://api.github.com");
  assert.equal(c.autoSubscribe, "pr");
  assert.equal(c.projectDir, "/w/repo");
  assert.equal(c.pollSeconds, 20);
  assert.equal(loadConfig({ RUNNERS_IO_AUTO_SUBSCRIBE: "${user_config.auto_subscribe}" }).autoSubscribe, "pr");
  assert.equal(loadConfig({ RUNNERS_IO_AUTO_SUBSCRIBE: "off" }).autoSubscribe, "off");
  assert.equal(c.reviewRequests, false, "review requests are off unless asked for");
  assert.equal(loadConfig({ RUNNERS_IO_REVIEW_REQUESTS: "${user_config.review_requests}" }).reviewRequests, false);
  assert.equal(loadConfig({ RUNNERS_IO_REVIEW_REQUESTS: "on" }).reviewRequests, true);
  assert.equal(loadConfig({ RUNNERS_IO_POLL_SECONDS: "1" }).pollSeconds, 5);
  assert.equal(loadConfig({ RUNNERS_IO_POLL_SECONDS: "9999" }).pollSeconds, 300);
});

test("the event log is off unless RUNNERS_IO_EVENT_LOG_DIR is an absolute path, and the rate floor defaults to 200", () => {
  assert.equal(loadConfig({}).eventLogDir, null);
  assert.equal(loadConfig({ RUNNERS_IO_EVENT_LOG_DIR: "logs/here" }).eventLogDir, null, "a relative path is refused");
  assert.equal(loadConfig({ RUNNERS_IO_EVENT_LOG_DIR: "${user_config.event_log_dir}" }).eventLogDir, null);
  assert.equal(loadConfig({ RUNNERS_IO_EVENT_LOG_DIR: "/var/log/rio" }).eventLogDir, "/var/log/rio");
  assert.equal(loadConfig({}).rateFloor, 200);
  assert.equal(loadConfig({ RUNNERS_IO_RATE_FLOOR: "1500" }).rateFloor, 1500);
  assert.equal(loadConfig({ RUNNERS_IO_RATE_FLOOR: "-3" }).rateFloor, 0);
  assert.equal(loadConfig({ RUNNERS_IO_RATE_FLOOR: "nonsense" }).rateFloor, 200);
});

test("an API address with a user name or a password in it is refused at start, and the refusal repeats none of it", () => {
  const secret = "s3cr3t-pa55";
  for (const raw of [
    `https://ada:${secret}@ghe.corp.example/api/v3`,
    `https://${secret}@ghe.corp.example/api/v3`,
    `https://:${secret}@api.github.com`,
    `http://ada:${secret}@127.0.0.1:8790`,
  ]) {
    for (const env of [{}, { RUNNERS_IO_TEST_FAKE_GITHUB: "1" }]) {
      let error: Error | null = null;
      try {
        loadConfig({ ...env, RUNNERS_IO_GITHUB_API: raw });
      } catch (e) {
        error = e as Error;
      }
      assert.ok(error, raw);
      assert.equal(error.name, "MachineError", "a setting the plugin refuses is the machine's, never reported as the plugin's fault");
      assert.match(error.message, /^RUNNERS_IO_GITHUB_API must not hold a user name or a password/);
      assert.equal(/s3cr3t|ada|ghe\.corp|127\.0\.0\.1/.test(error.message), false, error.message);
    }
  }
});

test("no refusal of an API address repeats the address: at most the host it names", () => {
  const secret = "s3cr3t-pa55";
  const said = (raw: string, env = {}): string => {
    try {
      checkTokenUrl(raw, "RUNNERS_IO_GITHUB_API", env);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  // An address that cannot be read at all can still hold a login: none of it is said.
  assert.equal(said(`https://ada:${secret}@ghe.corp.example:port/api`), "RUNNERS_IO_GITHUB_API is not a URL");
  assert.equal(said(`http://ghe.corp.example:8080/api/v3?access_token=${secret}`), "RUNNERS_IO_GITHUB_API must be https (it names ghe.corp.example:8080 over http)");
  assert.equal(
    said(`http://127.0.0.1:8790/?access_token=${secret}`),
    "RUNNERS_IO_GITHUB_API may name this machine only in the plugin's own tests (RUNNERS_IO_TEST_FAKE_GITHUB=1); it names 127.0.0.1:8790",
  );
});

test("the API address is shown as its host and port only", () => {
  assert.equal(apiHost("https://api.github.com"), "api.github.com");
  assert.equal(apiHost("https://ghe.corp.example:8443/api/v3"), "ghe.corp.example:8443");
  assert.equal(apiHost("https://ghe.corp.example/api/v3?access_token=s3cr3t"), "ghe.corp.example");
  assert.equal(apiHost("https://ada:s3cr3t@ghe.corp.example/api/v3"), "ghe.corp.example");
  assert.equal(apiHost("not an address s3cr3t"), "an address that cannot be read");
});
