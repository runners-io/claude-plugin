/**
 * The two setup checks only the channel can make, for its `status` command (which the doctor skill runs): one live
 * call to GitHub, and whether the session `status` was run from has live CI events on. Every other check is in
 * hooks/readiness.mjs, shared with the SessionStart hook.
 */
import { type LaunchState, relaunchSentence } from "../../hooks/launch.mjs";
import type { Row } from "../../hooks/readiness.mjs";
import type { FirstCallRecorder } from "./firstcall.ts";
import type { GitHubClient } from "./github.ts";

/**
 * The setup checks' one live call: whether GitHub answers this login for the session's repository (or, in a folder
 * with none, for the login itself). The client reports what the answer says, so the record the rows below are read
 * from is as of now.
 */
export async function liveRow(client: GitHubClient, repo: string | null, firstCall: Pick<FirstCallRecorder, "fork"> | null): Promise<Row> {
  const id = "github_answers";
  const label = repo ? "GitHub answers for this repository" : "GitHub answers for this login";
  const r = repo ? await client.repoInfo(repo) : await client.viewerLogin();
  if (r.kind === "ok") {
    if (repo && typeof r.value === "object") firstCall?.fork(r.value.fork);
    return { id, label, state: "ready", why: "asked just now" };
  }
  if (r.kind === "auth") return { id, label, state: "skipped", why: "there is no login GitHub accepts: see the lines about gh and the login" };
  if (r.kind === "retry") return { id, label, state: "unknown", why: `could not ask GitHub: ${r.reason}` };
  return {
    id,
    label,
    state: "not_ready",
    effect: "blocks",
    line: "GitHub doesn't show this repository to the signed-in login, so its CI can't be read.",
    fix:
      "Usually one of three things: a private repository and a login with no repo scope (the user types `! gh auth refresh --scopes repo` in the prompt), " +
      "an organisation whose single sign-on the login is not authorised for (run a gh read in the repository, such as `gh pr list`, and give the user the link it prints), " +
      "or the wrong GitHub account (`gh auth status` shows which is active). Check with `gh repo view`, then offer the fix that fits, asking first.",
  };
}

/** Whether this session was started with the channel flag, when `status` is run from inside one (the doctor skill). */
export function channelRow(state: LaunchState): Row {
  const id = "channel_off";
  const label = "live CI events are on in this session";
  if (state === "on") return { id, label, state: "ready" };
  if (state === "headless") return { id, label, state: "skipped", why: "a headless run (claude -p) takes no channel" };
  if (state === "unknown") return { id, label, state: "unknown", why: "not run from inside a Claude Code session, or its flags cannot be read" };
  return {
    id,
    label,
    state: "not_ready",
    effect: "degrades",
    line: "this session was started without the channel flag, so CI results are not pushed into it; CI on request (ci_status) still works.",
    fix: `Tell the user to ${relaunchSentence(null)}. If they have no claude-gh command, offer to set it up by the /runners-io:setup-github skill's step 5, asking first.`,
  };
}
