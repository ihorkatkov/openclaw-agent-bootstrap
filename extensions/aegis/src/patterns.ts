/**
 * Default secret-detection regex patterns.
 * Mirrors OpenClaw's src/logging/redact.ts built-in set.
 */
export const DEFAULT_SECRET_PATTERNS: string[] = [
  // ENV-style assignments: KEY=value, TOKEN: value, etc.
  String.raw`(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)\s*[=:]\s*\S+`,

  // JSON string fields: "apiKey": "value", "token": "value", etc.
  String.raw`"(?:apiKey|api_key|token|secret|password|passwd|accessToken|access_token|refreshToken|refresh_token)"\s*:\s*"[^"]*"`,

  // CLI flags: --api-key value, --token=value, etc.
  String.raw`--(?:api-key|token|secret|password|api_key)\s+\S+`,
  String.raw`--(?:api-key|token|secret|password|api_key)=\S+`,

  // Authorization: Bearer tokens (18+ chars)
  String.raw`Bearer\s+[A-Za-z0-9\-._~+/]+=*(?:\s|$)`,

  // PEM private key blocks
  String.raw`-----BEGIN\s[\w\s]*PRIVATE\sKEY-----[\s\S]*?-----END\s[\w\s]*PRIVATE\sKEY-----`,

  // Common token prefixes
  String.raw`sk-[A-Za-z0-9]{20,}`,         // OpenAI
  String.raw`ghp_[A-Za-z0-9]{36,}`,         // GitHub personal access token
  String.raw`github_pat_[A-Za-z0-9_]{20,}`, // GitHub fine-grained PAT
  String.raw`xox[baprs]-[A-Za-z0-9\-]+`,    // Slack bot/app/user tokens
  String.raw`xapp-[A-Za-z0-9\-]+`,          // Slack app-level token
  String.raw`gsk_[A-Za-z0-9]{20,}`,         // Groq
  String.raw`AIza[A-Za-z0-9\-_]{30,}`,      // Google API key
  String.raw`pplx-[A-Za-z0-9]{20,}`,        // Perplexity
  String.raw`npm_[A-Za-z0-9]{20,}`,         // npm

  // AWS access key
  String.raw`AKIA[A-Z0-9]{16}`,

  // Stripe keys
  String.raw`sk_live_[A-Za-z0-9]{20,}`,
  String.raw`pk_live_[A-Za-z0-9]{20,}`,
  String.raw`rk_live_[A-Za-z0-9]{20,}`,

  // JWT tokens
  String.raw`eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+`,

  // Database connection strings
  String.raw`(?:postgres|mysql|mongodb|redis):\/\/[^\s]+`,

  // Twilio account SID / auth token
  String.raw`SK[a-f0-9]{32}`,

  // SendGrid API key
  String.raw`SG\.[A-Za-z0-9_-]+`,

  // Colon-separated secrets (e.g. numeric_id:long_token)
  String.raw`\b\d{6,}:[A-Za-z0-9\-._~+/]{20,}\b`,
];

/** Tool group definitions matching OpenClaw's tool-policy.ts */
export const TOOL_GROUPS: Record<string, string[]> = {
  "group:fs": ["read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process"],
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_get"],
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "session_status",
  ],
  "group:ui": ["browser", "canvas"],
  "group:automation": ["cron", "gateway"],
  "group:messaging": ["message"],
};

/** Tool name aliases matching OpenClaw's normalizeToolName */
export const TOOL_ALIASES: Record<string, string> = {
  bash: "exec",
  shell: "exec",
  run: "exec",
  execute: "exec",
  cmd: "exec",
  command: "exec",
  "apply-patch": "apply_patch",
};

export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().trim();
  return TOOL_ALIASES[lower] ?? lower;
}
