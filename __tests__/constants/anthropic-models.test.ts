import { describe, expect, it } from "vitest";
import {
  CURRENT_CLAUDE_MODELS,
  withCurrentClaudeModels,
} from "#/constants/anthropic-models";

describe("withCurrentClaudeModels", () => {
  it("adds the current Claude models when the server lists no anthropic models", () => {
    // Arrange
    const verified = { openai: ["gpt-5"] };

    // Act
    const merged = withCurrentClaudeModels(verified);

    // Assert
    expect(merged.anthropic).toEqual([...CURRENT_CLAUDE_MODELS]);
    expect(merged.openai).toEqual(["gpt-5"]);
  });

  it("keeps server-listed anthropic models and does not duplicate ones it already has", () => {
    const serverList = [CURRENT_CLAUDE_MODELS[0], "claude-opus-4-8"];

    const merged = withCurrentClaudeModels({ anthropic: serverList });

    expect(merged.anthropic).toEqual(
      expect.arrayContaining([...CURRENT_CLAUDE_MODELS, "claude-opus-4-8"]),
    );
    expect(new Set(merged.anthropic).size).toBe(merged.anthropic.length);
  });

  it("returns the same map when every current model is already verified", () => {
    const verified = { anthropic: [...CURRENT_CLAUDE_MODELS] };

    expect(withCurrentClaudeModels(verified)).toBe(verified);
  });
});
