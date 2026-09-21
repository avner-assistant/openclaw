/** Exercises the real ACPX client/process lifecycle across agent-command snapshot refresh. */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AcpSessionManager } from "../../../src/acp/control-plane/manager.core.js";
import { DEFAULT_DEPS } from "../../../src/acp/control-plane/manager.types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/runtime-snapshot.js";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../../src/state/openclaw-state-db.js";
import { withTempDir } from "../../../src/test-helpers/temp-dir.js";
import { AcpxRuntime, createFileSessionStore } from "./runtime.js";

it("keeps the newly created ACP client through an unchanged agent-command config refresh", async () => {
  await withTempDir({ prefix: "openclaw-acp-first-turn-" }, async (dir) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    // Like Claude, a new conversation exists only in the creating process until
    // its first prompt. A replacement process cannot resume that empty session.
    const agentPath = path.join(dir, "agent.mjs");
    const tracePath = path.join(dir, "wire.log");
    await fs.writeFile(
      agentPath,
      `
      import readline from 'node:readline';
      import { appendFileSync } from 'node:fs';
      const sessionId = '858407b7-db16-4109-88d8-8caeeffcf290';
      const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const request = JSON.parse(line);
        appendFileSync(${JSON.stringify(tracePath)}, request.method + '\\n');
        if (request.id === undefined) return;
        let result = {};
        if (request.method === 'initialize') {
          result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        } else if (request.method === 'session/new') {
          result = { sessionId };
        } else if (request.method === 'session/load') {
          send({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'Resource not found' } });
          return;
        } else if (request.method === 'session/prompt') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first turn completed' }
          } } });
          result = { stopReason: 'end_turn' };
        }
        send({ jsonrpc: '2.0', id: request.id, result });
      });
    `,
    );
    const runtime = new AcpxRuntime({
      cwd: dir,
      sessionStore: createFileSessionStore({ stateDir: path.join(dir, "acpx") }),
      agentRegistry: {
        resolve: () => `${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)}`,
        list: () => ["claude"],
      },
      permissionMode: "deny-all",
    });
    const backend = { id: "acpx", runtime };
    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      getRuntimeBackend: () => backend,
      requireRuntimeBackend: () => backend,
    });
    const cfg: OpenClawConfig = {
      session: { store: path.join(dir, "sessions.json") },
      acp: { backend: "acpx" },
    };
    const sessionKey = "agent:claude:acp:207c80dc-f696-4b0b-94d4-53aab1e77ba9";
    try {
      setRuntimeConfigSnapshot(cfg);
      const initialized = await manager.initializeSession({
        cfg,
        sessionKey,
        agent: "claude",
        mode: "persistent",
      });
      expect(initialized.meta.identity?.acpxSessionId).toBe("858407b7-db16-4109-88d8-8caeeffcf290");
      expect(manager.resolveSession({ cfg, sessionKey }).kind).toBe("ready");
      // resolveAgentRuntimeConfig executes this even when loadedRaw === cfg.
      setRuntimeConfigSnapshot(cfg);
      const onEvent = vi.fn();
      await manager.runTurn({
        cfg,
        sessionKey,
        text: "initial task",
        mode: "prompt",
        requestId: "first-turn",
        onEvent,
      });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "text_delta", text: "first turn completed" }),
      );
      expect((await fs.readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
        "initialize",
        "session/new",
        "session/prompt",
      ]);
    } finally {
      await manager.closeSession({ cfg, sessionKey, reason: "test-complete" }).catch(() => {});
      clearRuntimeConfigSnapshot();
      closeOpenClawStateDatabaseForTest();
      clearSessionStoreCacheForTest();
      vi.unstubAllEnvs();
    }
  });
}, 20_000);
