---
description: Check that this machine is ready for the runners.io plugin, show what is not, and offer the fix. Use when the user runs /runners-io:doctor, asks whether the plugin is set up or why CI results are not arriving, when the plugin's launch notice names a setup problem, and again after any fix to confirm it worked.
---

# runners.io doctor

The plugin needs a few things on this machine: Node.js 20 or later, the GitHub CLI (`gh`) signed in, git, and a GitHub repository to watch. The doctor runs every check, shows each one as ready or not, offers the fix for what is not, and checks again after a fix. The plugin runs most of the same checks by itself at every launch; this is the full list, with one live call to GitHub.

## 1. Run the checks

Run this with the Bash tool, in the session's folder. This skill's base directory is `<plugin>/skills/doctor`, so the plugin's folder is two levels up:

```
node "<this skill's base directory>/../../channel/dist/runners-io-channel.mjs" status --telemetry-setting '${user_config.telemetry}'
```

Keep the last argument exactly as it is written here, single quotes included. It is the plugin's telemetry setting, which a command you run cannot read for itself: Claude Code writes the saved setting (`on` or `off`) in its place, and leaves it as it is when the user never changed the setting, which the command reads as the default, on.

It reads the GitHub login the way the channel does, asks GitHub once whether it shows the folder's repository to that login (and once for the branch's open pull request; in a fork, once more, of the repository it was forked from, where a fork's pull request usually lives), and prints the login, the repository, the branch, the pull request, and then the checks. One line says whether telemetry is on (the install ping and reports of the plugin's own faults: the README's "Telemetry"), and when it is off, which setting turned it off: the plugin's own `telemetry` setting, or a variable in the environment. To turn it off, the user sets the plugin's `telemetry` option to `off` in `/config` (or `/plugin`, runners-io, configure), or sets `RUNNERS_IO_TELEMETRY=off`; it is their choice, so change it only when they ask. The command itself sends nothing to runners.io unless its own code fails, and prints no token and no install ID.

Three lines are usually `ready` and say more in brackets when there is something to know:

- **"GitHub is reached directly, or through a proxy the channel can use"**: behind a company proxy (`HTTPS_PROXY`) it names the proxy's host and port, or says that `NO_PROXY` names GitHub's host. It never shows a proxy's user name or password, and neither should you: do not print the variable's value.
- **"a fork's pull request on the repository it was forked from is found"**: in a fork it says how the fork was recognised (an `upstream` remote, or GitHub's own answer). The "pull request:" line above the checks then names the repository the pull request is on.
- **"Claude Code can deliver live CI events here"**: `NOT READY` when Claude Code runs on Amazon Bedrock, Google Cloud's Agent Platform (Vertex AI) or Microsoft Foundry, where there are no channel events. Nothing fixes that from here: do not offer the channel flag or `claude-gh`, and read CI with the `ci_status` tool when asked.

If `node` is not found, or is older than 20, that is the first thing to fix: nothing else in the plugin can run. Offer to help install Node.js, asking first: `brew install node` on macOS, `winget install OpenJS.NodeJS.LTS` on Windows, the distribution's package or nvm on Linux. Claude Code must be restarted afterwards.

## 2. Show the result

Every check is one line:

| the line starts with | meaning |
|---|---|
| `ready` | nothing to do |
| `NOT READY` | the line says what is wrong, then `Fix:` and what to offer. In brackets: its effect, and the check's id |
| `unknown` | it could not be told (the reason is in brackets). Never report this as ready |
| `skipped` | it depends on a check above it that is not ready |

The effect is one of three. `blocks`: the plugin cannot read CI at all. `degrades`: part of it works. `info`: there is nothing to fix; it explains what the plugin will not do here.

Tell the user in plain words: which lines are not ready, the most serious first (`blocks`, then `degrades`, then `info`), and that the rest are ready. Do not paste the whole table unless they ask for it.

## 3. Offer the fix, and ask first

For each `NOT READY` line that has a fix, offer what its `Fix:` says, one at a time, the most serious first. **Change nothing without a yes.**

- Installing something follows the `/runners-io:setup-github` skill: ask, then use the method for the user's system.
- A command that needs `sudo`, an administrator prompt, a browser or a one-time code is the user's own to run. Give it to them to type in the prompt with a leading `!` (for example `! gh auth login --hostname github.com --web --scopes repo`), so it runs in this session.
- Never ask for a token to be pasted into the conversation, never print one, and never put one on a command line.
- An `info` line needs no fix. Say it once, and leave it.

## 4. Check again

After each fix, run step 1 again and read the same line. Say that it now reads `ready`; if it does not, say so and what the line says now. A fix is not done until its line is ready.

## 5. A no

If the user does not want a fix, leave it. So that the plugin does not offer it again at the next launches, record the no with the check's id (the second word in the line's brackets):

```
node "<this skill's base directory>/../../hooks/readiness.mjs" decline <id>
```

That fix is then not offered again for 7 days. A `blocks` line still shows as one line at launch, because nothing works without it. `RUNNERS_IO_NO_SETUP_CHECKS=1` in the environment Claude Code starts from turns every offer off.

## Without the channel's bundle

`node "<this skill's base directory>/../../hooks/readiness.mjs" check` prints the checks that need no network: the same table, without the live call and without the line about live CI events.
