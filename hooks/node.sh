#!/bin/sh
# Runs one of the plugin's hooks with Node.js, and says so when Node.js is missing or too old.
#
#   sh node.sh session-start <script.mjs>   at launch: with no Node.js 20 or later, prints the SessionStart JSON that
#                                           tells the user and gives Claude the install pointers, and exits 0
#   sh node.sh quiet <script.mjs>           after a tool call: with no Node.js, exits 0 and prints nothing
#
# Every hook and the CI channel are JavaScript, so without Node.js nothing else in the plugin can say what is wrong:
# the hook would fail with "node: command not found" in a log nobody reads. POSIX sh only, and no program but node
# and ps: on Windows this relies on Claude Code running hook commands through Git Bash.
kind=$1
shift

major=
if command -v node >/dev/null 2>&1; then
  # A hook after a tool call runs often, so it does not pay for a second Node.js start to read the version.
  [ "$kind" = session-start ] || exec node "$@"
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  [ "$major" -ge 20 ] && exec node "$@"
fi
[ "$kind" = session-start ] || exit 0

# Silent in a headless run (claude -p): scripts get no noise. The claude process is this one's parent, or its
# parent's, through shells; where ps is missing or says something else, this is taken for a session with a person.
headless() {
  set -f
  pid=$PPID
  hops=0
  while [ "$hops" -lt 6 ] && [ "${pid:-0}" -gt 1 ] 2>/dev/null; do
    row=$(ps -o ppid=,args= -p "$pid" 2>/dev/null) || return 1
    # shellcheck disable=SC2086 # split on purpose: the parent's pid, then the command's words
    set -- $row
    [ $# -ge 2 ] || return 1
    parent=$1
    shift
    case "$1 $2 $3" in
      claude\ * | */claude\ * | */claude/versions/* | *@anthropic-ai/claude-code/cli.*)
        for word in "$@"; do
          case "$word" in -p | --print) return 0 ;; esac
        done
        return 1
        ;;
    esac
    pid=$parent
    hops=$((hops + 1))
  done
  return 1
}
headless && exit 0

if [ -n "$major" ]; then
  have="this machine has Node.js $major"
else
  have="it isn't installed"
fi
line="runners.io: the plugin needs Node.js 20 or later and $have, so it can't run. Ask me to help you install it."
# RUNNERS_IO_NO_SETUP_CHECKS=1 turns the offer off; the one line is still shown, because nothing works without it.
if [ "${RUNNERS_IO_NO_SETUP_CHECKS:-}" = 1 ]; then
  printf '{"systemMessage":"%s"}\n' "$line"
  exit 0
fi
context="runners.io plugin: its hooks and its CI channel run on Node.js 20 or later, and $have (on the PATH Claude Code runs hooks with). The user has been shown one line saying so. Once in this session, early and at a natural moment, offer to help install it, and ask first: on macOS \`brew install node\`; on Windows \`winget install OpenJS.NodeJS.LTS\`; on Linux the distribution's package, or nvm (https://github.com/nvm-sh/nvm); https://nodejs.org has installers for all three. A command that needs sudo or an administrator prompt is the user's to run: give it to them to type in the prompt as \`! <command>\`. Claude Code must be restarted afterwards. If the user says no, do not offer it again in this session."
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$line" "$context"
exit 0
