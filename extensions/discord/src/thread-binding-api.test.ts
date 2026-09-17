// Discord tests cover the bundled thread binding public API artifact, which
// core reads without loading the full plugin.
import { describe, expect, it } from "vitest";
import { defaultTopLevelPlacement, resolveInboundConversation } from "../thread-binding-api.js";

describe("Discord thread binding public API", () => {
  it("advertises child placement for top-level Discord channels", () => {
    expect(defaultTopLevelPlacement).toBe("child");
  });

  it("keeps canonical channel conversation ids for top-level targets", () => {
    expect(
      resolveInboundConversation({ to: "channel:1484662120149684238", isGroup: true }),
    ).toEqual({ conversationId: "channel:1484662120149684238" });
  });

  it("resolves thread conversations with their parent channel", () => {
    expect(
      resolveInboundConversation({
        to: "channel:1510164477642014740",
        threadId: "1510164477642014740",
        threadParentId: "1510164477642014999",
        isGroup: true,
      }),
    ).toEqual({
      conversationId: "1510164477642014740",
      parentConversationId: "channel:1510164477642014999",
    });
  });

  it("rejects targets that carry no Discord conversation", () => {
    expect(resolveInboundConversation({ isGroup: true })).toBeNull();
  });
});
