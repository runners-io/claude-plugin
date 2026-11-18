/**
 * Logging goes to stderr only. stdout is the MCP transport, and one stray line
 * there corrupts the JSON-RPC stream. Claude Code copies a stdio server's
 * stderr into its debug log (`claude --debug`), so everything written here is
 * redacted first: a bearer token or a GitHub token never reaches a log, even through an error message that
 * quoted a response body.
 */
const SECRET_FIELDS = /("?(?:access_token|refresh_token|code_verifier|code|token|client_secret)"?\s*[:=]\s*"?)([^"&\s,}]+)/gi;

/** GitHub's token shapes: gho_/ghp_/ghu_/ghs_/ghr_ and fine-grained github_pat_. */
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,})/g;

export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"',]+/gi, "$1[redacted]")
    .replace(SECRET_FIELDS, "$1[redacted]")
    .replace(GITHUB_TOKEN, "[redacted]");
}

let quiet = false;

/** Tests silence the log; production never does. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function log(message: string): void {
  if (quiet) return;
  process.stderr.write(`[runners-io-channel] ${redact(message)}\n`);
}
