/** Tests ACP session metadata persistence, joins, and migration helpers. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { writeSessionStoreForTestAsync } from "../../config/sessions/test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  readAcpSessionMeta,
  readAcpSessionMetaForEntry,
  repairAcpSessionMetaKeyForMigration,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";

describe("ACP session metadata SQLite store", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("persists ACP metadata in SQLite without writing sessions.json acp blocks", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

      const result = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
          cwd: "/repo",
        }),
      });

      expect(result?.acp?.runtimeSessionName).toBe("codex-discord");
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: { sessionId: "sess-acp" },
        })?.runtimeSessionName,
      ).toBe("codex-discord");
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: { sessionId: "sess-rebound" },
        }),
      ).toBeUndefined();
      expect(loadSessionStore(storePath)[sessionKey]?.acp).toBeUndefined();
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp,
      ).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "codex-discord",
        mode: "persistent",
        state: "idle",
        cwd: "/repo",
      });
    });
  });

  it("keeps unpinned initialization metadata resolvable after the first turn rotates sessionId", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:claude:acp:3cb981ee-d203-4469-801b-1f95c8e92aa9";

      // Spawn-time initialization: the manager persists metadata before the
      // caller is handed an accepted receipt.
      const initialized = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        sessionIdPin: "none",
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: "claude-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 200,
        }),
      });
      const provisionalSessionId = initialized?.sessionId;
      expect(provisionalSessionId).toEqual(expect.any(String));

      // The session's own first turn rewrites the entry with the runtime's
      // session id, which is what orphaned the row before this fix.
      await writeSessionStoreForTestAsync(storePath, {
        [sessionKey]: {
          sessionId: "80e81c39-3756-4c79-ad0f-104fc4584ae7",
          updatedAt: 300,
        },
      });
      expect(loadSessionStore(storePath)[sessionKey]?.sessionId).not.toBe(provisionalSessionId);

      // Follow-up routing resolves metadata exactly this way.
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("claude-discord");
      expect(readAcpSessionMeta({ cfg, databasePath, sessionKey })?.mode).toBe("persistent");
    });
  });

  it("re-pins ACP metadata to the rotated entry once a turn persists it", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:claude:acp:pin-after-turn";

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        sessionIdPin: "none",
        mutate: () => ({
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: "claude-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 200,
        }),
      });
      await writeSessionStoreForTestAsync(storePath, {
        [sessionKey]: { sessionId: "turn-session-id", updatedAt: 300 },
      });

      // A turn-time write uses the default pin and adopts the live entry id.
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: (current) => ({
          ...(current ?? {
            backend: "acpx",
            agent: "claude",
            runtimeSessionName: "claude-discord",
            mode: "persistent",
            lastActivityAt: 300,
          }),
          state: "running",
          lastActivityAt: 300,
        }),
      });

      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: { sessionId: "turn-session-id" },
        })?.state,
      ).toBe("running");
      // Staleness detection is preserved for entries replaced after that write.
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          entry: { sessionId: "reset-session-id" },
        }),
      ).toBeUndefined();
    });
  });

  it("keeps ACP metadata readable after the state database is reopened", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:claude:acp:restart-survivor";

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        sessionIdPin: "none",
        mutate: () => ({
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: "claude-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 200,
          cwd: "/repo",
        }),
      });

      // Stand-in for a gateway restart: drop every process-local handle and
      // re-open the on-disk state database from scratch.
      closeOpenClawStateDatabaseForTest();
      clearSessionStoreCacheForTest();

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp,
      ).toMatchObject({
        backend: "acpx",
        agent: "claude",
        runtimeSessionName: "claude-discord",
        mode: "persistent",
        cwd: "/repo",
      });
    });
  });

  it("creates a session-store row for new SQLite ACP sessions without embedding ACP metadata", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:new-session";

      const result = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-new",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(result?.sessionId).toEqual(expect.any(String));
      expect(result?.acp?.runtimeSessionName).toBe("codex-new");
      const storedEntry = loadSessionStore(storePath)[sessionKey];
      expect(storedEntry?.sessionId).toEqual(expect.any(String));
      expect(storedEntry?.updatedAt).toEqual(expect.any(Number));
      expect(storedEntry?.acp).toBeUndefined();
    });
  });

  it("normalizes ACP metadata lookups and writes to the resolved session-store key", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const storeSessionKey = "agent:codex:acp:binding:discord:default:feedface";
      const rawSessionKey = storeSessionKey.toUpperCase();
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [storeSessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: rawSessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-normalized",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: rawSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: storeSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(loadSessionStore(storePath)[storeSessionKey]?.acp).toBeUndefined();
      const legacyEmbeddedEntry = loadSessionStore(storePath)[storeSessionKey];
      expect(legacyEmbeddedEntry).toBeDefined();
      if (!legacyEmbeddedEntry) {
        throw new Error("expected normalized ACP session entry");
      }
      await writeSessionStoreForTestAsync(storePath, {
        [storeSessionKey]: {
          ...legacyEmbeddedEntry,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "legacy-embedded",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 120,
          },
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: rawSessionKey,
        mutate: (current) => {
          expect(current?.runtimeSessionName).toBe("codex-normalized");
          return null;
        },
      });

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: storeSessionKey,
        })?.acp,
      ).toBeUndefined();
      expect(loadSessionStore(storePath)[storeSessionKey]?.acp).toBeUndefined();
    });
  });

  it("keeps SQLite ACP metadata visible when legacy store keys are canonicalized", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const legacyStoreSessionKey = "agent:CODEX:acp:legacy-runtime";
      const canonicalSessionKey = "agent:codex:acp:legacy-runtime";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [legacyStoreSessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: canonicalSessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-canonicalized",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      const store = loadSessionStore(storePath);
      expect(store[legacyStoreSessionKey]).toBeUndefined();
      expect(store[canonicalSessionKey]?.sessionId).toBe("sess-acp");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: canonicalSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-canonicalized");
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("binds ACP metadata to the final accessor-selected entry for alias writes", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const canonicalSessionKey = "agent:codex:acp:alias-runtime";
      const legacyStoreSessionKey = "agent:CODEX:acp:alias-runtime";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [canonicalSessionKey]: {
            sessionId: "sess-canonical",
            updatedAt: 100,
          },
          [legacyStoreSessionKey]: {
            sessionId: "sess-legacy",
            updatedAt: 150,
          },
        }),
        "utf8",
      );

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: legacyStoreSessionKey,
        now: () => 200,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-alias",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        }),
      });

      const store = loadSessionStore(storePath);
      expect(store[legacyStoreSessionKey]).toBeUndefined();
      expect(store[canonicalSessionKey]?.sessionId).toBe("sess-legacy");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: canonicalSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-alias");
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("ignores SQLite ACP metadata rows for replaced session ids", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-new",
            updatedAt: 100,
          },
        }),
        "utf8",
      );

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        sessionId: "sess-old",
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-stale",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp).toBeUndefined();
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(0);

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey,
        sessionId: "sess-new",
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-current",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 124,
        },
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp?.runtimeSessionName).toBe(
        "codex-current",
      );
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("repairs ACP metadata rows when session-store keys are canonicalized", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const legacyKey = "agent:CODEX:acp:legacy-runtime";
      const canonicalKey = "agent:codex:acp:legacy-runtime";
      await writeSessionStoreForTestAsync(storePath, {
        [canonicalKey]: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: legacyKey,
        sessionId: "sess-acp",
        meta: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: legacyKey,
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      });

      expect(
        repairAcpSessionMetaKeyForMigration({
          databasePath,
          sessionKey: canonicalKey,
          entry: { sessionId: "sess-acp" },
          now: () => 200,
        }),
      ).toBe(true);

      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey: legacyKey,
          entry: { sessionId: "sess-acp" },
        }),
      ).toBeUndefined();
      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey: canonicalKey })?.acp
          ?.runtimeSessionName,
      ).toBe(legacyKey);
    });
  });

  it("lists SQLite ACP rows while joining current session-store entries", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions", "codex.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
            model: "gpt-5.5",
          },
        }),
        "utf8",
      );
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-s1",
          mode: "oneshot",
          state: "running",
          lastActivityAt: 321,
        }),
      });

      const entries = await listAcpSessionEntries({ cfg, databasePath, clone: false });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        cfg,
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry: {
          sessionId: "sess-acp",
          model: "gpt-5.5",
        },
        acp: {
          backend: "acpx",
          runtimeSessionName: "codex-s1",
          mode: "oneshot",
          state: "running",
        },
      });
    });
  });

  it("honors OPENCLAW_STATE_DIR when joining listed SQLite rows to session stores", async () => {
    await withTempDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir } as NodeJS.ProcessEnv;
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:codex:acp:s1";
      const storePath = path.join(dir, "agents", "codex", "sessions", "sessions.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-acp",
            updatedAt: 100,
          },
        }),
        "utf8",
      );
      await upsertAcpSessionMeta({
        cfg,
        env,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-s1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 321,
        }),
      });

      const entries = await listAcpSessionEntries({ cfg, env });

      expect(entries).toHaveLength(1);
      expect(entries[0]?.storePath).toBe(storePath);
      expect(entries[0]?.entry?.sessionId).toBe("sess-acp");
    });
  });
});
