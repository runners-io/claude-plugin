# runners.io plugin for Claude Code

Your pull requests' CI reaches your Claude Code session as it happens. A workflow starts, fails, passes or waits for a
deployment approval, or the pull request gets a merge conflict, and Claude is told within about half a minute. It can
read the failed job's log and fix it without being asked to go and look.

The plugin bundles four things:

- **A CI channel**: a small local process that reads your pull requests' CI **from GitHub, with your own GitHub login**,
  and pushes each change into the session. It needs no runners.io account, works for any repository that uses GitHub
  Actions, and sends nothing to runners.io. Channels are a Claude Code
  [research preview](https://code.claude.com/docs/en/channels.md#research-preview), and this channel is in research
  preview too.
- **Tools to choose what to watch**, per session: `subscribe`, `unsubscribe`, `list_subscriptions` and `ci_status`.
- **A hook** that, when Claude opens a pull request (`gh pr create`, or a GitHub MCP server's `create_pull_request`),
  prompts it to subscribe to that pull request.
- **The runners.io MCP server** (`https://mcp.runners.io/mcp`), for runners.io customers: tools to read your jobs, logs,
  test results, cache and spend.

And the skills `watch-this-pr`, `fix-failing-ci`, `setup-github` and `sign-in`.

The channel works in the Claude Code terminal app, while the session is open.

## Install

You need Claude Code v2.1.80 or later, Node.js 20 or later, and the [GitHub CLI](https://cli.github.com) (`gh`) signed
in to github.com. If you don't have `gh`, the plugin's `setup-github` skill walks Claude through installing it, with
your agreement, and you sign in with `! gh auth login --web --scopes repo`.

```bash
claude plugin marketplace add runners-io/claude-plugin
claude plugin install runners-io@runners-io
```

Or from inside a session: `/plugin marketplace add runners-io/claude-plugin`, then `/plugin install runners-io@runners-io`.

runners.io customers sign the MCP server in the first time they use it: run `/mcp`, choose `runners-io-mcp`, and
approve on runners.io. The channel does not need this.

## Turn the channel on

A channel only delivers in a session that opts it in when it starts. Start Claude Code in your repository with:

```bash
claude --channels plugin:runners-io@runners-io
```

**During the research preview, `--channels` accepts only plugins on Anthropic's allowlist, and this one is not on it
yet.** Until it is, start with the development flag instead:

```bash
claude --dangerously-load-development-channels plugin:runners-io@runners-io
```

Claude Code shows a warning first. Choose **I am using this for local development** to continue. Neither flag
appears in `claude --help` during the preview, and both work anyway.

**A shorter command: `claude-gh`.** Ask Claude to run `/runners-io:setup-github`. After asking you, it adds a separate
`claude-gh` command to your shell's rc file (zsh, bash or fish), between `# >>> runners.io claude channel >>>` and
`# <<< runners.io claude channel <<<` markers, so it can be taken out exactly. `claude` itself is unchanged. Then
`claude-gh` starts a session with the channel on, and `claude-gh --resume <session id>` reopens one with it on. Until
the plugin is on the allowlist, `claude-gh` uses the development flag, so the warning shows at every launch.

Without either flag, the tools and the hook still load, but nothing is pushed: Claude can call `ci_status` to read a
pull request's state on demand. **The plugin tells you so at launch**, in one line with the command that relaunches
that same session with the channel on. The line is not shown in `claude -p`, or after `/clear` or `/compact`. In such
a session the channel does not poll GitHub, because nothing it pushed would arrive.

### Team and Enterprise organisations

On claude.ai Team and Enterprise plans, channels are off until an Owner turns them on: **Organization settings →
Claude Code → Channels**, or `"channelsEnabled": true` in managed settings. While the plugin is not on Anthropic's
allowlist, an admin can approve it for the organisation in managed settings instead of everyone using the
development flag:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "runners-io", "plugin": "runners-io" }
  ]
}
```

`allowedChannelPlugins` replaces Anthropic's list for your organisation, so include any other channel plugins you
use. Pro, Max and Ultra accounts outside an organisation skip both settings.

## Choosing what to watch

**Automatically:** the pull request for the branch your session's folder is on. The channel reads the repository from
`git remote get-url origin` and the branch from `git branch --show-current`, and follows you when you switch branch.
Turn this off with the channel's `auto_subscribe` option (`pr` or `off`) in `/config`, or when the plugin is enabled.

**By Claude, per session**, with the channel's tools:

| tool | what it does |
|---|---|
| `subscribe` | watch a pull request (`repo` and `pr`; by default the current branch's), optionally only some `events`. It answers the PR's state now; after that only changes are pushed |
| `unsubscribe` | stop watching one pull request, every one in a repository, or everything (`all: true`) |
| `list_subscriptions` | what this session watches |
| `ci_status` | a pull request's state now, without subscribing |

Subscriptions live in the channel's process, so each session has its own, and they end with the session. A merged or
closed pull request ends its own subscription.

**When Claude opens a pull request**, the plugin's hook prompts it to subscribe. That matters when the pull request is
opened from another worktree or repository, which the automatic watch cannot see. Claude Code asks before the first
`subscribe` call like any tool; to allow the channel's tools without asking, add this to your settings:

```json
{ "permissions": { "allow": ["mcp__plugin_runners-io_runners-io__*"] } }
```

## What you get

Each change arrives as one line, with attributes Claude can route on:

```text
<channel source="runners-io" kind="ci.workflow_failed" repo="acme/widgets" pr="123" branch="fix-login" sha="3f2a9c1…" workflow="CI" run_id="4242" conclusion="failure" url="https://github.com/acme/widgets/actions/runs/4242">
CI failed: "CI" on PR #123 (fix-login @ 3f2a9c1), failed jobs: lint, test-unit. https://github.com/acme/widgets/actions/runs/4242 Read the failed job's log (gh run view 4242 --repo acme/widgets --log-failed) before changing anything.
</channel>
```

| kind | when |
|---|---|
| `ci.workflow_started` | CI starts on a new head commit: one event per push, with how many workflows started (`workflows`); further starts on the same commit, re-runs included, are logged but not sent |
| `ci.workflow_succeeded`, `ci.workflow_failed`, `ci.workflow_cancelled` | a run finishes (failed covers failure, timed out and startup failure) |
| `ci.approval_waiting` | a run waits for an environment's required reviewers, or a fork's run waits for a maintainer to approve it |
| `ci.run_all_done` | every run for the head commit has finished: one summary, with the worst result |
| `pr.conflict`, `pr.conflict_resolved` | the pull request starts or stops conflicting with its base branch |
| `pr.merged`, `pr.closed` | the pull request is merged or closed; the channel stops watching it |
| `ci.current_state` | once, when the automatic watch starts on a pull request that is already failing, waiting or conflicted |
| `ci.flaky` | a re-run of the same commit passed after its previous attempt failed |
| `pr.head_moved` | the branch on GitHub moved to a commit that is not this session's own (not its HEAD or behind it): a person, another session or worktree, or a merge queue pushed or force-pushed it (only for the session's own repository) |
| `pr.labels_changed` | labels were added or removed (the names are sent, cleaned) |
| `pr.ready_for_review`, `pr.converted_to_draft` | the pull request left or entered draft |
| `pr.body_edited` | the description changed; only the fact is sent, never the text |
| `base.red`, `base.green` | the base branch's latest push runs turned red, or green again; read once a minute |

The channel looks at GitHub every 20 seconds per watched pull request. It sends GitHub the previous answer's ETag,
and GitHub does not count an unchanged answer against your hourly API limit. When fewer than 200 requests are left in
the hour, it looks four times less often.

## What is sent, and what is never sent

**From your machine to GitHub, with your own `gh` login:** requests to read the watched pull requests, their workflow
runs and, for a failed run, its jobs. Nothing is written to GitHub.

**To runners.io:** nothing, by the channel. (The runners.io MCP server, if you sign it in, reads your runners.io
organisation's data from runners.io when Claude calls its tools.)

**Never sent, by the channel, to anyone:** your code, diffs or files, your prompts, the conversation, Claude's replies,
or anything else about the session.

**No reply path, no permission relay.** The channel's tools change only which pull requests this session watches.
The channel does **not** declare Claude Code's permission relay, so a CI event can never approve a tool call: approvals
stay in your terminal.

**Workflow, job and branch names are untrusted.** Anyone who can push a commit chooses them, including a fork's
author on a public repository. The channel cuts each to one line of plain text, removes `<` and `>`, shortens it,
keeps links only to GitHub and runners.io over https, and tells Claude to treat the text as a notification rather than
instructions.

**The token.** The channel asks `gh auth token` for it (or reads `GH_TOKEN` / `GITHUB_TOKEN` if you set one), keeps it
in memory, and never writes it to a file or a log.

## Security

**Your GitHub token.** The channel asks `gh auth token` for it when it starts, and again every few minutes, or reads
`GH_TOKEN` / `GITHUB_TOKEN` if you set one. It keeps it in memory only. It sends it in one place: the
`Authorization` header of its requests to `https://api.github.com` (or the https address in `RUNNERS_IO_GITHUB_API`,
for GitHub Enterprise). It never writes it to disk, never puts it on a command line, and never prints or logs it: every
line of the event log and of the channel's own log goes through a redaction of GitHub token shapes and bearer
headers first, which `channel/test/secrets.test.ts` and `channel/test/eventlog.test.ts` check. The events sent to
Claude are built from named fields of GitHub's answers and never include it.

