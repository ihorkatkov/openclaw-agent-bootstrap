# Aegis Firewall Plugin

Bidirectional security firewall for OpenClaw agents. Protects against secret leakage, dangerous tool calls, and SSRF attacks using an allow-list-first architecture with defense-in-depth scrubbing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          OpenClaw Agent Runtime                        │
│                                                                        │
│  ┌──────────┐    ┌─────────────┐    ┌───────────┐    ┌──────────────┐  │
│  │  LLM     │───▸│ before_tool │───▸│   Tool    │───▸│ tool_result  │  │
│  │  Model   │    │   _call     │    │ Execution │    │   _persist   │  │
│  │          │◂───│  (Hook 1)   │    │           │    │  (Hook 2)    │  │
│  └──────────┘    └─────────────┘    └───────────┘    └──────────────┘  │
│       │                                                     │          │
│       │          ┌─────────────┐                            │          │
│       │          │before_agent │                            │          │
│       │          │   _start    │     Session Transcript ◂───┘          │
│       │          │  (Hook 3)   │     (secrets scrubbed)                │
│       │          └─────────────┘                                       │
│       ▼                                                                │
│  ┌──────────┐    ┌─────────────┐    ┌───────────────────┐              │
│  │ Outbound │───▸│  message    │───▸│ Channel (Telegram │              │
│  │ Message  │    │  _sending   │    │ WhatsApp, Discord)│              │
│  │          │    │  (Hook 4)   │    │                   │              │
│  └──────────┘    └─────────────┘    └───────────────────┘              │
└─────────────────────────────────────────────────────────────────────────┘
```

## Hook Lifecycle

Aegis registers four hooks in the OpenClaw plugin system. Each intercepts a different phase of the agent execution pipeline.

### Hook 1: `before_tool_call` (Priority 100, Async)

Runs before every tool execution. Two-step pipeline:

```
Tool call arrives (toolName + params)
    │
    ▼
┌───────────────────────┐
│   Circuit Breaker     │──▸ Too many blocks? Suspend all calls
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│   Gatekeeper Check    │──▸ Deny rule matched? BLOCK
│                       │──▸ Allow list exists but no match? BLOCK
│   • Normalize name    │
│   • Resolve rule set  │
│   • Check deny/allow  │
│   • Check param rules │
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│   Vault Injection     │──▸ {{API_KEY}} → real secret value
│                       │
│   Deep-walk all       │
│   string fields       │
└───────────┬───────────┘
            ▼
        Tool executes with real credentials
```

### Hook 2: `tool_result_persist` (Priority 100, Synchronous)

Runs after tool execution, before the result is stored in the session transcript:

```
Tool result message
    │
    ▼
┌───────────────────────┐
│   structuredClone()   │──▸ Clone to avoid mutating original
└───────────┬───────────┘
            ▼
┌───────────────────────┐
│   Deep Object Scrub   │──▸ Walk ALL fields (not just .text)
│                       │
│   1. Vault scrub      │──▸ real value → {{PLACEHOLDER}}
│   2. Encoding scrub   │──▸ base64/hex encoded → {{PLACEHOLDER}}
│   3. Pattern sanitize │──▸ regex catch → [REDACTED]
└───────────┬───────────┘
            ▼
        Scrubbed message persisted to transcript
```

### Hook 3: `before_agent_start` (Priority 50, Async)

Runs once when the agent session initializes:

```
Agent starting
    │
    ▼
┌───────────────────────┐
│  Build system prompt   │
│  hint with:            │
│  • Available secrets   │──▸ {{API_KEY}}, {{DB_PASS}}, ...
│    (or opaque names)   │──▸ {{SECRET_1}}, {{SECRET_2}}, ...
│  • Usage instructions  │
│  • Blocked call guide  │
└───────────┬───────────┘
            ▼
        Hint prepended to agent context
```

### Hook 4: `message_sending` (Priority 50, Async)

Final safety net before messages reach external channels:

```
Outbound message (string or structured object)
    │
    ├─ String content ──────▸ scrubText()
    │                            │
    ├─ Object content ──────▸ scrubAndSanitizeObject()
    │                            │
    └────────────────────────────▼
                           Scrubbed message sent to channel
