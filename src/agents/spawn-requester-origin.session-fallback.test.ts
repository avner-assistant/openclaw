// Spawn requester-origin session-fallback tests prove thread-bound spawns can
// still resolve the requester conversation when the current turn carries no
// inbound delivery target (heartbeat, cron, steer, or agent-to-agent runs).
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";

function writeSessionStore(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "spawn-requester-origin-"));
  const storePath = path.join(dir, "sessions.json");
  writeFileSync(storePath, JSON.stringify(entries), "utf8");
  return storePath;
}

const REQUESTER_SESSION_KEY = "agent:main:discord:channel:1484662120149684238";

describe("resolveRequesterOriginForChild session fallback", () => {
  it("recovers the requester target from the session store when the turn has no target", () => {
    const storePath = writeSessionStore({
      [REQUESTER_SESSION_KEY]: {
        channel: "discord",
        lastChannel: "discord",
        lastTo: "channel:1484662120149684238",
        origin: {
          provider: "discord",
          chatType: "channel",
          to: "channel:1484662120149684238",
          accountId: "default",
        },
      },
    });

    const origin = resolveRequesterOriginForChild({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      targetAgentId: "main",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterAccountId: "default",
      requesterSessionKey: REQUESTER_SESSION_KEY,
    });

    expect(origin?.channel).toBe("discord");
    expect(origin?.accountId).toBe("default");
    expect(origin?.to).toBe("channel:1484662120149684238");
  });

  it("recovers the requester thread route for an existing bound thread session", () => {
    const threadSessionKey = "agent:main:discord:channel:1510164477642014740";
    const storePath = writeSessionStore({
      [threadSessionKey]: {
        channel: "discord",
        lastChannel: "discord",
        lastTo: "channel:1510164477642014999",
        lastThreadId: "1510164477642014740",
      },
    });

    const origin = resolveRequesterOriginForChild({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      targetAgentId: "main",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSessionKey: threadSessionKey,
    });

    expect(origin?.to).toBe("channel:1510164477642014999");
    expect(origin?.threadId).toBe("1510164477642014740");
  });

  it("keeps the live turn target when the turn already has one", () => {
    const storePath = writeSessionStore({
      [REQUESTER_SESSION_KEY]: {
        channel: "discord",
        lastChannel: "discord",
        lastTo: "channel:stale",
      },
    });

    const origin = resolveRequesterOriginForChild({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      targetAgentId: "main",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterTo: "channel:1484662120149684238",
      requesterSessionKey: REQUESTER_SESSION_KEY,
    });

    expect(origin?.to).toBe("channel:1484662120149684238");
  });

  it("does not borrow a target recorded for a different channel", () => {
    const storePath = writeSessionStore({
      [REQUESTER_SESSION_KEY]: {
        channel: "slack",
        lastChannel: "slack",
        lastTo: "channel:C123",
      },
    });

    const origin = resolveRequesterOriginForChild({
      cfg: { session: { store: storePath } } as OpenClawConfig,
      targetAgentId: "main",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSessionKey: REQUESTER_SESSION_KEY,
    });

    expect(origin?.channel).toBe("discord");
    expect(origin?.to).toBeUndefined();
  });
});
