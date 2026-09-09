// Codex tests cover attempt client cleanup plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  interruptCodexTurnBestEffort,
  retireCodexAppServerClientAfterTimedOutTurn,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./client.js";
import {
  detachSharedCodexAppServerClientIfCurrent,
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientForNativeChild,
} from "./shared-client.js";

const SHARED_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

type FakeRequest = { method: string; params: unknown };

function createFakeSharedClient() {
  const requests: FakeRequest[] = [];
  const close = vi.fn();
  const client = {
    request: vi.fn(async (method: string, params: unknown) => {
      requests.push({ method, params });
      return {};
    }),
    close,
  };
  return { client: client as unknown as CodexAppServerClient, requests, close };
}

/**
 * Seeds the keyed shared-client map directly so cleanup behavior can be exercised
 * against a fake client without starting an app-server process.
 */
function registerFakeSharedClient(client: CodexAppServerClient, key: string): void {
  const globalState = globalThis as typeof globalThis & { [SHARED_CLIENT_STATE]?: unknown };
  globalState[SHARED_CLIENT_STATE] = {
    clients: new Map([[key, { client, promise: Promise.resolve(client) }]]),
  };
}

describe("Codex app-server attempt client cleanup", () => {
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    const globalState = globalThis as typeof globalThis & { [SHARED_CLIENT_STATE]?: unknown };
    globalState[SHARED_CLIENT_STATE] = undefined;
    vi.restoreAllMocks();
  });

  it("interrupts turns with optional request timeout", () => {
    const request = vi.fn(async () => ({}));

    interruptCodexTurnBestEffort({ request } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 123,
    });

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 123 },
    );
  });

  it("swallows unsubscribe cleanup failures", async () => {
    const request = vi.fn(async () => {
      throw new Error("already gone");
    });

    await expect(
      unsubscribeCodexThreadBestEffort({ request } as never, {
        threadId: "thread-1",
        timeoutMs: 123,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 123 },
    );
  });

  it("interrupts only the timed-out turn when a detached client still runs a sibling native child", async () => {
    const shared = createFakeSharedClient();
    registerFakeSharedClient(shared.client, "shared-key");

    // A sibling task's native child still owns the client's compute.
    const siblingChildOwner = retainSharedCodexAppServerClientForNativeChild(shared.client);
    expect(siblingChildOwner.status).toBe("retained");
    // The coordinator turn already detached the client from the shared map.
    expect(detachSharedCodexAppServerClientIfCurrent(shared.client)).toBe(true);

    await retireCodexAppServerClientAfterTimedOutTurn(shared.client, {
      threadId: "timed-out-thread",
      turnId: "timed-out-turn",
      reason: "turn timeout",
    });

    expect(shared.requests).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "timed-out-thread", turnId: "timed-out-turn" },
      },
      { method: "thread/unsubscribe", params: { threadId: "timed-out-thread" } },
    ]);
    // Exactly one turn was interrupted and one thread unsubscribed: the timed-out
    // attempt's own. The sibling child keeps a live client.
    expect(shared.close).not.toHaveBeenCalled();

    if (siblingChildOwner.status === "retained") {
      siblingChildOwner.release();
    }
    expect(shared.close).toHaveBeenCalledOnce();
  });

  it("closes a detached client after a timed-out turn when no native child owns it", async () => {
    const shared = createFakeSharedClient();
    registerFakeSharedClient(shared.client, "shared-key");
    expect(detachSharedCodexAppServerClientIfCurrent(shared.client)).toBe(true);

    await retireCodexAppServerClientAfterTimedOutTurn(shared.client, {
      threadId: "timed-out-thread",
      turnId: "timed-out-turn",
      reason: "turn timeout",
    });

    expect(shared.close).toHaveBeenCalledOnce();
    // No stale ownership record survives, so a late native child cannot pin a
    // client that has already been torn down.
    expect(retainSharedCodexAppServerClientForNativeChild(shared.client)).toEqual({
      status: "closed",
    });
  });

  it("closes an untracked client after a timed-out turn", async () => {
    const isolated = createFakeSharedClient();

    await retireCodexAppServerClientAfterTimedOutTurn(isolated.client, {
      threadId: "isolated-thread",
      turnId: "isolated-turn",
      reason: "turn timeout",
    });

    expect(isolated.close).toHaveBeenCalledOnce();
  });
});
