---
description: Install the GitHub CLI (gh) and sign it in, so the runners.io CI channel can read pull requests' CI from GitHub. Use when a runners-io channel event of kind channel_github_setup_needed arrives, when a runners-io tool says gh is not installed or not signed in, or when the user asks to set up the runners.io channel.
---

# Set up GitHub for the runners.io channel

The runners.io CI channel reads your pull requests' CI from GitHub with **your own GitHub login**: the one the GitHub CLI (`gh`) holds. It sends nothing to runners.io. It needs `gh` installed and signed in to github.com. Once both are true, the channel starts watching by itself within about 20 seconds, with no restart.

## 1. Find out what is missing

Run `gh auth status --hostname github.com` with the Bash tool.

- **`command not found`** (or the Bash tool says gh does not exist): go to step 2.
- **"You are not logged into any GitHub hosts"**: go to step 3.
- **Logged in**: check the `Token scopes` line. For a private repository it must include `repo`. If it does not, go to step 3 and use `gh auth refresh --hostname github.com --scopes repo` instead of `gh auth login`. If it does, the channel should already work: call the runners-io `ci_status` tool to check.

## 2. Install gh (ask first)

Tell the user that the channel needs the GitHub CLI, and **ask before installing anything**. Then use the method for their system:

| system | command |
|---|---|
| macOS with Homebrew (`brew --version` works) | `brew install gh` |
| Windows | `winget install --id GitHub.cli` |
| Debian or Ubuntu | the apt instructions at https://github.com/cli/cli/blob/trunk/docs/install_linux.md (they add GitHub's apt repository first, which needs sudo) |
| Fedora, RHEL | `sudo dnf install gh` |
| anything else | point the user at https://cli.github.com and let them install it |

A command that needs `sudo` or an administrator prompt is the user's to run: give them the command, and ask them to type it in the prompt with a leading `!` (for example `! sudo dnf install gh`) so it runs in this session.

Confirm with `gh --version`.

## 3. Sign in (the user does this)

Signing in opens a browser and asks for a one-time code, so it must be the user's own command, not yours. Ask them to type this in the prompt:

```
! gh auth login --hostname github.com --web --scopes repo
```

The `repo` scope lets gh read CI on private repositories. Never ask for a token to be pasted into the conversation, and never put a token on a command line.

Confirm with `gh auth status --hostname github.com`.

## 4. Check the channel

Call the runners-io `ci_status` tool, which defaults to the current branch's pull request. If it answers the PR's state, the channel works. If the session was not started with the channel on, results are not pushed: the plugin showed the user a line at launch saying so. Offer step 5, and use `ci_status` meanwhile.

## 5. Offer a `claude-gh` command (ask first)

The plugin's SessionStart hook also brings you here: while the user has no `claude-gh`, it asks you to offer it once in the session. If they say no, run `node "<this skill's base directory>/claude-gh.mjs" decline` so it is not offered again for 7 days, and leave it.

Live CI events reach a session only when Claude Code is started with the channel flag, which is long to type. Offer the user a separate command, `claude-gh`, that starts Claude Code with it. Plain `claude` is never changed. The script `claude-gh.mjs` in this skill's base directory does the edit, so it is the same every time.

1. Run `node "<this skill's base directory>/claude-gh.mjs" show`. It prints the shell (zsh, bash or fish, from `$SHELL`), the rc file, and the exact lines, and changes nothing.
2. Show the user those lines and the file, and say three things:
   - the lines go between `# >>> runners.io claude channel >>>` and `# <<< runners.io claude channel <<<`, so they can be taken out exactly;
   - until the channel is on Claude Code's approved list, `claude-gh` uses the development flag, which shows a confirmation screen at every launch;
   - a copy of the file as it was is kept next to it, as `<file>.before-runners-io`.

   **Ask whether to add them. Do not write the file without a yes.**
3. On a yes, run `node "<base directory>/claude-gh.mjs" add`. Then check it the way the script says, for example `zsh -ic 'type claude-gh'`; it must print that claude-gh is a shell function. Tell the user that terminals already open need a new tab, or `source` of the file.
4. If the script refuses because the file already defines `claude-gh`, leave the file alone and tell the user what it found.
5. **Undo:** `node "<base directory>/claude-gh.mjs" remove` takes the lines out and leaves the rest of the file as it was.

If the shell is not zsh, bash or fish, the script says so: give the user the command from step 1's output to add by hand.

After that, `claude-gh` starts a session with live CI events, and `claude-gh --resume <session id>` reopens a session with them on.
