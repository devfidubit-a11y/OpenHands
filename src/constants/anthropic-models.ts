/**
 * Current-generation Claude models Canvas always offers under the
 * ``anthropic`` provider on local backends.
 *
 * The local agent-server's verified-model list ships with the SDK release it
 * was pinned to, so a newly released Claude model is missing from the picker
 * until the server is upgraded. LiteLLM routes any ``anthropic/<id>`` to the
 * Anthropic Messages API, so these ids work with an ``ANTHROPIC_API_KEY`` on
 * any server that already supports the provider. They are merged into the
 * server's verified list, never replacing it.
 *
 * Ids are the exact Anthropic model ids, without date suffixes.
 */
export const ANTHROPIC_PROVIDER = "anthropic";

export const CURRENT_CLAUDE_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
];

/**
 * Returns ``verifiedByProvider`` with {@link CURRENT_CLAUDE_MODELS} merged
 * into the ``anthropic`` entry (server order first, then any missing current
 * models). Other providers are passed through untouched.
 */
export function withCurrentClaudeModels(
  verifiedByProvider: Record<string, string[]>,
): Record<string, string[]> {
  const existing = verifiedByProvider[ANTHROPIC_PROVIDER] ?? [];
  const seen = new Set(existing);
  const missing = CURRENT_CLAUDE_MODELS.filter((id) => !seen.has(id));
  if (missing.length === 0) return verifiedByProvider;
  return {
    ...verifiedByProvider,
    [ANTHROPIC_PROVIDER]: [...missing, ...existing],
  };
}
