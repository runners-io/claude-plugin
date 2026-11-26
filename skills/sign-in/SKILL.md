---
description: Optional, and only for runners.io customers. Add the runners.io MCP server to Claude Code and sign it in, so Claude can read a runners.io organisation's jobs, logs, test results, cache and spend. Use when the user asks to sign in to runners.io or to connect their runners.io account, or says the runners.io tools went away after the plugin was updated. Never needed for the plugin's CI features, which use the GitHub login (see setup-github).
---

# Sign in to runners.io (optional, for runners.io customers)

**The plugin needs no runners.io account.** Its CI channel, its tools, its hooks and its other skills read GitHub with the user's own GitHub login, for any repository that uses GitHub Actions. Nothing here is needed for any of that. If the user has no runners.io account, there is nothing to sign in to: say so in one line and stop.

Not a runners.io customer yet? Nothing in the plugin needs an account, so never tell the user to make one for it; if they ask about runners.io's own runners, an account is made at https://www.runners.io/signup.

This skill is for a runners.io customer who wants Claude to read their organisation's jobs, logs, test results, cache and spend. That is the runners.io MCP server, at `https://mcp.runners.io/mcp`, and it is not part of the plugin.

**Up to version 0.4.1 the plugin installed this server itself, as `runners-io-mcp`.** From 0.4.2 it does not, so that a session of somebody who does not use runners.io connects to nothing of ours. A customer who updated finds `runners-io-mcp` gone from `/mcp`, and its tools with it. The steps below bring it back, under the name `runnersio`; they sign in again once, because Claude Code keeps a sign-in per entry.

## 1. See whether it is there already

Ask the user to run `/mcp`. If it lists a server at `https://mcp.runners.io/mcp` (usually named `runnersio`, when they added it themselves), go to step 3.

## 2. Add it, with the user's yes

Ask the user first, in these words or close to them:

> Add the runners.io MCP server to your Claude Code user configuration? It is for runners.io customers. Claude Code then connects to `https://mcp.runners.io/mcp` at the start of every session, in every project; until you sign in, that connection carries no token and nothing from your session.

Run it only if the user says yes. This is the whole command:

```
claude mcp add --transport http --scope user runnersio https://mcp.runners.io/mcp
```

It writes one entry, `runnersio`, to the user's own Claude Code configuration (`~/.claude.json`) and answers `Added HTTP MCP server runnersio with URL: https://mcp.runners.io/mcp to user config`. It changes nothing else. If `/mcp` does not show `runnersio` afterwards, the user restarts Claude Code.

If the user says no, add nothing and do not ask again in this session.

## 3. Sign in

The user runs `/mcp`, chooses `runnersio` (or whatever name the entry at `https://mcp.runners.io/mcp` has), and chooses to authenticate. A browser opens on runners.io, where they approve read access. An owner or admin of the organisation is also offered write access, in a box that is off by default: "Also let it cancel jobs and delete cache entries". Tick it only if they want Claude to be able to do those two things; read access is all the other tools need. Claude Code keeps the credential; the plugin stores nothing.

## To sign out, or to take it out again

To sign out: `/mcp`, choose the entry, and clear its authentication. To remove the server altogether, so that Claude Code stops connecting to it:

```
claude mcp remove runnersio --scope user
```