```

## Gatekeeper Resolution

When a tool call arrives, the gatekeeper resolves which rule set applies:

```
Tool name (e.g. "bash")
    │
    ▼
┌──────────────────────┐
│  1. Normalize name   │──▸ bash → exec, shell → exec, cmd → exec
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  2. Exact match      │──▸ rules.tools["exec"] exists? Use it
└──────────┬───────────┘
           ▼ (no match)
┌──────────────────────┐
│  3. Group match      │──▸ exec ∈ group:runtime? Use group rule
└──────────┬───────────┘
           ▼ (no match)
┌──────────────────────┐
│  4. Defaults         │──▸ Use rules.defaults
└──────────┬───────────┘
           ▼ (no defaults)
        ALLOWED (no rules apply)
```

### Deny/Allow Evaluation Order

For each resolved rule set:

```
1. Check top-level DENY against JSON.stringify(params)
   └─ Match? → BLOCK immediately

2. Check top-level ALLOW (if list exists)
   └─ No match? → BLOCK (allow-list enforcement)

3. For each param rule (with key normalization: file_path ↔ filePath):
   a. Check param DENY
      └─ Match? → BLOCK
   b. Check param ALLOW (if list exists)
      └─ No match? → BLOCK

4. All checks passed → ALLOWED
```

## Scrubbing Pipeline

Three layers of defense against secret leakage:

```
                    ┌─────────────────────────────────┐
                    │       Layer 1: Vault Scrub       │
                    │                                   │
  Input text ──────▸│  Literal match (longest first):   │
                    │  "sk-abc123..." → {{API_KEY}}     │
                    │                                   │
                    │  Combined regex from all vault     │
                    │  values, sorted by length desc     │
                    └──────────────┬────────────────────┘
                                   ▼
                    ┌─────────────────────────────────┐
                    │    Layer 2: Encoding Scrub       │
                    │                                   │
                    │  Base64 of vault values:          │
                    │  "c2stYWJjMTIz" → {{API_KEY}}    │
                    │                                   │
                    │  Hex of vault values:             │
                    │  "736b2d61626331323..." → {{...}} │
                    └──────────────┬────────────────────┘
                                   ▼
                    ┌─────────────────────────────────┐
                    │   Layer 3: Pattern Sanitizer     │
                    │                                   │
                    │  30+ regex patterns:              │
                    │  • OpenAI sk-*, GitHub ghp_*      │
                    │  • AWS AKIA*, Stripe sk_live_*    │
                    │  • JWT eyJ*.eyJ*, PEM blocks      │
                    │  • DB URIs, Bearer tokens         │
                    │  • ENV assignments, JSON fields   │
                    │                                   │
                    │  Caught → [REDACTED]              │
                    └──────────────┬────────────────────┘
                                   ▼
                              Scrubbed output
```

All deep-walk operations use `WeakSet`-based circular reference protection to handle self-referential objects safely.

## Config Merge Strategy

User configuration from `openclaw.json` is deep-merged with defaults using security-additive rules:

```
Default config                    User config
     │                                 │
     ▼                                 ▼
┌──────────┐                    ┌──────────┐
│  deny:   │──── CONCATENATE ───│  deny:   │──▸ Both arrays combined
│  [".*"]  │                    │  ["foo"] │    [".*", "foo"]
└──────────┘                    └──────────┘
┌──────────┐                    ┌──────────┐
│  allow:  │──── REPLACE ───────│  allow:  │──▸ User's array wins
│  ["^ls"] │                    │  ["^cat"]│    ["^cat"]
└──────────┘                    └──────────┘
┌──────────┐                    ┌──────────┐
│  param   │──── DEEP MERGE ───│  param   │──▸ deny concatenated,
│  Rules   │                    │  Rules   │    allow replaced
└──────────┘                    └──────────┘
```

**Key invariant**: Default deny patterns can never be removed by user config. They can only be supplemented.

## Default Security Posture

### Allow-Listed Tools (deny-all + explicit allow)

| Tool | Default Allowed | Blocked |
|------|----------------|---------|
| `exec` | `ls`, `git status/log/diff/show/branch`, `npm test/run/list`, `node`, `echo`, `cat` (not .env), `pwd`, `whoami`, `date`, `wc`, `sort`, `head`, `tail`, `grep`, `find`, `mkdir`, `cp`, `mv` | Everything else |
| `read` | Paths starting with `./` or `/workspace/` | `.ssh/`, `.env`, `/etc/shadow`, `/etc/passwd`, `.aws/`, `/proc/` |
| `write` | Paths starting with `./` or `/workspace/` | `/etc/`, `/usr/`, `.ssh/`, `.env`, `/proc/`, `/sys/` |
| `sessions_send` | Nothing (must be explicitly allowed) | All |
| `sessions_spawn` | Nothing (must be explicitly allowed) | All |

### Deny-Listed Parameters

| Tool | Param | Blocked Patterns |
|------|-------|-----------------|
| `web_fetch` | `url` | `127.*`, `localhost`, `169.254.*`, `0.0.0.0`, `[::1]`, `[::]`, `10.*`, `172.16-31.*`, `192.168.*`, `metadata.google.*`, `metadata.aws.internal`, decimal/hex/octal IPs, `file://`, `gopher://`, `dict://` |

