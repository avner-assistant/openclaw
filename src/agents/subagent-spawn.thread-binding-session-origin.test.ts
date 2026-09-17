// Thread-bound spawn tests prove a subagent can still bind a channel thread
// when the spawning turn carries no inbound delivery target and only the
// requester session records the conversation.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  hookRunner: { hasHooks: vi.fn() },
}));

const CHANNEL_SESSION_KEY = "agent:main:threadchat:channel:1484662120149684238";
const CHANNEL_TARGET = "channel:1484662120149684238";

function writeRequesterSessionStore(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-spawn-session-origin-"));
  const storePath = path.join(dir, "sessions.json");
  writeFileSync(storePath, JSON.stringify(entries), "utf8");
  return storePath;
}

describe("thread-bound subagent spawn without a turn delivery target", () => {
  type SpawnModule = Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

  let spawnSubagentDirect: SpawnModule["spawnSubagentDirect"];
  let currentConfig: Record<string, unknown>;
  const bindCalls: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => currentConfig,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      hookRunner: hoisted.hookRunner,
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.5",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      getSessionBindingService: () => ({
        getCapabilities: () => ({
          adapterAvailable: true,
          bindSupported: true,
          placements: ["child"],
        }),
        bind: async (request) => {
          bindCalls.push(request as unknown as Record<string, unknown>);
          return {
            targetSessionKey: request.targetSessionKey,
            targetKind: request.targetKind,
            status: "active",
            conversation: request.conversation,
          };
        },
        listBySession: () => [],
      }),
    }));
    // Channels that model conversations as native threads reject inbound
    // resolution outright when no target is supplied, which is exactly the
    // spawn-time state this regression covers.
    const { setActivePluginRegistry } = await import("../plugins/runtime.js");
    const { createChannelTestPluginBase, createTestRegistry } =
      await import("../test-utils/channel-plugins.js");
    const base = createChannelTestPluginBase({ id: "threadchat", label: "ThreadChat" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "threadchat",
          source: "test",
          plugin: {
            ...base,
            messaging: {
              resolveInboundConversation: ({
                to,
                threadId,
              }: {
                to?: string;
                threadId?: string;
              }) => {
                if (threadId) {
                  return { conversationId: threadId, ...(to ? { parentConversationId: to } : {}) };
                }
                return to ? { conversationId: to } : null;
              },
            },
            conversationBindings: { defaultTopLevelPlacement: "child" },
          },
        },
      ]),
    );
  });

  beforeEach(() => {
    bindCalls.length = 0;
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.hookRunner.hasHooks.mockReset();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
  });

  function configureWith(storePath: string) {
    currentConfig = createSubagentSpawnTestConfig(os.tmpdir(), {
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: storePath,
        threadBindings: { defaultSpawnContext: "isolated" },
      },
      agents: {
        defaults: { workspace: os.tmpdir() },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
  }

  it("binds the requester channel conversation recorded on the session", async () => {
    configureWith(
      writeRequesterSessionStore({
        [CHANNEL_SESSION_KEY]: {
          channel: "threadchat",
          lastChannel: "threadchat",
          lastTo: CHANNEL_TARGET,
        },
      }),
    );

    const result = await spawnSubagentDirect(
      { task: "reply with a marker", thread: true, mode: "session", context: "isolated" },
      {
        agentSessionKey: CHANNEL_SESSION_KEY,
        agentChannel: "threadchat",
        agentAccountId: "default",
      },
    );

    expect(result.status).toBe("accepted");
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0]?.conversation).toMatchObject({
      channel: "threadchat",
      accountId: "default",
      conversationId: CHANNEL_TARGET,
    });
  });

  it("binds the requester thread conversation recorded on an existing thread session", async () => {
    const threadSessionKey = "agent:main:threadchat:channel:1510164477642014740";
    configureWith(
      writeRequesterSessionStore({
        [threadSessionKey]: {
          channel: "threadchat",
          lastChannel: "threadchat",
          lastTo: "channel:1510164477642014999",
          lastThreadId: "1510164477642014740",
        },
      }),
    );

    const result = await spawnSubagentDirect(
      { task: "reply with a marker", thread: true, mode: "session", context: "isolated" },
      {
        agentSessionKey: threadSessionKey,
        agentChannel: "threadchat",
        agentAccountId: "default",
      },
    );

    expect(result.status).toBe("accepted");
    expect(bindCalls[0]?.conversation).toMatchObject({
      channel: "threadchat",
      conversationId: "1510164477642014740",
      parentConversationId: "1510164477642014999",
    });
  });

  it("leaves unbound run spawns untouched when the turn has no delivery target", async () => {
    configureWith(
      writeRequesterSessionStore({
        [CHANNEL_SESSION_KEY]: {
          channel: "threadchat",
          lastChannel: "threadchat",
          lastTo: CHANNEL_TARGET,
        },
      }),
    );

    const result = await spawnSubagentDirect(
      { task: "reply with a marker", mode: "run" },
      {
        agentSessionKey: CHANNEL_SESSION_KEY,
        agentChannel: "threadchat",
        agentAccountId: "default",
      },
    );

    expect(result.status).toBe("accepted");
    expect(bindCalls).toHaveLength(0);
  });
});
