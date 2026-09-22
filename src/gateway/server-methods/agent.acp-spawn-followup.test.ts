/** Public ACP spawn/send regression: accepted provider failures must remain addressable. */
import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { resetSubagentRegistryForTests } from "../../agents/subagent-registry.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onAgentEvent,
  getAgentRunContext,
  clearAgentRunContext,
  resetAgentRunContextForTest,
} from "../../infra/agent-events.js";
import {
  registerSessionBindingAdapter,
  testing as bindingTesting,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat.js";
import { agentHandlers } from "./agent.js";
import { chatHandlers } from "./chat.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./types.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../call.js", () => ({ callGateway: (...args: unknown[]) => transport.call(...args) }));

describe("accepted ACP public tool follow-up", () => {
  it("reaches the same provider after the accepted initial turn fails without a transcript", async () => {
    await withTempDir({ prefix: "openclaw-acp-public-seam-" }, async (dir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(dir, "openclaw.json"));
      const storePath = path.join(dir, "sessions.json");
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        session: { store: storePath },
        acp: { enabled: true, backend: "fixture", allowedAgents: ["claude"] },
        agents: {
          defaults: { workspace: dir, skipBootstrap: true, subagents: { allowAgents: ["claude"] } },
          list: [{ id: "main", default: true }, { id: "claude" }],
        },
        tools: { sessions: { visibility: "tree" } },
        channels: { discord: { threadBindings: { enabled: true, spawnSessions: true } } },
      };
      setRuntimeConfigSnapshot(cfg);
      let releaseInitial!: () => void;
      const initialGate = new Promise<void>((resolve) => {
        releaseInitial = resolve;
      });
      const turns: string[] = [];
      const runtime: AcpRuntime = {
        ensureSession: async ({ sessionKey }) => ({
          sessionKey,
          backend: "fixture",
          runtimeSessionName: sessionKey,
        }),
        async *runTurn({ text }) {
          turns.push(text);
          if (turns.length === 1) {
            await initialGate;
          }
          yield { type: "error", code: "ACP_TURN_FAILED", message: "monthly usage limit reached" };
        },
        close: async () => {},
        cancel: async () => {},
      };
      registerAcpRuntimeBackend({ id: "fixture", runtime });
      let binding: SessionBindingRecord | undefined;
      registerSessionBindingAdapter({
        channel: "discord",
        accountId: "default",
        capabilities: {
          bindSupported: true,
          unbindSupported: true,
          placements: ["child", "current"],
        },
        bind: async (input) =>
          (binding = {
            bindingId: "fixture-thread",
            targetKind: "session",
            targetSessionKey: input.targetSessionKey,
            conversation: {
              channel: "discord",
              accountId: "default",
              conversationId: "child-thread",
              parentConversationId: "parent-channel",
            },
            status: "active",
            boundAt: Date.now(),
            metadata: {},
          }),
        listBySession: (key) => (binding?.targetSessionKey === key ? [binding] : []),
        resolveByConversation: () => binding ?? null,
        unbind: async () => [],
      });
      const finals = new Map<string, unknown>();
      const context = {
        dedupe: new Map(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        chatAbortControllers: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        agentDeltaSentAt: new Map(),
        bufferedAgentEvents: new Map(),
        chatAbortedRuns: new Map(),
        clearChatRunState: vi.fn(),
        agentRunSeq: new Map(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set(),
        getRuntimeConfig: () => cfg,
      } as unknown as GatewayRequestContext;
      const terminalPersistence: Promise<void>[] = [];
      const stopEvents = onAgentEvent(
        createAgentEventHandler({
          broadcast: context.broadcast,
          broadcastToConnIds: context.broadcastToConnIds,
          nodeSendToSession: context.nodeSendToSession,
          agentRunSeq: context.agentRunSeq,
          chatRunState: createChatRunState(),
          resolveSessionKeyForRun: (runId) => getAgentRunContext(runId)?.sessionKey,
          clearAgentRunContext,
          toolEventRecipients: createToolEventRecipientRegistry(),
          sessionEventSubscribers: createSessionEventSubscriberRegistry(),
          sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
          lifecycleErrorRetryGraceMs: 0,
          trackTrackedRunTerminalPersistence: ({ persistence }) => {
            terminalPersistence.push(persistence);
          },
        }),
      );
      const handlers: Record<string, GatewayRequestHandler> = {
        ...sessionsHandlers,
        ...agentHandlers,
        ...chatHandlers,
      };
      transport.call.mockImplementation(
        ({ method, params }: { method: string; params: Record<string, unknown> }) =>
          new Promise((resolve, reject) => {
            const handler = handlers[method];
            if (!handler) {
              reject(new Error(`Unexpected RPC ${method}`));
              return;
            }
            void Promise.resolve(
              handler({
                req: { type: "req", id: crypto.randomUUID(), method, params },
                params,
                context,
                client: null,
                isWebchatConnect: () => false,
                respond: (ok, payload, error) => {
                  const result = payload as { status?: string; runId?: string } | undefined;
                  if (method === "agent" && result?.runId && result.status !== "accepted") {
                    finals.set(result.runId, { payload, error });
                  }
                  if (ok) {
                    resolve(payload);
                  } else {
                    reject(new Error(error?.message));
                  }
                },
              }),
            ).catch(reject);
          }),
      );
      try {
        await fs.writeFile(path.join(dir, "openclaw.json"), JSON.stringify(cfg));
        const spawn = createSessionsSpawnTool({
          config: cfg,
          agentSessionKey: "agent:main:main",
          agentChannel: "discord",
          agentAccountId: "default",
          agentTo: "channel:parent-channel",
        });
        const result = await spawn.execute("spawn", {
          task: "initial",
          runtime: "acp",
          agentId: "claude",
          thread: true,
          mode: "session",
        });
        const accepted = result.details as {
          status: string;
          childSessionKey: string;
          runId: string;
        };
        expect(accepted, JSON.stringify(accepted)).toMatchObject({ status: "accepted" });
        expect(binding?.targetSessionKey).toBe(accepted.childSessionKey);
        await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 20_000 });
        releaseInitial();
        await vi.waitFor(() => expect(finals.get(accepted.runId)).toBeDefined(), {
          timeout: 20_000,
        });
        expect(JSON.stringify(finals.get(accepted.runId))).toContain("monthly usage limit");
        expect(readAcpSessionMeta({ cfg, sessionKey: accepted.childSessionKey })?.state).toBe(
          "error",
        );
        await vi.waitFor(() =>
          expect(
            loadSessionEntry({ storePath, sessionKey: accepted.childSessionKey })?.status,
          ).toBe("failed"),
        );
        const failedEntry = loadSessionEntry({ storePath, sessionKey: accepted.childSessionKey });
        expect(failedEntry?.sessionFile).toBeDefined();
        await expect(fs.access(failedEntry!.sessionFile!)).rejects.toThrow();
        const send = createSessionsSendTool({ config: cfg, agentSessionKey: "agent:main:main" });
        const sent = await send.execute("follow-up", {
          sessionKey: accepted.childSessionKey,
          message: "follow-up",
          timeoutSeconds: 20,
        });
        const followup = sent.details as { status: string; runId: string };
        expect(followup).toMatchObject({ status: "error" });
        expect(JSON.stringify(followup)).toContain("monthly usage limit");
        expect(JSON.stringify(followup)).not.toContain("ACP metadata is missing");
        await vi.waitFor(() => expect(finals.get(followup.runId)).toBeDefined(), {
          timeout: 20_000,
        });
        expect(JSON.stringify(finals.get(followup.runId))).not.toContain("ACP metadata is missing");
        expect(JSON.stringify(finals.get(followup.runId))).toContain("monthly usage limit");
        expect(turns).toHaveLength(2);
        const cousinSend = createSessionsSendTool({
          config: cfg,
          agentSessionKey: "agent:main:other",
        });
        const assertCousinDenied = async () => {
          const denied = await cousinSend.execute("cousin", {
            sessionKey: accepted.childSessionKey,
            message: "must not deliver",
            timeoutSeconds: 0,
          });
          expect(denied.details).toMatchObject({ status: "forbidden" });
        };
        await assertCousinDenied();
        await Promise.all(terminalPersistence);
        resetSubagentRegistryForTests({ persist: false });
        resetTaskRegistryForTests({ persist: false });
        managerTesting.resetAcpSessionManagerForTests();
        closeOpenClawStateDatabaseForTest();
        clearSessionStoreCacheForTest();
        const afterRestart = Date.now() + 2 * 60 * 60_000;
        vi.spyOn(Date, "now").mockReturnValue(afterRestart);
        expect(
          loadSessionEntry({ storePath, sessionKey: accepted.childSessionKey })?.spawnedBy,
        ).toBe("agent:main:main");
        expect(readAcpSessionMeta({ cfg, sessionKey: accepted.childSessionKey })?.mode).toBe(
          "persistent",
        );
        const listed = await transport.call({ method: "sessions.list", params: {} });
        expect(
          listed.sessions.some((row: { key: string }) => row.key === accepted.childSessionKey),
        ).toBe(true);
        const restartedSend = await send.execute("post-restart", {
          sessionKey: accepted.childSessionKey,
          message: "post-restart",
          timeoutSeconds: 20,
        });
        expect(JSON.stringify(restartedSend.details)).not.toContain(
          "Session send visibility is restricted",
        );
        expect(JSON.stringify(restartedSend.details)).toContain("monthly usage limit");
        expect(turns).toHaveLength(3);
        await assertCousinDenied();
        expect(
          loadSessionEntry({ storePath, sessionKey: accepted.childSessionKey })?.sessionId,
        ).toBe(failedEntry?.sessionId);
        await vi.waitFor(() => expect(context.chatAbortControllers.size).toBe(0));
        await vi.waitFor(() =>
          expect(
            loadSessionEntry({ storePath, sessionKey: accepted.childSessionKey })?.status,
          ).toBe("failed"),
        );
        expect(
          getAcpSessionManager().resolveSession({ cfg, sessionKey: accepted.childSessionKey }).kind,
        ).toBe("ready");
      } finally {
        releaseInitial();
        // Accepted runs are detached from their RPC handler. Drain them and
        // terminal writes even when an assertion fails before normal completion.
        try {
          await vi.waitFor(() => expect(context.chatAbortControllers.size).toBe(0), {
            timeout: 20_000,
          });
          await Promise.all(terminalPersistence);
        } finally {
          stopEvents();
          transport.call.mockReset();
          resetSubagentRegistryForTests({ persist: false });
          resetTaskRegistryForTests({ persist: false });
          resetAgentRunContextForTest();
          managerTesting.resetAcpSessionManagerForTests();
          unregisterAcpRuntimeBackend("fixture");
          bindingTesting.resetSessionBindingAdaptersForTests();
          clearRuntimeConfigSnapshot();
          closeOpenClawStateDatabaseForTest();
          clearSessionStoreCacheForTest();
          vi.unstubAllEnvs();
          vi.restoreAllMocks();
        }
      }
    });
  }, 60_000);
});
