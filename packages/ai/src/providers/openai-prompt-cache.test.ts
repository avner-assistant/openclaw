import { describe, expect, it } from "vitest";
import { resolveOpenAIResponsesCacheParams } from "./openai-prompt-cache.js";

describe("OpenAI Responses prompt caching", () => {
  it.each(["short", "long"] as const)("uses Astra's 30-minute TTL for %s caching", (retention) => {
    expect(
      resolveOpenAIResponsesCacheParams(
        { id: "gpt-6-astra", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
        retention,
        true,
      ),
    ).toEqual({ prompt_cache_options: { ttl: "30m" } });
  });

  it("does not apply Astra's first-party contract to custom endpoints", () => {
    expect(
      resolveOpenAIResponsesCacheParams(
        { id: "gpt-6-astra", api: "openai-responses", baseUrl: "https://proxy.example/v1" },
        "long",
        true,
      ),
    ).toEqual({ prompt_cache_retention: "24h" });
  });

  it("preserves the existing long-retention contract for other models", () => {
    expect(
      resolveOpenAIResponsesCacheParams(
        { id: "gpt-5.6-sol", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
        "long",
        true,
      ),
    ).toEqual({ prompt_cache_retention: "24h" });
  });
});
