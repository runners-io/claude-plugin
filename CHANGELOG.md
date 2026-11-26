# Changelog

What each release of the runners.io plugin for Claude Code changed. Every release has a tag of its own (`v0.4.2`), and
a tag is never moved once it is published. To move to a newer release, see [Install](README.md#install).

## 0.4.2

**Works with no runners.io account, and installs nothing of runners.io's.**

- The plugin no longer installs the runners.io MCP server. Up to 0.4.1 its manifest held a second server,
  `runners-io-mcp` (`https://mcp.runners.io/mcp`), which every session connected to when it started, whether or not
  you use runners.io. That entry is gone. The server is now an optional extra for runners.io customers:
  `/runners-io:sign-in` adds it to your own Claude Code configuration, only after you say yes.
  **If you are a runners.io customer and used its tools:** after updating, run `/runners-io:sign-in` (or
  `claude mcp add --transport http --scope user runnersio https://mcp.runners.io/mcp`) and sign in once more.

**A switch for telemetry.**

- New plugin setting `telemetry` (`on`, the default, or `off`), in `/config` beside the plugin's other options. `off`
  sends runners.io nothing: no install ping and no report of the plugin's own faults. The environment variables still
  work (`RUNNERS_IO_TELEMETRY=off`, `DO_NOT_TRACK=1`, and Claude Code's own `DISABLE_TELEMETRY` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). `/runners-io:doctor` says whether it is on, and which setting turned it
  off. What is sent has not changed; the README's [Telemetry](README.md#telemetry) section lists every field.

**Claude asks before it fixes a failing run.**

- Until 0.4.1 a failure on your own pull request told Claude to start fixing it at once. Now Claude tells you and
  offers to fix it, and starts only when you say yes, or when you asked earlier in the session to fix CI or to keep
  the pull request green. The channel's instructions, each event and the `fix-failing-ci` and `watch-this-pr` skills
  say the same thing. A yes to fixing is not a yes to pushing: Claude still pushes only when you asked.

**Security.**

- On Windows, `gh`, `git` and `ps` were started by name with the project folder as the working directory, where
  Windows looks first, so a `gh.exe` or `git.exe` planted in a repository would have been run. Programs are now started
  by their full path, found on `PATH` with relative and empty entries left out, and `ps` is not run on Windows at all.
- The launch notice offered to set `RUNNERS_IO_GITHUB_API` for any host whose name merely contained `github` or `ghe`.
  It is now offered only for a host the GitHub CLI already has a login for, or that `GH_HOST` names, and a repository
  whose remote is on another host than the API address is not asked about.
- With `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment, the plugin refuses to send your GitHub token, and says so
  at launch and in the doctor.
- A proxy the plugin cannot use (a SOCKS proxy in `HTTPS_PROXY`, for example) used to mean a direct connection. Now it
  means no request at all, and a notice that says why.
- `RUNNERS_IO_GITHUB_API` with a user name or password in it is refused, and the address is never written to a log in
  full: only its host.
- The hook that looks for a pull request in a tool's output now matches whole tool names only (`Bash`, and a
  `create_pull_request` tool of an MCP server).
- When you have no `claude-gh` command, that answer is remembered for a day, so your login shell is no longer started
  at every launch to ask again.

**Also.**

- A new README, with a [Telemetry](README.md#telemetry) section and one table of every file the plugin writes.
- This changelog, a supported-versions line in `SECURITY.md`, and a note on the tests' made-up tokens.
- This repository's own CI now runs on runners.io runners.
- The README now says Claude Code v2.1.271 or later, not v2.1.80. The plugin's options are picked from fixed lists,
  and Claude Code's documentation says a plugin that declares such a list does not load on a version before v2.1.271.
  That was already so for the channel's two options; only the stated minimum was wrong.

## 0.4.1

- The plugin's own tests no longer send anything to runners.io, and a test that could hang the release check is fixed.
  Nothing a user sees changed.

## 0.4.0

- The plugin began sending runners.io two kinds of message: one when it is installed or updated, and one when the
  plugin's own code fails. `RUNNERS_IO_TELEMETRY=off` or `DO_NOT_TRACK=1` turns both off. The
  [privacy policy](https://www.runners.io/privacy) gained a section on them in the same release.

## Before 0.4.0

The `0.3` releases sent runners.io nothing of their own. In short: 0.3.16 watches only your own pull requests unless
you opt in; 0.3.15 goes through a company proxy and finds a fork's pull request on the repository it was forked from;
0.3.14 added the setup checks at launch and `/runners-io:doctor`; 0.3.13 added repository scopes; 0.3.0 made every
event say what to do, and added per-session mutes. The tags and their commits hold the detail.
