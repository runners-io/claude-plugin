---
description: Sign the runners.io MCP server in to runners.io, for runners.io customers who want to read their jobs, logs, test results, cache and spend. Use when the user asks to sign in to runners.io, or when a runners-io-mcp tool says it is not signed in. Not needed for the CI channel, which uses the GitHub login (see setup-github).
---

# Sign in to runners.io (the MCP server)

The plugin has two parts:

- **The CI channel** reads pull requests' CI from GitHub with the user's own GitHub login. It needs no runners.io account. To set it up, use the setup-github skill.
- **The runners.io MCP server** (`runners-io-mcp`, at `https://mcp.runners.io/mcp`) reads a runners.io organisation's jobs, logs, test results, cache and spend. It is for runners.io customers, and it signs in to runners.io.

Not a runners.io customer yet? Create an account at https://www.runners.io/signup first: signing in needs one, and the CI channel works without it.

To sign the MCP server in, ask the user to run `/mcp` in Claude Code, choose `runners-io-mcp` (or `runnersio`, if they added the server themselves before installing the plugin: Claude Code keeps one entry per address, so `/mcp` shows only that one), and choose to authenticate. A browser opens on runners.io, where they approve read access. An owner or admin of the organisation is also offered write access, in a box that is off by default: "Also let it cancel jobs and delete cache entries". Tick it only if they want Claude to be able to do those two things; read access is all the other tools need. Claude Code keeps the credential; nothing is stored by the plugin.

To sign out, they run `/mcp`, choose `runners-io-mcp` (or `runnersio`, if that is the one `/mcp` shows), and choose to clear its authentication.
