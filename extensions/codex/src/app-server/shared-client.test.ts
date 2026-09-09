// Codex tests cover shared client plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.js";
import { codexAppServerStartOptionsKey } from "./config.js";
import { CodexNativeSubagentMonitor } from "./native-subagent-monitor.js";
import { createClientHarness } from "./test-support.js";

const mocks = vi.hoisted(() => ({
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  applyCodexAppServerAuthProfile: vi.fn(
    async (_params?: { agentDir?: string; authProfileId?: string; config?: unknown }) => undefined,
  ),
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(
    (params?: { authProfileId?: string }) => params?.authProfileId,
  ),
  resolveCodexAppServerAuthProfileStore: vi.fn(
    (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
  ),
  refreshCodexAppServerAuthTokens: vi.fn(async () => ({
    accessToken: "refreshed-access",
    chatgptAccountId: "refreshed-account",
    chatgptPlanType: null,
  })),
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined as string | undefined),
  resolveManagedCodexAppServerStartOptions: vi.fn(async (startOptions) => startOptions),
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent: mocks.resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore: mocks.resolveCodexAppServerAuthProfileStore,
  refreshCodexAppServerAuthTokens: mocks.refreshCodexAppServerAuthTokens,
  resolveCodexAppServerFallbackApiKeyCacheKey: mocks.resolveCodexAppServerFallbackApiKeyCacheKey,
}));

vi.mock("./managed-binary.js", () => ({
  resolveManagedCodexAppServerStartOptions: mocks.resolveManagedCodexAppServerStartOptions,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: mocks.embeddedAgentLog,
  OPENCLAW_VERSION: "test",
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let clearSharedCodexAppServerClientAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientAndWait;
let clearSharedCodexAppServerClient: typeof import("./shared-client.js").clearSharedCodexAppServerClient;
let clearSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrent;
let clearSharedCodexAppServerClientIfCurrentAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndWait;
let closeCodexStartupClientBestEffort: typeof import("./attempt-client-cleanup.js").closeCodexStartupClientBestEffort;
let createIsolatedCodexAppServerClient: typeof import("./shared-client.js").createIsolatedCodexAppServerClient;
let detachSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").detachSharedCodexAppServerClientIfCurrent;
let getLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").getLeasedSharedCodexAppServerClient;
let getSharedCodexAppServerClient: typeof import("./shared-client.js").getSharedCodexAppServerClient;
let retainSharedCodexAppServerClientForNativeChild: typeof import("./shared-client.js").retainSharedCodexAppServerClientForNativeChild;
let releaseLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").releaseLeasedSharedCodexAppServerClient;
let retireSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retireSharedCodexAppServerClientIfCurrent;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

async function sendInitializeResult(
  harness: ReturnType<typeof createClientHarness>,
  userAgent: string,
): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent } });
}

async function sendEmptyModelList(harness: ReturnType<typeof createClientHarness>): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
  const modelList = JSON.parse(harness.writes[2] ?? "{}") as { id?: number };
  harness.send({ id: modelList.id, result: { data: [] } });
}

function firstMockArg(mock: unknown, label: string): unknown {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(0);
  if (!call) {
    throw new Error(`Expected ${label} first call`);
  }
  return call[0];
}

function bridgeStartOptionsCall() {
  return firstMockArg(mocks.bridgeCodexAppServerStartOptions, "bridge start options") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    config?: unknown;
    startOptions: { command?: string; commandSource?: string };
  };
}

function applyAuthProfileCall() {
  return firstMockArg(mocks.applyCodexAppServerAuthProfile, "apply auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    config?: unknown;
  };
}

function resolveAuthProfileCall() {
  return firstMockArg(mocks.resolveCodexAppServerAuthProfileIdForAgent, "resolve auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    config?: unknown;
  };
}

function managedStartOptionsCall() {
  return firstMockArg(mocks.resolveManagedCodexAppServerStartOptions, "managed start options") as {
    command?: string;
    commandSource?: string;
  };
}

function clientStartCall(startSpy: unknown) {
  return firstMockArg(startSpy, "CodexAppServerClient.start") as {
    command?: string;
    commandSource?: string;
  };
}