### Param Key Normalization

Rules defined for `file_path` automatically apply to `filePath` (and vice versa), preventing bypass via casing variation.

## Circuit Breaker

Optional rate-limiting mechanism to detect and halt adversarial probing:

```
┌─────────────────────────────────────────────────┐
│                 Sliding Window                   │
│                                                  │
│  Time ─────────────────────────────────────▸     │
│                                                  │
│  ✗ ✗   ✗     ✗  ✗                               │
│  │ │   │     │  │                                │
│  blocked calls within windowMs                   │
│                                                  │
│  Count >= maxBlocked?                            │
│  ├─ action: "suspend" → BLOCK ALL tool calls     │
│  └─ action: "warn"    → Log warning, continue    │
└─────────────────────────────────────────────────┘
```

Config example:
```json
{
  "circuitBreaker": {
    "maxBlocked": 5,
    "windowMs": 60000,
    "action": "suspend"
  }
}
```

## File Structure

```
extensions/aegis/
├── openclaw.plugin.json          # Plugin manifest with JSON Schema
├── package.json                  # Package metadata
├── README.md                     # This file
├── index.ts                      # Entry point — registers 4 hooks, config merge
└── src/
    ├── types.ts                  # AegisConfig, CircuitBreakerConfig, ToolRuleSet
    ├── defaults.ts               # Allow-list default rules for all tools
    ├── vault.ts                  # Bidirectional secret vault with encoding awareness
    ├── sanitizer.ts              # Regex-based secret detection (30+ patterns)
    ├── gatekeeper.ts             # Per-tool allow/deny engine with pre-compiled regexes
    ├── patterns.ts               # Secret patterns + tool groups + aliases
    └── system-prompt.ts          # System prompt context builder
```

## Configuration Reference

Set in `openclaw.json` under `plugins.entries.aegis.config`:

```jsonc
{
  // Secret vault: placeholder name → real value
  "vault": {
    "API_KEY": "sk-...",
    "DB_PASSWORD": "hunter2"
  },

  // Pattern-based sanitization
  "sanitization": {
    "enabled": true,              // Enable regex secret detection
    "useDefaultPatterns": true,   // Include built-in 30+ patterns
    "extraPatterns": [],          // Additional regex patterns
    "replacement": "[REDACTED]"   // Replacement text
  },

  // Tool access rules
  "rules": {
    "defaults": { "deny": [] },   // Fallback rules
    "tools": {
      "exec": {
        "deny": [".*"],           // Deny-all base
        "allow": ["^ls\\b"],      // Explicit allow-list
        "paramRules": {
          "command": {
            "deny": ["rm\\s+-rf"],
            "allow": []
          }
        },
        "blockMessage": "Custom block message"
      }
    }
  },

  // System prompt hint injection
  "systemPromptHint": true,

  // Log blocked tool calls
  "logBlocked": true,

  // Hide real placeholder names from model
  "opaqueVaultNames": false,

  // Optional circuit breaker
  "circuitBreaker": {
    "maxBlocked": 5,
    "windowMs": 60000,
    "action": "suspend"
  }
}
```
