import { TOOL_GROUPS, normalizeToolName } from "./patterns.js";
import type { CircuitBreakerConfig, RulesConfig, ToolRuleSet } from "./types.js";

export interface GatekeeperResult {
  allowed: boolean;
  reason?: string;
}

interface CompiledParamRules {
  allow?: RegExp[];
  deny?: RegExp[];
}

interface CompiledToolRuleSet {
  allow?: RegExp[];
  deny?: RegExp[];
  paramRules?: Record<string, CompiledParamRules>;
  blockMessage?: string;
}

/** Convert snake_case to camelCase: file_path -> filePath */
function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert camelCase to snake_case: filePath -> file_path */
function toSnakeCase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function tryCompileRegex(pattern: string, logger?: { warn?: (...args: unknown[]) => void }): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch (e) {
    logger?.warn?.(`aegis: invalid regex pattern "${pattern}", skipping: ${e}`);
    return null;
  }
}

function compilePatterns(
  patterns: string[] | undefined,
  logger?: { warn?: (...args: unknown[]) => void },
): RegExp[] | undefined {
  if (!patterns || patterns.length === 0) return undefined;
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    const re = tryCompileRegex(p, logger);
    if (re) compiled.push(re);
  }
  return compiled.length > 0 ? compiled : undefined;
}

function compileRuleSet(
  ruleSet: ToolRuleSet,
  logger?: { warn?: (...args: unknown[]) => void },
): CompiledToolRuleSet {
  const compiled: CompiledToolRuleSet = {
    blockMessage: ruleSet.blockMessage,
  };

  compiled.allow = compilePatterns(ruleSet.allow, logger);
  compiled.deny = compilePatterns(ruleSet.deny, logger);

  if (ruleSet.paramRules) {
    compiled.paramRules = {};
    for (const [paramName, paramRule] of Object.entries(ruleSet.paramRules)) {
      compiled.paramRules[paramName] = {
        allow: compilePatterns(paramRule.allow, logger),
        deny: compilePatterns(paramRule.deny, logger),
      };
    }
  }

  return compiled;
}

export class Gatekeeper {
  private compiledDefaults: CompiledToolRuleSet | undefined;
  private compiledTools: Map<string, CompiledToolRuleSet>;

  // Circuit breaker state
  private circuitBreaker: CircuitBreakerConfig | undefined;
  private blockedTimestamps: number[] = [];

  constructor(
    rules: RulesConfig,
    options?: {
      circuitBreaker?: CircuitBreakerConfig;
      logger?: { warn?: (...args: unknown[]) => void };
    },
  ) {
    const logger = options?.logger;
    this.circuitBreaker = options?.circuitBreaker;

    // Pre-compile all regex patterns at construction time
    this.compiledTools = new Map();
    for (const [toolName, ruleSet] of Object.entries(rules.tools)) {
      this.compiledTools.set(toolName, compileRuleSet(ruleSet, logger));
    }

    if (
      rules.defaults &&
      (rules.defaults.deny?.length ||
        rules.defaults.allow?.length ||
        rules.defaults.paramRules)
    ) {
      this.compiledDefaults = compileRuleSet(rules.defaults, logger);
    }
  }

  /** Check if a tool call with the given params is allowed */
  check(toolName: string, params: Record<string, unknown>): GatekeeperResult {
    // Circuit breaker check
    if (this.circuitBreaker) {
      const now = Date.now();
      const windowStart = now - this.circuitBreaker.windowMs;
      this.blockedTimestamps = this.blockedTimestamps.filter((t) => t > windowStart);

      if (this.blockedTimestamps.length >= this.circuitBreaker.maxBlocked) {
        if (this.circuitBreaker.action === "suspend") {
          return {
            allowed: false,
            reason: `Aegis circuit breaker: ${this.blockedTimestamps.length} calls blocked in ${this.circuitBreaker.windowMs}ms window. All tool calls suspended until window expires.`,
          };
        }
        // "warn" action — log but still evaluate normally
      }
    }

    const normalized = normalizeToolName(toolName);
    const ruleSet = this.resolveRuleSet(normalized);
    if (!ruleSet) {
      return { allowed: true };
    }

    // Check top-level deny/allow patterns against stringified params
    const paramString = JSON.stringify(params);

    const topDeny = this.matchesAny(paramString, ruleSet.deny);
    if (topDeny) {
      this.recordBlock();
      return {
        allowed: false,
        reason:
          ruleSet.blockMessage ??
          `Tool "${toolName}" blocked by Aegis deny rule.`,
      };
    }

    if (ruleSet.allow && ruleSet.allow.length > 0) {
      const topAllow = this.matchesAny(paramString, ruleSet.allow);
      if (!topAllow) {
        this.recordBlock();
        return {
          allowed: false,
          reason:
            ruleSet.blockMessage ??
            `Tool "${toolName}" blocked by Aegis — no allow rule matched.`,
        };
      }
    }

    // Check per-parameter rules with key normalization
    if (ruleSet.paramRules) {
      for (const [paramName, paramRule] of Object.entries(ruleSet.paramRules)) {
        // Normalize: check both snake_case and camelCase variants of the param
        const paramValue =
          params[paramName] ??
          params[toCamelCase(paramName)] ??
          params[toSnakeCase(paramName)];
        if (paramValue === undefined || paramValue === null) continue;

        const valueStr =
          typeof paramValue === "string"
            ? paramValue
            : JSON.stringify(paramValue);

        const denyMatch = this.matchesAny(valueStr, paramRule.deny);
        if (denyMatch) {
          this.recordBlock();
          return {
            allowed: false,
            reason:
              ruleSet.blockMessage ??
              `Tool "${toolName}" param "${paramName}" blocked by Aegis deny rule.`,
          };
        }

        if (paramRule.allow && paramRule.allow.length > 0) {
          const allowMatch = this.matchesAny(valueStr, paramRule.allow);
          if (!allowMatch) {
            this.recordBlock();
            return {
              allowed: false,
              reason:
                ruleSet.blockMessage ??
                `Tool "${toolName}" param "${paramName}" blocked by Aegis — no allow rule matched.`,
            };
          }
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Resolve rule set: exact tool name -> group match -> defaults.
   */
  private resolveRuleSet(toolName: string): CompiledToolRuleSet | undefined {
    // Exact match
    const exact = this.compiledTools.get(toolName);
    if (exact) return exact;

    // Group match — find which group(s) this tool belongs to
    for (const [groupName, members] of Object.entries(TOOL_GROUPS)) {
      if (members.includes(toolName)) {
        const groupRule = this.compiledTools.get(groupName);
        if (groupRule) return groupRule;
      }
    }

    // Defaults
    return this.compiledDefaults;
  }

  private matchesAny(
    value: string,
    patterns: RegExp[] | undefined,
  ): boolean {
    if (!patterns || patterns.length === 0) return false;
    return patterns.some((re) => re.test(value));
  }

  private recordBlock(): void {
    if (this.circuitBreaker) {
      this.blockedTimestamps.push(Date.now());
    }
  }
}
