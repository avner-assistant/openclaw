/**
 * End-to-end durability of ACP session metadata: initialization must persist
 * metadata that survives both the session's own first turn (which rewrites the
 * session entry's sessionId) and a gateway restart, because every follow-up
 * message to the spawned session key resolves through that metadata.
 *
 * These tests deliberately use the real persistence deps (session store +
 * SQLite state database) and stub only the ACP runtime backend.
 */
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { writeSessionStoreForTestAsync } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { AcpSessionManager } from "./manager.core.js";
import { DEFAULT_DEPS } from "./manager.types.js";

function createStubRuntime(): AcpRuntime {
  return {
    ensureSession: async (input: { sessionKey: string; mode: string }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    }),
    async *runTurn() {
      yield { type: "done" as const };
    },
    cancel: async () => {},
    close: async () => {},
  } as unknown as AcpRuntime;
}

function createManager(): AcpSessionManager {
  const runtime = createStubRuntime();
  const backend = { id: "acpx", runtime };
  return new AcpSessionManager({
    ...DEFAULT_DEPS,
    getRuntimeBackend: () => backend,
    requireRuntimeBackend: () => backend,
  } as unknown as typeof DEFAULT_DEPS);
}

async function withAcpFixture(
  run: (params: {
    cfg: OpenClawConfig;
    storePath: string;
    manager: AcpSessionManager;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-acp-durability-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      session: { store: storePath },
      acp: { backend: "acpx" },
    } as OpenClawConfig;
    await run({ cfg, storePath, manager: createManager() });
  });
}

describe("ACP session metadata durability", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    clearSessionStoreCacheForTest();
  });

  it("resolves the spawned session for both the initial turn and later follow-ups", async () => {
    await withAcpFixture(async ({ cfg, storePath, manager }) => {
      const sessionKey = "agent:claude:acp:11111111-1111-4111-8111-111111111111";

      const initialized = await manager.initializeSession({
        cfg,
        sessionKey,
        agent: "claude",
        mode: "persistent",
      });
      expect(initialized.entry.sessionId).toEqual(expect.any(String));

      // Initial leg: the accepted spawn's own turn resolves metadata.
      expect(manager.resolveSession({ cfg, sessionKey }).kind).toBe("ready");

      // The first turn rewrites the session entry with the runtime's session
      // id, rotating away from the provisional id created at initialization.
      await writeSessionStoreForTestAsync(storePath, {
        [sessionKey]: {
          sessionId: "22222222-2222-4222-8222-222222222222",
          updatedAt: Date.now(),
        },
      });

      // Follow-up leg: this is the lookup that used to report
      // "ACP metadata is missing for <sessionKey>".
      const followUp = manager.resolveSession({ cfg, sessionKey });
      expect(followUp.kind).toBe("ready");
      if (followUp.kind !== "ready") {
        return;
      }
      expect(followUp.meta.mode).toBe("persistent");
      expect(followUp.meta.agent).toBe("claude");
    });
  });

  it("keeps the spawned session resolvable across a gateway restart", async () => {
    await withAcpFixture(async ({ cfg, storePath, manager }) => {
      const sessionKey = "agent:claude:acp:33333333-3333-4333-8333-333333333333";

      await manager.initializeSession({
        cfg,
        sessionKey,
        agent: "claude",
        mode: "persistent",
      });
      await writeSessionStoreForTestAsync(storePath, {
        [sessionKey]: {
          sessionId: "44444444-4444-4444-8444-444444444444",
          updatedAt: Date.now(),
        },
      });

      // Stand-in for a gateway restart: drop every process-local handle and
      // resolve again through a freshly constructed manager.
      closeOpenClawStateDatabaseForTest();
      clearSessionStoreCacheForTest();

      const restarted = createManager().resolveSession({ cfg, sessionKey });
      expect(restarted.kind).toBe("ready");
      if (restarted.kind !== "ready") {
        return;
      }
      expect(restarted.meta.runtimeSessionName).toBe(`${sessionKey}:persistent:runtime`);
    });
  });

  it("still reports missing metadata for ACP session keys that were never initialized", async () => {
    await withAcpFixture(async ({ cfg, manager }) => {
      const resolved = manager.resolveSession({
        cfg,
        sessionKey: "agent:claude:acp:55555555-5555-4555-8555-555555555555",
      });

      expect(resolved.kind).toBe("stale");
      if (resolved.kind !== "stale") {
        return;
      }
      expect(resolved.error.message).toContain("ACP metadata is missing");
    });
  });
});
