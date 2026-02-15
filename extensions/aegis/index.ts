import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AegisConfig, ToolRuleSet } from "./src/types.js";
import { DEFAULT_AEGIS_CONFIG } from "./src/defaults.js";
import { SecretVault } from "./src/vault.js";
import { Sanitizer } from "./src/sanitizer.js";
import { Gatekeeper } from "./src/gatekeeper.js";
import { buildSystemPromptHint } from "./src/system-prompt.js";

/**
 * Deep-merge tool rules: concatenate user deny patterns onto defaults,
 * user allow patterns replace defaults (intentional override).
 */
function deepMergeToolRules(
  defaultRules: Record<string, ToolRuleSet>,
  userRules: Record<string, ToolRuleSet> | undefined,
  logger?: { warn?: (...args: unknown[]) => void },
): Record<string, ToolRuleSet> {
  if (!userRules) return { ...defaultRules };

  const merged: Record<string, ToolRuleSet> = { ...defaultRules };

  for (const [toolName, userRule] of Object.entries(userRules)) {
    const defaultRule = merged[toolName];

    if (!defaultRule) {
      // No default — use user config as-is
      merged[toolName] = userRule;
      continue;
    }

    if (defaultRule.deny?.length || defaultRule.allow?.length) {
      logger?.warn?.(
        `aegis: user config overrides tool "${toolName}" which has default security rules — deny patterns will be concatenated`,
      );
    }

    // Concatenate deny arrays (security-additive)
    const mergedDeny = [
      ...(defaultRule.deny ?? []),
      ...(userRule.deny ?? []),
    ];

    // Allow: user replaces defaults (intentional override to open access)
    const mergedAllow = userRule.allow ?? defaultRule.allow;

    // Deep-merge paramRules
    const mergedParamRules = { ...(defaultRule.paramRules ?? {}) };
    if (userRule.paramRules) {
      for (const [param, userParamRule] of Object.entries(userRule.paramRules)) {
        const defaultParamRule = mergedParamRules[param];
        if (!defaultParamRule) {
          mergedParamRules[param] = userParamRule;
        } else {
          mergedParamRules[param] = {
            deny: [
              ...(defaultParamRule.deny ?? []),
              ...(userParamRule.deny ?? []),
            ],
            allow: userParamRule.allow ?? defaultParamRule.allow,
          };
        }
      }
    }

    merged[toolName] = {
      deny: mergedDeny.length > 0 ? mergedDeny : undefined,
      allow: mergedAllow,
      paramRules:
        Object.keys(mergedParamRules).length > 0 ? mergedParamRules : undefined,
      blockMessage: userRule.blockMessage ?? defaultRule.blockMessage,
    };
  }

  return merged;
}

export default function register(api: OpenClawPluginApi) {
  const raw = (api.pluginConfig ?? {}) as Partial<AegisConfig>;

  const config: AegisConfig = {
    vault: { ...DEFAULT_AEGIS_CONFIG.vault, ...raw.vault },
    sanitization: {
      ...DEFAULT_AEGIS_CONFIG.sanitization,
      ...raw.sanitization,
    },
    rules: {
      defaults: {
        ...DEFAULT_AEGIS_CONFIG.rules.defaults,
        ...raw.rules?.defaults,
      },
      tools: deepMergeToolRules(
        DEFAULT_AEGIS_CONFIG.rules.tools,
        raw.rules?.tools,
        api.logger,
      ),
    },
    systemPromptHint: raw.systemPromptHint ?? DEFAULT_AEGIS_CONFIG.systemPromptHint,
    logBlocked: raw.logBlocked ?? DEFAULT_AEGIS_CONFIG.logBlocked,
    opaqueVaultNames: raw.opaqueVaultNames ?? DEFAULT_AEGIS_CONFIG.opaqueVaultNames,
    circuitBreaker: raw.circuitBreaker,
  };

  const vault = new SecretVault(config.vault);
  const sanitizer = config.sanitization.enabled
    ? new Sanitizer(config.sanitization, api.logger)
    : null;
  const gatekeeper = new Gatekeeper(config.rules, {
    circuitBreaker: config.circuitBreaker,
    logger: api.logger,
  });

  api.logger.info?.("aegis: plugin loaded");

  // ---------------------------------------------------------------------------
  // Hook 1: before_tool_call (priority 100)
  // Outbound gatekeeper + secret injection
  // ---------------------------------------------------------------------------
  api.on(
    "before_tool_call",
    async (event) => {
      const { toolName, params } = event;

      // Step 1: Gatekeeper check
      const result = gatekeeper.check(
        toolName,
        (params ?? {}) as Record<string, unknown>,
      );
      if (!result.allowed) {
        if (config.logBlocked) {
          api.logger.warn?.(
            `aegis: blocked tool call "${toolName}" — ${result.reason}`,
          );
        }
        return { block: true, blockReason: result.reason };
      }

      // Step 2: Inject vault placeholders in params
      if (params && typeof params === "object") {
        const injected = vault.injectParams(params);
        return { params: injected };
      }
    },
    { priority: 100 },
  );

  // ---------------------------------------------------------------------------
  // Hook 2: tool_result_persist (priority 100, SYNCHRONOUS)
  // Deep-sanitize entire message objects before session transcript
  // ---------------------------------------------------------------------------
  api.on(
    "tool_result_persist",
    (event) => {
      const msg = event.message;
      if (!msg) return;

      const cloned = structuredClone(msg);

      // Deep-walk the entire message object instead of cherry-picking fields
      const scrubbed = sanitizer
        ? sanitizer.scrubAndSanitizeObject(cloned, vault)
        : vault.scrubObject(cloned);

      // Check if anything changed by comparing serialized forms
      const originalStr = JSON.stringify(msg);
      const scrubbedStr = JSON.stringify(scrubbed);

      if (scrubbedStr !== originalStr) {
        return { message: scrubbed };
      }
    },
    { priority: 100 },
  );

  // ---------------------------------------------------------------------------
  // Hook 3: before_agent_start (priority 50)
  // Inject system prompt hint
  // ---------------------------------------------------------------------------
  if (config.systemPromptHint) {
    api.on(
      "before_agent_start",
      async () => {
        const hint = buildSystemPromptHint(vault, {
          opaqueVaultNames: config.opaqueVaultNames,
        });
        return { prependContext: hint };
      },
      { priority: 50 },
    );
  }

  // ---------------------------------------------------------------------------
  // Hook 4: message_sending (priority 50)
  // Final safety net — scrub secrets from outgoing channel messages
  // ---------------------------------------------------------------------------
  api.on(
    "message_sending",
    async (event) => {
      if (typeof event.content === "string") {
        const scrubbed = scrubText(event.content, vault, sanitizer);
        if (scrubbed !== event.content) {
          return { content: scrubbed };
        }
      } else if (event.content && typeof event.content === "object") {
        // Handle non-string content (structured message objects)
        const scrubbed = sanitizer
          ? sanitizer.scrubAndSanitizeObject(event.content, vault)
          : vault.scrubObject(event.content);

        const originalStr = JSON.stringify(event.content);
        const scrubbedStr = JSON.stringify(scrubbed);

        if (scrubbedStr !== originalStr) {
          return { content: scrubbed };
        }
      }
    },
    { priority: 50 },
  );
}

/** Apply vault scrub then pattern sanitize to a string */
function scrubText(
  text: string,
  vault: SecretVault,
  sanitizer: Sanitizer | null,
): string {
  if (sanitizer) {
    return sanitizer.scrubAndSanitize(text, vault);
  }
  return vault.scrub(text);
}