describe("shared Codex app-server client", () => {
  beforeAll(async () => {
    ({ closeCodexStartupClientBestEffort } = await import("./attempt-client-cleanup.js"));
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({
      clearSharedCodexAppServerClient,
      clearSharedCodexAppServerClientAndWait,
      clearSharedCodexAppServerClientIfCurrent,
      clearSharedCodexAppServerClientIfCurrentAndWait,
      createIsolatedCodexAppServerClient,
      detachSharedCodexAppServerClientIfCurrent,
      getLeasedSharedCodexAppServerClient,
      getSharedCodexAppServerClient,
      retainSharedCodexAppServerClientForNativeChild,
      releaseLeasedSharedCodexAppServerClient,
      retireSharedCodexAppServerClientIfCurrent,
      resetSharedCodexAppServerClientForTests,
    } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockClear();
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockClear();
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockImplementation(
      (params?: { authProfileId?: string }) => params?.authProfileId,
    );
    mocks.resolveCodexAppServerAuthProfileStore.mockClear();
    mocks.resolveCodexAppServerAuthProfileStore.mockImplementation(
      (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
    );
    mocks.refreshCodexAppServerAuthTokens.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockReturnValue(undefined);
    mocks.resolveManagedCodexAppServerStartOptions.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(
      async (startOptions) => startOptions,
    );
    mocks.embeddedAgentLog.debug.mockClear();
    mocks.embeddedAgentLog.warn.mockClear();
    mocks.resolveDefaultAgentDir.mockClear();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.117.9 (macOS; test)");

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.stdin.destroyed).toBe(true);
    startSpy.mockRestore();
  });

  it("closes and clears a shared app-server when initialize times out", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    await expect(listCodexAppServerModels({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);

    await expect(secondList).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps a pending shared app-server alive when another acquire still owns startup", async () => {
    const harness = createClientHarness();
    const abandonController = new AbortController();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const abandonedAcquire = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      abandonSignal: abandonController.signal,
    });
    const activeAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));

    abandonController.abort();
    expect(harness.process.stdin.destroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(abandonedAcquire).resolves.toBe(harness.client);
    await expect(activeAcquire).resolves.toBe(harness.client);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("does not wait for isolated initialize after a timeout closes the client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    await expect(createIsolatedCodexAppServerClient({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("passes the selected auth profile through the bridge helper", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("carries a scoped auth store through isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const authProfileStore = { version: 1, profiles: {} };
    const preparedAuthProfileStore = {
      version: 1,
      profiles: {
        "openai:scoped": { type: "token", provider: "openai", token: "prepared-token" },
      },
    };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:scoped");
    mocks.resolveCodexAppServerAuthProfileStore.mockReturnValue(preparedAuthProfileStore);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileStore,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileStore).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: undefined,
      authProfileStore,
      config: undefined,
    });
    expect(resolveAuthProfileCall().authProfileStore).toBe(preparedAuthProfileStore);
    expect(bridgeStartOptionsCall().authProfileStore).toBe(preparedAuthProfileStore);
    expect(applyAuthProfileCall().authProfileStore).toBe(preparedAuthProfileStore);

    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "scoped-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));

    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:scoped",
      authProfileStore: preparedAuthProfileStore,
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-1",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "refreshed-account",
        chatgptPlanType: null,
      },
    });
  });

  it("registers persisted profile refresh for isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:persisted",
      agentDir: "/tmp/openclaw-persisted-agent",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-persisted",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "persisted-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));

    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-persisted-agent",
      authProfileId: "openai:persisted",
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-persisted",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "refreshed-account",
        chatgptPlanType: null,
      },
    });
  });

  it("skips target auth resolution when native source auth is requested", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const config = { auth: { order: { openai: ["openai:target"] } } };

    const clientPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-target-agent",
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(bridgeCall.authProfileId).toBeNull();
    expect(bridgeCall.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(applyCall.authProfileId).toBeNull();
    expect(applyCall.config).toBe(config);
  });

  it("resolves the configured implicit auth profile before sharing a client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const config = { auth: { order: { openai: ["openai:work"] } } };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const resolveCall = resolveAuthProfileCall();
    expect(resolveCall).toStrictEqual({
      authProfileId: undefined,
      agentDir: "/tmp/openclaw-agent",
      config,
    });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    expect(bridgeCall?.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
    expect(applyCall?.config).toBe(config);
  });

  it("uses the selected agent dir for shared app-server auth bridging", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      agentDir: "/tmp/openclaw-agent-nova",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.agentDir).toBe("/tmp/openclaw-agent-nova");
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.agentDir).toBe("/tmp/openclaw-agent-nova");
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("migrates legacy singleton global state into the keyed registry", async () => {
    const legacy = createClientHarness();
    const next = createClientHarness();
    const startOptions = {
      transport: "websocket" as const,
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39175",
      authToken: "tok-legacy",
      headers: {},
    };
    const key = codexAppServerStartOptionsKey(startOptions, {
      agentDir: "/tmp/openclaw-agent",
    });
    const globalState = globalThis as typeof globalThis & {
      [key: symbol]: unknown;
    };
    globalState[Symbol.for("openclaw.codexAppServerClientState")] = {
      key,
      client: legacy.client,
      promise: Promise.resolve(legacy.client),
    };

    await expect(getSharedCodexAppServerClient({ startOptions })).resolves.toBe(legacy.client);

    legacy.client.close();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(next.client);
    const list = listCodexAppServerModels({ timeoutMs: 1000, startOptions });
    await sendInitializeResult(next, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(next);

    await expect(list).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves keyed shared-client state when adding lease metadata", async () => {
    const legacy = createClientHarness();
    const startOptions = {
      transport: "websocket" as const,
      command: "codex",
      args: [],
      url: "ws://127.0.0.1:39176",
      authToken: "tok-keyed",
      headers: {},
    };
    const key = codexAppServerStartOptionsKey(startOptions, {
      agentDir: "/tmp/openclaw-agent",
    });
    const globalState = globalThis as typeof globalThis & {
      [key: symbol]: unknown;
    };
    globalState[Symbol.for("openclaw.codexAppServerClientState")] = {
      clients: new Map([[key, { client: legacy.client, promise: Promise.resolve(legacy.client) }]]),
    };

    await expect(getLeasedSharedCodexAppServerClient({ startOptions })).resolves.toBe(
      legacy.client,
    );
    expect(retireSharedCodexAppServerClientIfCurrent(legacy.client)).toEqual({
      activeLeases: 1,
      activeNativeChildOwners: 0,
      closed: false,
    });
    expect(legacy.process.stdin.destroyed).toBe(false);

    expect(releaseLeasedSharedCodexAppServerClient(legacy.client)).toBe(true);
    expect(legacy.process.stdin.destroyed).toBe(true);
  });

  it("keeps an active shared client alive when another agent dir uses a different key", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("resolves the managed binary before bridging and spawning the shared client", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed",
    }));

    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const managedCall = managedStartOptionsCall();
    expect(managedCall?.command).toBe("codex");
    expect(managedCall?.commandSource).toBe("managed");
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.startOptions.command).toBe("/cache/openclaw/codex");
    expect(bridgeCall?.startOptions.commandSource).toBe("resolved-managed");
    const startCall = clientStartCall(startSpy);
    expect(startCall?.command).toBe("/cache/openclaw/codex");
    expect(startCall?.commandSource).toBe("resolved-managed");
  });

  it("starts an independent shared client when the bridged auth token changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
        headers: {},
      },
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
        headers: {},
      },
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
  });

  it("starts an independent shared client when fallback api-key auth changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey
      .mockReturnValueOnce("api-key:first")
      .mockReturnValueOnce("api-key:second");

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("does not let one shared-client failure tear down another keyed client", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
        headers: {},
      },
    });
    const firstFailure = firstList.catch((error: unknown) => error);
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(1));

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
        headers: {},
      },
    });
    await vi.waitFor(() => expect(second.writes.length).toBeGreaterThanOrEqual(1));

    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    first.client.close();
    await expect(firstFailure).resolves.toBeInstanceOf(Error);

    expect(second.process.kill).not.toHaveBeenCalled();
  });

  it("only clears the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrent(first.client)).toBe(false);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(clearSharedCodexAppServerClientIfCurrent(second.client)).toBe(true);
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("can detach the current shared client without closing it", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(detachSharedCodexAppServerClientIfCurrent(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(false);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(detachSharedCodexAppServerClientIfCurrent(first.client)).toBe(false);
    first.client.close();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(detachSharedCodexAppServerClientIfCurrent(second.client)).toBe(true);
    second.client.close();
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("closes a retired shared app-server after all active leases release", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const releaseFirst = retainSharedCodexAppServerClientForNativeChild(first.client);
    const releaseSecond = retainSharedCodexAppServerClientForNativeChild(first.client);
    expect(releaseFirst.status).toBe("retained");
    expect(releaseSecond.status).toBe("retained");
    expect(retireSharedCodexAppServerClientIfCurrent(first.client)).toEqual({
      activeLeases: 0,
      activeNativeChildOwners: 2,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    if (releaseFirst.status === "retained") {
      releaseFirst.release();
    }
    expect(first.process.stdin.destroyed).toBe(false);
    if (releaseSecond.status === "retained") {
      releaseSecond.release();
    }
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(retireSharedCodexAppServerClientIfCurrent(second.client)).toEqual({
      activeLeases: 0,
      activeNativeChildOwners: 0,
      closed: true,
    });
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("keeps a retired shared app-server alive until detached native-child owners release", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);

    const firstChildOwner = retainSharedCodexAppServerClientForNativeChild(harness.client);
    expect(firstChildOwner.status).toBe("retained");
    expect(retireSharedCodexAppServerClientIfCurrent(harness.client)).toEqual({
      activeLeases: 1,
      activeNativeChildOwners: 1,
      closed: false,
    });

    const detachedChildOwner = retainSharedCodexAppServerClientForNativeChild(harness.client);
    expect(detachedChildOwner.status).toBe("retained");
    expect(retireSharedCodexAppServerClientIfCurrent(harness.client)).toEqual({
      activeLeases: 1,
      activeNativeChildOwners: 2,
      closed: false,
    });

    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    expect(harness.process.stdin.destroyed).toBe(false);
    if (firstChildOwner.status === "retained") {
      firstChildOwner.release();
    }
    expect(harness.process.stdin.destroyed).toBe(false);
    if (detachedChildOwner.status === "retained") {
      detachedChildOwner.release();
      detachedChildOwner.release();
    }
    expect(harness.process.stdin.destroyed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(retainSharedCodexAppServerClientForNativeChild(harness.client)).toEqual({
      status: "closed",
    });
  });

  it("keeps an unrelated task's native child alive when another run clears the shared client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);

    // Task A's parent turn ends but its native child keeps computing.
    const childOwner = retainSharedCodexAppServerClientForNativeChild(harness.client);
    expect(childOwner.status).toBe("retained");
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    expect(harness.process.stdin.destroyed).toBe(false);

    // An unrelated run (scheduled reporter / failed startup retry) clears the entry.
    expect(clearSharedCodexAppServerClientIfCurrent(harness.client)).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(harness.process.stdin.destroyed).toBe(false);

    if (childOwner.status === "retained") {
      childOwner.release();
    }
    expect(close).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("keeps a resumed native child alive when a stale prior-turn terminal arrives", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);

    const monitor = new CodexNativeSubagentMonitor(harness.client);
    monitor.registerParent({ parentThreadId: "parent-thread" });
    await monitor.handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          source: {
            subAgent: {
              thread_spawn: { parent_thread_id: "parent-thread", depth: 1 },
            },
          },
        },
      },
    });
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);

    await monitor.handleNotification({
      method: "turn/started",
      params: {
        threadId: "child-thread",
        turn: { id: "turn-a", status: "inProgress", items: [] },
      },
    });
    await monitor.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: { id: "turn-a", status: "interrupted", items: [] },
      },
    });
    await monitor.handleNotification({
      method: "turn/started",
      params: {
        threadId: "child-thread",
        turn: { id: "turn-b", status: "inProgress", items: [] },
      },
    });

    // A delayed duplicate for the old turn must not release turn B's ownership.
    await monitor.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: { id: "turn-a", status: "interrupted", items: [] },
      },
    });
    expect(clearSharedCodexAppServerClientIfCurrent(harness.client)).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(harness.process.stdin.destroyed).toBe(false);

    await monitor.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "child-thread",
        turn: { id: "turn-b", status: "completed", items: [] },
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("releases a nested native child from transcript evidence when its terminal event is missed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-nested-owner-"));
    try {
      const codexHome = path.join(tempDir, "codex-home");
      const transcriptDir = path.join(codexHome, "sessions", "2026", "09", "09");
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, "rollout-2026-09-09T07-00-00-grandchild-thread.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "grandchild-thread",
              source: {
                subagent: { thread_spawn: { parent_thread_id: "child-thread" } },
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-09-09T07:00:05.000Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
              last_agent_message: "nested child final result",
              completed_at: 1788937205,
            },
          }),
          "",
        ].join("\n"),
      );

      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
      const close = vi.spyOn(harness.client, "close");
      const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
      await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
      await expect(leasedClient).resolves.toBe(harness.client);

      const monitor = new CodexNativeSubagentMonitor(harness.client, undefined, {
        codexHome,
        transcriptPollDelaysMs: [1],
      });
      monitor.registerParent({ parentThreadId: "parent-thread" });
      await monitor.handleNotification({
        method: "thread/started",
        params: {
          thread: {
            id: "child-thread",
            source: {
              subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } },
            },
          },
        },
      });
      await monitor.handleNotification({
        method: "thread/started",
        params: {
          thread: {
            id: "grandchild-thread",
            source: {
              subAgent: { thread_spawn: { parent_thread_id: "child-thread", depth: 2 } },
            },
          },
        },
      });
      expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
      await monitor.handleNotification({
        method: "turn/completed",
        params: {
          threadId: "child-thread",
          turn: { id: "child-turn", status: "interrupted", items: [] },
        },
      });
      expect(clearSharedCodexAppServerClientIfCurrent(harness.client)).toBe(true);
      expect(close).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(harness.process.stdin.destroyed).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the shared client alive from spawn start until the child is discovered", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");
    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);

    const monitor = new CodexNativeSubagentMonitor(harness.client);
    monitor.registerParent({ parentThreadId: "parent-thread" });
    await monitor.handleNotification({
      method: "item/started",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          id: "spawn-call",
          type: "collabAgentToolCall",
          tool: "spawn_agent",
          status: "inProgress",
          senderThreadId: "parent-thread",
          receiverThreadIds: [],
          agentsStates: {},
        },
      },
    });
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);

    // Parent cleanup can race ahead of child creation, but the in-flight spawn
    // is durable protocol evidence that a child may still need this transport.
    expect(clearSharedCodexAppServerClientIfCurrent(harness.client)).toBe(true);
    expect(close).not.toHaveBeenCalled();

    await monitor.handleNotification({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          id: "spawn-call",
          type: "collabAgentToolCall",
          tool: "spawn_agent",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["late-child"],
          agentsStates: { "late-child": { status: "running" } },
        },
      },
    });
    expect(close).not.toHaveBeenCalled();

    await monitor.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "late-child",
        turn: { id: "late-child-turn", status: "completed", items: [] },
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("closes a cleared shared client immediately when no native child owns it", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);

    expect(clearSharedCodexAppServerClientIfCurrent(harness.client)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);

    // No stale ownership record survives the close, so nothing can be retained
    // against a dead client and no second close is issued.
    expect(retainSharedCodexAppServerClientForNativeChild(harness.client)).toEqual({
      status: "closed",
    });
    expect(clearSharedCodexAppServerClientIfCurrent(harness.client)).toBe(false);
    expect(retireSharedCodexAppServerClientIfCurrent(harness.client)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("waits for a real unclaimed shared startup client to exit after closing it", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);

    await closeCodexStartupClientBestEffort(harness.client);

    expect(closeAndWait).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("detaches instead of killing a shared client that a native child still owns during a wait-close", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);

    const childOwner = retainSharedCodexAppServerClientForNativeChild(harness.client);
    expect(childOwner.status).toBe("retained");
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);

    // A short-lived warm-up run (e.g. migration apply) tears its client down.
    await expect(clearSharedCodexAppServerClientIfCurrentAndWait(harness.client)).resolves.toBe(
      true,
    );
    expect(closeAndWait).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(harness.process.stdin.destroyed).toBe(false);

    if (childOwner.status === "retained") {
      childOwner.release();
    }
    expect(close).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("closes a retired shared client once when its last native child releases", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const close = vi.spyOn(harness.client, "close");

    const leasedClient = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leasedClient).resolves.toBe(harness.client);

    const childOwner = retainSharedCodexAppServerClientForNativeChild(harness.client);
    expect(childOwner.status).toBe("retained");
    expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
    expect(retireSharedCodexAppServerClientIfCurrent(harness.client)).toEqual({
      activeLeases: 0,
      activeNativeChildOwners: 1,
      closed: false,
    });

    if (childOwner.status === "retained") {
      childOwner.release();
      childOwner.release();
      childOwner.release();
    }
    expect(close).toHaveBeenCalledOnce();
    expect(harness.process.stdin.destroyed).toBe(true);
    expect(retireSharedCodexAppServerClientIfCurrent(harness.client)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("leases shared app-server clients before returning concurrent acquirers", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(first.client);

    const firstLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const secondLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await expect(firstLease).resolves.toBe(first.client);
    await expect(secondLease).resolves.toBe(first.client);

    expect(retireSharedCodexAppServerClientIfCurrent(first.client)).toEqual({
      activeLeases: 2,
      activeNativeChildOwners: 0,
      closed: false,
    });
    expect(retireSharedCodexAppServerClientIfCurrent(first.client)).toEqual({
      activeLeases: 2,
      activeNativeChildOwners: 0,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(false);
  });

  it("waits only for the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const firstCloseAndWait = vi.spyOn(first.client, "closeAndWait");
    const secondCloseAndWait = vi.spyOn(second.client, "closeAndWait");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    await expect(
      clearSharedCodexAppServerClientIfCurrentAndWait(first.client, {
        exitTimeoutMs: 25,
        forceKillDelayMs: 5,
      }),
    ).resolves.toBe(true);

    expect(firstCloseAndWait).toHaveBeenCalledTimes(1);
    expect(secondCloseAndWait).not.toHaveBeenCalled();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("uses a fresh websocket Authorization header after shared-client token rotation", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.125.0" } }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });

    try {
      await new Promise<void>((resolve) => {
        server.once("listening", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected websocket test server port");
      }
      const url = `ws://127.0.0.1:${address.port}`;

      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: {
            transport: "websocket",
            command: "codex",
            args: [],
            url,
            authToken: "tok-first",
            headers: {},
          },
        }),
      ).resolves.toEqual({ models: [] });
      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: {
            transport: "websocket",
            command: "codex",
            args: [],
            url,
            authToken: "tok-second",
            headers: {},
          },
        }),
      ).resolves.toEqual({ models: [] });

      expect(authHeaders).toEqual(["Bearer tok-first", "Bearer tok-second"]);
    } finally {
      clearSharedCodexAppServerClient();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  it.each(["clear", "reset", "wait"])(
    "HQ regression: explicit %s reaps an owned retired client exactly once",
    async (operation) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
      const close = vi.spyOn(harness.client, "close");
      const leased = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
      await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
      await expect(leased).resolves.toBe(harness.client);
      const owner = retainSharedCodexAppServerClientForNativeChild(harness.client);
      expect(owner.status).toBe("retained");
      retireSharedCodexAppServerClientIfCurrent(harness.client);
      releaseLeasedSharedCodexAppServerClient(harness.client);
      expect(close).not.toHaveBeenCalled();
      if (operation === "clear") {
        clearSharedCodexAppServerClient();
      } else if (operation === "reset") {
        resetSharedCodexAppServerClientForTests();
      } else {
        let finishExit: (() => void) | undefined;
        const exit = new Promise<void>((resolve) => {
          finishExit = resolve;
        });
        const closeAndWait = vi
          .spyOn(harness.client, "closeAndWait")
          .mockImplementation(async () => {
            harness.client.close();
            await exit;
          });
        let settled = false;
        const teardown = clearSharedCodexAppServerClientAndWait().then(() => {
          settled = true;
        });
        await vi.waitFor(() => expect(closeAndWait).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        finishExit?.();
        await teardown;
        expect(settled).toBe(true);
      }
      expect(harness.process.stdin.destroyed).toBe(true);
      expect(close).toHaveBeenCalledOnce();
      if (owner.status === "retained") {
        owner.release();
        owner.release();
      }
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("HQ regression: startup cleanup awaits the real client's synchronous close", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
    const leased = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await expect(leased).resolves.toBe(harness.client);
    releaseLeasedSharedCodexAppServerClient(harness.client);
    let finishExit: (() => void) | undefined;
    const exit = new Promise<void>((resolve) => {
      finishExit = resolve;
    });
    const closeAndWait = vi.spyOn(harness.client, "closeAndWait").mockImplementation(async () => {
      await exit;
    });
    let settled = false;
    const cleanup = closeCodexStartupClientBestEffort(harness.client).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(closeAndWait).toHaveBeenCalledOnce());
    expect(harness.process.stdin.destroyed).toBe(true);
    expect(settled).toBe(false);
    finishExit?.();
    await cleanup;
    expect(settled).toBe(true);
  });
  it.each([
    "invalid-spawn",
    "missed-terminal",
    "read-error",
    "late-child",
    "abandoned-child",
    "active-after-discovery",
  ])(
    "settles provisional spawn ownership after %s without killing a discovered child",
    async (scenario) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(harness.client);
      const close = vi.spyOn(harness.client, "close");
      const leased = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
      await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
      await expect(leased).resolves.toBe(harness.client);
      let failed = false;
      let childActive = false;
      const hasChild = ["late-child", "abandoned-child", "active-after-discovery"].includes(
        scenario,
      );
      if (scenario === "abandoned-child" || scenario === "active-after-discovery") {
        vi.useFakeTimers();
      }
      vi.spyOn(harness.client, "request").mockImplementation((async (
        method: string,
        params: { threadId?: string },
      ) => {
        if (scenario === "read-error" && !failed) {
          failed = true;
          throw new Error("temporary read failure");
        }
        if (method === "thread/loaded/list") {
          return {
            data: hasChild ? ["parent-thread", "late-child"] : ["parent-thread"],
            nextCursor: null,
          };
        }
        if (method === "thread/read") {
          return {
            thread: {
              id: params.threadId,
              status:
                childActive && params.threadId === "late-child"
                  ? { type: "active", activeFlags: [] }
                  : { type: "idle" },
              turns: [],
              source:
                params.threadId === "late-child"
                  ? { subAgent: { thread_spawn: { parent_thread_id: "parent-thread" } } }
                  : "cli",
            },
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      }) as typeof harness.client.request);
      const monitor = new CodexNativeSubagentMonitor(harness.client);
      monitor.registerParent({ parentThreadId: "parent-thread" });
      await monitor.handleNotification({
        method: "item/started",
        params: {
          threadId: "parent-thread",
          turnId: "parent-a",
          item: {
            id: "spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            senderThreadId: "parent-thread",
            receiverThreadIds: [],
          },
        },
      });
      releaseLeasedSharedCodexAppServerClient(harness.client);
      retireSharedCodexAppServerClientIfCurrent(harness.client);
      expect(close).not.toHaveBeenCalled();
      if (scenario === "missed-terminal") {
        await monitor.reconcileKnownTaskRows();
      } else {
        await monitor.handleNotification({
          method: "turn/completed",
          params: {
            threadId: "parent-thread",
            turn: { id: "parent-a", status: "interrupted", items: [] },
          },
        });
      }
      if (scenario === "read-error") {
        expect(close).not.toHaveBeenCalled();
        await monitor.reconcileKnownTaskRows();
      }
      if (scenario === "abandoned-child") {
        expect(close).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
      }
      if (scenario === "active-after-discovery") {
        childActive = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(close).not.toHaveBeenCalled();
      }
      if (scenario === "late-child" || scenario === "active-after-discovery") {
        // The loaded child exists but its initial input has not projected as active yet.
        expect(close).not.toHaveBeenCalled();
        await monitor.handleNotification({
          method: "turn/started",
          params: { threadId: "late-child", turn: { id: "child-a" } },
        });
        await monitor.handleNotification({
          method: "turn/completed",
          params: {
            threadId: "late-child",
            turn: { id: "child-a", status: "interrupted", items: [] },
          },
        });
      }
      expect(close).toHaveBeenCalledOnce();
      monitor.dispose();
    },
  );
});

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
