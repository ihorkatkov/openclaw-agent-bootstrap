#!/usr/bin/env node

/**
 * Aegis E2E Test Runner
 *
 * Runs inside the openclaw:local container. Sends messages to the gateway
 * via the OpenClaw CLI and queries the fake-llm log endpoint for assertions.
 *
 * Uses Node.js built-in test runner (node:test).
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FAKE_LLM_URL = process.env.FAKE_LLM_URL ?? "http://fake-llm:8080";
const CLI_PATH = "node";
const CLI_ARGS = ["dist/index.js", "agent"];

/** Per-test timeout (ms) */
const TEST_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clear the fake-llm request log between tests */
async function clearLog() {
  await fetch(`${FAKE_LLM_URL}/v1/log`, { method: "DELETE" });
}

/** Get all logged requests from the fake-llm */
async function getLog() {
  const res = await fetch(`${FAKE_LLM_URL}/v1/log`);
  return res.json();
}

/**
 * Assert that the fake-llm log does NOT contain a tool result
 * for the given call_id — meaning the gateway blocked it before
 * the tool ever executed and reported back.
 */
async function assertToolCallBlocked(callId) {
  const log = await getLog();
  // If the tool was blocked, the gateway should not send a follow-up
  // request containing a tool-role message referencing this call_id.
  const toolResults = log.flatMap((entry) =>
    (entry.messages ?? []).filter(
      (m) => m.role === "tool" && m.tool_call_id === callId,
    ),
  );
  assert.equal(
    toolResults.length,
    0,
    `Expected tool call "${callId}" to be blocked (no tool result in LLM log), but found ${toolResults.length} tool result(s)`,
  );
}

/**
 * Assert that CLI output (stdout+stderr) contains Aegis block messaging.
 * Uses the specific blockMessage strings from the fixture config.
 */
function assertOutputContainsBlock(result, blockMessage) {
  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes(blockMessage) ||
      /blocked by aegis/i.test(combined) ||
      /aegis.*block/i.test(combined),
    `Expected "${blockMessage}" (or Aegis block indicator) in output, got:\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`,
  );
}

/**
 * Send a single message to the agent via the OpenClaw CLI.
 *
 * Uses `agent -m "..." --agent main --json` for non-interactive one-shot
 * message delivery through the gateway.
 *
 * Returns { stdout, stderr, exitCode }.
 */
async function sendMessage(message, { timeout = 30_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      CLI_PATH,
      [...CLI_ARGS, "-m", message, "--agent", "main", "--json"],
      {
        timeout,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        cwd: "/app",
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    // Non-zero exit (e.g. blocked tool call) — still capture output
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? 1,
    };
  }
}

/**
 * Wait for the fake-llm to be reachable (gateway readiness is handled
 * by Docker's depends_on: condition: service_healthy).
 */
