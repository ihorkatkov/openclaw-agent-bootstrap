export interface VaultConfig {
  [placeholder: string]: string;
}

export interface SanitizationConfig {
  enabled: boolean;
  useDefaultPatterns: boolean;
  extraPatterns: string[];
  replacement: string;
}

export interface ParamRules {
  allow?: string[];
  deny?: string[];
}

export interface ToolRuleSet {
  allow?: string[];
  deny?: string[];
  paramRules?: Record<string, ParamRules>;
  blockMessage?: string;
}

export interface RulesConfig {
  defaults: ToolRuleSet;
  tools: Record<string, ToolRuleSet>;
}

export interface CircuitBreakerConfig {
  maxBlocked: number;
  windowMs: number;
  action: "suspend" | "warn";
}

export interface AegisConfig {
  vault: VaultConfig;
  sanitization: SanitizationConfig;
  rules: RulesConfig;
  systemPromptHint: boolean;
  logBlocked: boolean;
  opaqueVaultNames: boolean;
  circuitBreaker?: CircuitBreakerConfig;
}