**What the development-channels flag allows.** During the research preview, Claude Code loads only allowlisted
channels unless it is started with `--dangerously-load-development-channels plugin:runners-io@<marketplace>`. That flag
lifts the allowlist **for this one entry** and nothing else: it does not turn off permission prompts, it does not
apply to any other plugin or server, and your organisation's `channelsEnabled` policy still applies. On Team and
Enterprise plans, an admin can instead approve this plugin in `allowedChannelPlugins`. Read this repository's code
before you choose either.

**What the plugin runs on your machine.** `gh auth token`, `git` (to read the folder's remote, branch and commits),
`ps` (to see whether the session was started with the channel flag), and `node`. Each is started with a fixed list of
arguments, never through a shell with text from GitHub, and nothing from an event is ever run or evaluated. The
setup-github skill edits your shell's rc file only after asking you, and shows the lines first.

**Reporting a vulnerability.** See [SECURITY.md](SECURITY.md).

## Settings in the environment

These are read from the environment you start Claude Code from. None is needed.

| variable | default | what it does |
|---|---|---|
| `RUNNERS_IO_POLL_SECONDS` | `20` | seconds between looks at GitHub, 5 to 300 |
| `RUNNERS_IO_RATE_FLOOR` | `200` | below this many GitHub requests left in the hour, look four times less often. Raise it when the same `gh` login also drives other tools |
| `RUNNERS_IO_EVENT_LOG_DIR` | off | an absolute directory for the event log (below) |

### The event log

With `RUNNERS_IO_EVENT_LOG_DIR` set, the channel writes one JSON line per record to `<dir>/<UTC date>.jsonl`, and
deletes files older than 14 days. A record is one of these:

- each event it pushed or held back, with the time from GitHub's own timestamp to the push;
- each subscription and why it ended;
- each API error or setup problem;
- a heartbeat every five minutes, with the requests made.

It holds no token and no response body. The directory is 0700 and the files are 0600.

```bash
node scripts/event-log-summary.mjs --dir "$RUNNERS_IO_EVENT_LOG_DIR" --since 24h            # counts, latency, errors, gaps
node scripts/event-log-summary.mjs --dir "$RUNNERS_IO_EVENT_LOG_DIR" --since 24h --github   # and check against GitHub
```

`--github` uses your `gh` login to ask GitHub what happened on each pull request the log says was watched. It lists
as a miss any failed run, or any close or merge, that no session was sent. Merge conflicts are not checked, because
GitHub keeps no history of them.

The script exits 0 when it finds nothing, 1 on a miss, a gap or an error, and 2 when it could not evaluate.

## Troubleshooting

- **No events arrive.** Check that the session was started with the channel flag (above): if it was not, the plugin
  said so in a line at launch. Run `/mcp`: the
  `runners-io` server should be connected. Run `node …/channel/dist/runners-io-channel.mjs status` in the repository to
  see the GitHub login, the repository, the branch and the pull request the channel would watch. Start with
  `claude --debug …` and read the channel's lines (`[runners-io-channel]`) in `~/.claude/debug/<session>.txt`.
- **"the GitHub CLI (gh) is not installed / not signed in".** Ask Claude to use the `setup-github` skill.
- **"no repo scope", or "GitHub no longer shows PR #n".** A private repository needs a `gh` login with the `repo` scope:
  `gh auth refresh --hostname github.com --scopes repo`. An organisation that enforces SSO needs the token authorised
  for it.
- **"blocked by org policy".** Your organisation has not turned channels on; see Team and Enterprise above.
- **The channel connects but never registers.** The channel answers on MCP protocol revision 2025-11-25 or earlier,
  because Claude Code does not register a channel on 2026-07-28. If your Claude Code still does not register it, set
  `MCP_PROTOCOL_NEGOTIATION=legacy` in the environment you start Claude Code from.

## Development

The channel is TypeScript in `channel/src`, bundled to one file, `channel/dist/runners-io-channel.mjs`, so the plugin
installs nothing when it runs. The bundle is committed, and CI fails when it is missing or differs from a fresh build.
The hook is plain JavaScript in `hooks/`.

```bash
cd channel
npm ci
npm run typecheck
npm run build
npm test
```

The tests run against a fake GitHub (`channel/test/fake-github.mjs`). To try the plugin in a real session from a
checkout, run `claude --plugin-dir . --dangerously-load-development-channels plugin:runners-io@inline` in a repository
with an open pull request.

Check the manifest with `claude plugin validate . --strict`, and the plugin's own promises with
`node scripts/check-plugin.mjs`.

## Licence

MIT. See [LICENSE](LICENSE).