async function waitForFakeLlm(maxRetries = 30, intervalMs = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${FAKE_LLM_URL}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("fake-llm did not become ready in time");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Aegis E2E", () => {
  before(async () => {
    await waitForFakeLlm();
    await clearLog();
  });

  afterEach(async () => {
    await clearLog();
  });

  // =========================================================================
  // Hook 1: Gatekeeper
  // =========================================================================
  describe("Hook 1: Gatekeeper", () => {
    // --- Deny rule match ---
    it("should block exec with rm -rf / (deny rule)", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("blocked-exec");
      await assertToolCallBlocked("call_blocked_exec");
    });

    // --- Allow-list: non-workspace path for read ---
    it("should block read of non-workspace path", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("blocked-read-env");
      await assertToolCallBlocked("call_blocked_read");
    });

    // --- Allow-list rejection: curl not in exec allow list ---
    it("should block exec not matching allow list (curl)", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("allowlist-reject");
      await assertToolCallBlocked("call_allowlist_reject");
    });

    // --- Write tool: deny /etc/ path ---
    it("should block write to /etc/passwd", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("blocked-write");
      await assertToolCallBlocked("call_blocked_write");
    });

    // --- web_fetch SSRF: cloud metadata endpoint ---
    it("should block web_fetch to cloud metadata endpoint", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("blocked-ssrf");
      await assertToolCallBlocked("call_blocked_ssrf");
    });

    // --- Tool name normalization: bash -> exec ---
    it("should apply exec rules when tool name is 'bash' (alias)", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("alias-bash");
      await assertToolCallBlocked("call_alias_bash");
    });

    // --- Allow: echo hello ---
    it("should allow safe exec (echo hello)", { timeout: TEST_TIMEOUT }, async () => {
      const result = await sendMessage("allowed-exec");
      const combined = result.stdout + result.stderr;

      // Should NOT contain Aegis block message
      assert.ok(
        !combined.includes("Shell command blocked by Aegis"),
        `Expected allowed exec, but got block:\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`,
      );
    });

    // --- Unknown tool: no rules, should not be blocked ---
    it("should pass through unknown tool with no matching rules", { timeout: TEST_TIMEOUT }, async () => {
      const result = await sendMessage("unknown-tool");
      const combined = result.stdout + result.stderr;

      assert.ok(
        !combined.includes("blocked by Aegis"),
        `Expected unknown tool to pass through, but got block:\n${combined}`,
      );
    });
  });

  // =========================================================================
  // Hook 1: Gatekeeper — bypass attempts
  // =========================================================================
  describe("Hook 1: Gatekeeper bypass attempts", () => {
    // --- cat ./.env should be caught by paramRules deny ---
    it("should block cat ./.env (dotslash bypass)", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("bypass-dotslash-env");
      await assertToolCallBlocked("call_bypass_dotslash");
    });

    // --- filePath (camelCase) should be caught by paramRules key normalization ---
    it("should block read with filePath param (camelCase key normalization)", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("param-camelcase");
      await assertToolCallBlocked("call_param_camel");
    });
  });

  // =========================================================================
  // Hook 1+2: Vault inject + scrub roundtrip
  // =========================================================================
  describe("Hook 1+2: Vault inject/scrub roundtrip", () => {
    it("should inject {{API_KEY}} and scrub result from LLM log", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("vault-inject");

      const log = await getLog();

      // The raw secret should NOT appear in tool-role messages sent to the LLM
      const toolResultMessages = log.flatMap((entry) =>
        (entry.messages ?? []).filter((m) => m.role === "tool"),
      );
      const toolResultStr = JSON.stringify(toolResultMessages);

      assert.ok(
        !toolResultStr.includes("sk-test-secret-value-12345"),
        `Raw secret found in tool results sent to LLM:\n${toolResultStr}`,
      );
    });

    it("should inject {{GITHUB_TOKEN}} and scrub result", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("vault-github");

      const log = await getLog();
      const toolResultMessages = log.flatMap((entry) =>
        (entry.messages ?? []).filter((m) => m.role === "tool"),
      );
      const toolResultStr = JSON.stringify(toolResultMessages);

      assert.ok(
        !toolResultStr.includes(
          "ghp_testvaulttoken000000000000000000000000",
        ),
        `Raw GITHUB_TOKEN found in tool results sent to LLM:\n${toolResultStr}`,
      );
    });
  });

  // =========================================================================
  // Hook 3: System prompt injection
  // =========================================================================
  describe("Hook 3: System prompt hint", () => {
    it("should inject Aegis context with placeholder names", { timeout: TEST_TIMEOUT }, async () => {
      await sendMessage("hello");

      const log = await getLog();

      // Search all messages in the log (prependContext may appear in any role)
      const allMessages = log.flatMap((entry) => entry.messages ?? []);
      const allStr = JSON.stringify(allMessages);

      assert.ok(
        allStr.includes("[Aegis Firewall Active]"),
        `Expected "[Aegis Firewall Active]" in LLM messages, got:\n${allStr.slice(0, 2000)}...`,
      );

      assert.ok(
        allStr.includes("{{API_KEY}}"),
        `Expected "{{API_KEY}}" placeholder listed in LLM messages, got:\n${allStr.slice(0, 2000)}...`,
      );

      assert.ok(
        allStr.includes("{{GITHUB_TOKEN}}"),
        `Expected "{{GITHUB_TOKEN}}" placeholder listed in LLM messages, got:\n${allStr.slice(0, 2000)}...`,
      );
    });
  });

  // =========================================================================
  // Hook 4: Message sending scrub
  // =========================================================================
  describe("Hook 4: Message sending scrub", () => {
    it("should scrub vault secret (sk-test-...) from outgoing messages", { timeout: TEST_TIMEOUT }, async () => {
      const result = await sendMessage("leak-secret");

      assert.ok(
        !result.stdout.includes("sk-test-secret-value-12345"),
        `Raw vault secret leaked to user output:\n${result.stdout}`,
      );
    });

    it("should scrub pattern-matched ghp_ token from outgoing messages", { timeout: TEST_TIMEOUT }, async () => {
      const result = await sendMessage("leak-pattern");

      assert.ok(
        !result.stdout.includes(
          "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
        `Pattern-matched GitHub PAT leaked to user output:\n${result.stdout}`,
      );
    });

    it("should scrub Bearer/JWT token from outgoing messages", { timeout: TEST_TIMEOUT }, async () => {
      const result = await sendMessage("leak-bearer");

      assert.ok(
        !result.stdout.includes("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"),
        `Bearer/JWT token leaked to user output:\n${result.stdout}`,
      );
    });
  });
});
