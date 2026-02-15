import type { SecretVault } from "./vault.js";

/**
 * Builds a system prompt context hint for the model explaining
 * the Aegis firewall plugin and available vault placeholders.
 */
export function buildSystemPromptHint(
  vault: SecretVault,
  options?: { opaqueVaultNames?: boolean },
): string {
  const lines: string[] = [
    "[Aegis Firewall Active]",
    "",
    "This agent is protected by the Aegis security plugin.",
    "",
    "Secret access:",
    "- Use {{KEY_NAME}} syntax to reference secrets in tool parameters.",
    "- Aegis will inject the real value before the tool executes.",
    "- Never hardcode or guess secret values — always use placeholders.",
  ];

  const names = vault.placeholders;
  if (names.length > 0) {
    lines.push("");
    lines.push("Available secret placeholders:");

    if (options?.opaqueVaultNames) {
      // Reveal only generic numbered names to prevent the model from inferring secret purposes
      for (let i = 0; i < names.length; i++) {
        lines.push(`  - {{SECRET_${i + 1}}}`);
      }
    } else {
      for (const name of names) {
        lines.push(`  - {{${name}}}`);
      }
    }
  }

  lines.push("");
  lines.push("Tool filtering:");
  lines.push(
    "- Some tool calls may be blocked by security rules.",
  );
  lines.push(
    "- If a call is blocked, you will receive an error with guidance. Adjust your approach and retry.",
  );

  return lines.join("\n");
}
