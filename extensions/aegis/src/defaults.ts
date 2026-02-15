import type { AegisConfig } from "./types.js";

export const DEFAULT_AEGIS_CONFIG: AegisConfig = {
  vault: {},

  sanitization: {
    enabled: true,
    useDefaultPatterns: true,
    extraPatterns: [],
    replacement: "[REDACTED]",
  },

  rules: {
    defaults: { deny: [] },
    tools: {
      // -----------------------------------------------------------------------
      // EXEC — Allow-list architecture: deny all by default, allow safe commands
      // -----------------------------------------------------------------------
      exec: {
        deny: [String.raw`.*`],
        allow: [
          String.raw`^ls\b`,
          String.raw`^git\s+(status|log|diff|show|branch)`,
          String.raw`^npm\s+(test|run|list)`,
          String.raw`^node\s`,
          String.raw`^echo\b`,
          String.raw`^cat\b(?!.*\.env)`,
          String.raw`^pwd$`,
          String.raw`^whoami$`,
          String.raw`^date$`,
          String.raw`^wc\b`,
          String.raw`^sort\b`,
          String.raw`^head\b`,
          String.raw`^tail\b`,
          String.raw`^grep\b`,
          String.raw`^find\b`,
          String.raw`^mkdir\b`,
          String.raw`^cp\b`,
          String.raw`^mv\b`,
        ],
        paramRules: {
          command: {
            deny: [
              String.raw`rm\s+-rf\s+/(?!tmp)`,
              String.raw`curl.*\|\s*sh`,
              String.raw`cat\s+.*\.env`,
            ],
          },
        },
        blockMessage:
          "Shell command blocked by Aegis. Only safe, allow-listed commands are permitted.",
      },

      // -----------------------------------------------------------------------
      // READ — Allow-list: only workspace-relative paths
      // -----------------------------------------------------------------------
      read: {
        deny: [String.raw`.*`],
        allow: [String.raw`^\.\/`, String.raw`^\/workspace\/`],
        paramRules: {
          file_path: {
            allow: [String.raw`^\.\/`, String.raw`^\/workspace\/`],
            deny: [
              String.raw`\.ssh\/`,
              String.raw`\.env$`,
              String.raw`\/etc\/shadow`,
              String.raw`\/etc\/passwd`,
              String.raw`\.aws\/`,
              String.raw`\/proc\/`,
            ],
          },
          filePath: {
            allow: [String.raw`^\.\/`, String.raw`^\/workspace\/`],
            deny: [
              String.raw`\.ssh\/`,
              String.raw`\.env$`,
              String.raw`\/etc\/shadow`,
              String.raw`\/etc\/passwd`,
              String.raw`\.aws\/`,
              String.raw`\/proc\/`,
            ],
          },
        },
        blockMessage: "File read blocked by Aegis. Only workspace paths are permitted.",
      },

      // -----------------------------------------------------------------------
      // WRITE — Allow-list: only workspace-relative paths
      // -----------------------------------------------------------------------
      write: {
        deny: [String.raw`.*`],
        allow: [String.raw`^\.\/`, String.raw`^\/workspace\/`],
        paramRules: {
          file_path: {
            allow: [String.raw`^\.\/`, String.raw`^\/workspace\/`],
            deny: [
              String.raw`^\/etc\/`,
              String.raw`^\/usr\/`,
              String.raw`\.ssh\/`,
              String.raw`\.env$`,
              String.raw`^\/proc\/`,
              String.raw`^\/sys\/`,
            ],
          },
          filePath: {
            allow: [String.raw`^\.\/`, String.raw`^\/workspace\/`],
            deny: [
              String.raw`^\/etc\/`,
              String.raw`^\/usr\/`,
              String.raw`\.ssh\/`,
              String.raw`\.env$`,
              String.raw`^\/proc\/`,
              String.raw`^\/sys\/`,
            ],
          },
        },
        blockMessage: "File write blocked by Aegis. Target path is restricted.",
      },

      // -----------------------------------------------------------------------
      // WEB_FETCH — Expanded SSRF deny list
      // -----------------------------------------------------------------------
      web_fetch: {
        paramRules: {
          url: {
            deny: [
              // IPv4 loopback and link-local
              String.raw`127\.`,
              "localhost",
              String.raw`169\.254\.`,
              String.raw`0\.0\.0\.0`,

              // IPv6 loopback and unspecified
              String.raw`\[::1\]`,
              String.raw`\[::\]`,

              // Private ranges (RFC 1918)
              String.raw`10\.`,
              String.raw`172\.1[6-9]\.`,
              String.raw`172\.2[0-9]\.`,
              String.raw`172\.3[01]\.`,
              String.raw`192\.168\.`,

              // Cloud metadata endpoints
              String.raw`metadata\.google\.`,
              String.raw`metadata\.aws\.internal`,

              // Decimal/hex/octal IP encoding bypass attempts
              "2130706433",
              String.raw`0x7f`,
              String.raw`0177\.`,

              // Dangerous protocols
              String.raw`^file:\/\/`,
              String.raw`^gopher:\/\/`,
              String.raw`^dict:\/\/`,
            ],
          },
        },
        blockMessage:
          "URL blocked by Aegis. Internal/metadata endpoints and dangerous protocols are restricted.",
      },

      // -----------------------------------------------------------------------
      // SESSIONS — Default deny: must be explicitly allowed by user config
      // -----------------------------------------------------------------------
      sessions_send: {
        deny: [String.raw`.*`],
        blockMessage:
          "Session send blocked by Aegis. Session messaging must be explicitly allowed in config.",
      },
      sessions_spawn: {
        deny: [String.raw`.*`],
        blockMessage:
          "Session spawn blocked by Aegis. Session spawning must be explicitly allowed in config.",
      },
    },
  },

  systemPromptHint: true,
  logBlocked: true,
  opaqueVaultNames: false,
};
