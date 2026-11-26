# The channel's tests

`npm test` in `channel/` runs every file here with Node's own test runner. Nothing here talks to GitHub or to
runners.io: the tests start a fake GitHub (`fake-github.mjs`), a fake proxy (`fake-proxy.mjs`) and a fake telemetry
endpoint (`fake-endpoint.mjs`) on `127.0.0.1`, and the plugin is pointed at those.

## The token-shaped strings are made up

Many files here hold strings shaped like GitHub tokens, such as `gho_fakeToken123`, `ghp_…` and `github_pat_…`. **None
is, or ever was, a real token.** They exist because:

- the fake GitHub accepts one made-up token and refuses every other, so the tests can show what the channel does with
  a login that is refused;
- the redaction tests (`secrets.test.ts`, `eventlog.test.ts`) need token shapes to prove that a token never reaches a
  log line, an event or a file.

A secret scanner will flag them. `.gitleaks.toml` at the root of the repository lists this folder for that reason. If
you find a string here that you believe is a real credential, please report it as [SECURITY.md](../../SECURITY.md)
says.
