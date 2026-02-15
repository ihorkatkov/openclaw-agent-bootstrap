import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

/** In-memory log of all received requests */
const requestLog = [];

/**
 * Route a chat completion based on the last user message content.
 * Returns OpenAI-compatible response objects.
 */
function routeResponse(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const content = lastUser?.content ?? "";

  // --- Gatekeeper: blocked exec via deny rule (rm -rf /) ---
  if (content.includes("blocked-exec")) {
    return {
      tool_calls: [
        {
          id: "call_blocked_exec",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "rm -rf /" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: allowed exec (echo hello) ---
  if (content.includes("allowed-exec")) {
    return {
      tool_calls: [
        {
          id: "call_allowed_exec",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "echo hello" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: blocked read (non-workspace path) ---
  if (content.includes("blocked-read-env")) {
    return {
      tool_calls: [
        {
          id: "call_blocked_read",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ file_path: ".env" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: allow-list rejection (curl not in allow list) ---
  if (content.includes("allowlist-reject")) {
    return {
      tool_calls: [
        {
          id: "call_allowlist_reject",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "curl http://example.com" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: write to /etc/passwd (blocked by write deny rules) ---
  if (content.includes("blocked-write")) {
    return {
      tool_calls: [
        {
          id: "call_blocked_write",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({
              file_path: "/etc/passwd",
              content: "hacked",
            }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: web_fetch SSRF to metadata endpoint ---
  if (content.includes("blocked-ssrf")) {
    return {
      tool_calls: [
        {
          id: "call_blocked_ssrf",
          type: "function",
          function: {
            name: "web_fetch",
            arguments: JSON.stringify({
              url: "http://169.254.169.254/latest/meta-data/",
            }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: tool name normalization (bash -> exec) ---
  if (content.includes("alias-bash")) {
    return {
      tool_calls: [
        {
          id: "call_alias_bash",
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "rm -rf /" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: unknown tool (no rules, should passthrough) ---
  if (content.includes("unknown-tool")) {
    return {
      tool_calls: [
        {
          id: "call_unknown",
          type: "function",
          function: {
            name: "custom_widget",
            arguments: JSON.stringify({ data: "test" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: bypass attempt — cat ./.env (path traversal) ---
  if (content.includes("bypass-dotslash-env")) {
    return {
      tool_calls: [
        {
          id: "call_bypass_dotslash",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "cat ./.env" }),
          },
        },
      ],
    };
  }

  // --- Gatekeeper: bypass attempt — read with filePath (camelCase param) ---
  if (content.includes("param-camelcase")) {
    return {
      tool_calls: [
        {
          id: "call_param_camel",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ filePath: "/etc/shadow" }),
          },
        },
      ],
    };
  }

  // --- Vault inject: exec with {{API_KEY}} placeholder ---
  if (content.includes("vault-inject")) {
    return {
      tool_calls: [
        {
          id: "call_vault_inject",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: "echo {{API_KEY}}" }),
          },
        },
      ],
    };
  }

  // --- Vault inject: second vault entry (GITHUB_TOKEN) ---
  if (content.includes("vault-github")) {
    return {
      tool_calls: [
        {
          id: "call_vault_github",
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({
              command: "echo {{GITHUB_TOKEN}}",
            }),
          },
        },
      ],
    };
  }

  // --- Leak: model returns text containing a real vault secret ---
  if (content.includes("leak-secret")) {
    return {
      content: "Here is the key: sk-test-secret-value-12345 enjoy!",
    };
  }

  // --- Leak: model returns text with a pattern-matching secret (ghp_) ---
  if (content.includes("leak-pattern")) {
    return {
      content:
        "Use this GitHub token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
  }

  // --- Leak: model returns text with Bearer token (sanitizer pattern) ---
  if (content.includes("leak-bearer")) {
    return {
      content:
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 use this",
    };
  }

  // --- Default: simple text response ---
  return { content: "Hello from fake-llm!" };
}

/**
 * POST /v1/chat/completions — OpenAI-compatible endpoint
 */
app.post("/v1/chat/completions", (req, res) => {
  const { messages, model, tools } = req.body;

  // Log the full request for test assertions
  requestLog.push({
    timestamp: Date.now(),
    messages,
    model,
    tools,
  });

  const routed = routeResponse(messages ?? []);

  const choice = {};
  if (routed.tool_calls) {
    choice.message = {
      role: "assistant",
      content: null,
      tool_calls: routed.tool_calls,
    };
    choice.finish_reason = "tool_calls";
  } else {
    choice.message = {
      role: "assistant",
      content: routed.content,
    };
    choice.finish_reason = "stop";
  }

  res.json({
    id: `chatcmpl-fake-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "fake-model",
    choices: [{ index: 0, ...choice }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
});

/**
 * GET /v1/models — OpenAI-compatible models list
 */
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "fake-model",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "fake-llm",
      },
    ],
  });
});

/**
 * GET /v1/log — Return all logged requests (for test assertions)
 */
app.get("/v1/log", (_req, res) => {
  res.json(requestLog);
});

/**
 * DELETE /v1/log — Clear logged requests between test runs
 */
app.delete("/v1/log", (_req, res) => {
  requestLog.length = 0;
  res.json({ cleared: true });
});

/**
 * Health check
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`fake-llm listening on :${PORT}`);
});
