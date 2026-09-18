import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeOwnedStdioProcess, createOwnedStdioProcess } from "./owned-stdio.js";
import { createStubChild } from "./supervisor/adapters/child.test-support.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  inspect: vi.fn<() => number[]>(),
  terminate: vi.fn(),
  close: vi.fn(() => true),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) =>
      new Proxy(actual.createRequire(...args), {
        apply: (target, receiver, argumentsList) =>
          argumentsList[0] === "koffi" ? {} : Reflect.apply(target, receiver, argumentsList),
      }),
  };
});
vi.mock("./supervisor/service-child-windows-job-native.ts", () => ({
  createWindowsJobBindings: () => ({
    assertLayouts() {},
    CreateJobObjectW: () => 1n,
    requireHandle: (handle: bigint) => handle,
    SetExtendedLimits: () => true,
    TerminateJobObject: native.terminate,
    CloseHandle: native.close,
    readJobProcessIds: native.inspect,
    lastError: (operation: string) => new Error(operation),
  }),
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let stub: ReturnType<typeof createStubChild>;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  stub = createStubChild();
  native.inspect.mockReset().mockReturnValue([1234]);
  native.close.mockReset().mockReturnValue(true);
  native.terminate.mockReset().mockImplementation(() => {
    native.inspect.mockReturnValue([]);
    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
    stub.emitClose(0);
    return true;
  });
  native.spawn.mockReset().mockImplementation((_command, args) => {
    stub.child.send = vi.fn((message: unknown, ...sendArgs: unknown[]) => {
      if (message && typeof message === "object" && "command" in message) {
        stub.child.emit("message", { job: args[1], type: "spawned", pid: 5678 });
      }
      const callback = sendArgs.findLast((value) => typeof value === "function");
      if (typeof callback === "function") {
        callback(null);
      }
      return true;
    });
    queueMicrotask(() => {
      stub.child.emit("spawn");
      stub.child.emit("message", { job: args[1], type: "ready" });
    });
    return stub.child;
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

it("joins the retained Windows Job after the root exits with descendants still holding stdio", async () => {
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  child.onStdout(() => {});
  child.onStderr(() => {});
  try {
    expect(child.waitForExtinction).toBeTypeOf("function");
    expect(child.pid).toBe(5678);
    const observed = Promise.withResolvers<void>();
    native.inspect.mockImplementation(() => {
      observed.resolve();
      return [9876];
    });
    stub.emitExit(0);
    const confirmed = vi.fn();
    void child.waitForExtinction!().then(confirmed);
    await observed.promise;
    expect(confirmed).not.toHaveBeenCalled();
    await closeOwnedStdioProcess(child, { force: true });
    expect(confirmed).toHaveBeenCalledOnce();
    expect(native.terminate).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  } finally {
    native.inspect.mockReturnValue([]);
    stub.emitClose(0);
    child.dispose();
  }
});

it("retains a failed Job observation as cleanup uncertainty", async () => {
  const cause = new Error("Job accounting unavailable");
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  native.inspect.mockImplementation(() => {
    throw cause;
  });
  stub.emitExit(0);
  stub.emitClose(0);
  await expect(closeOwnedStdioProcess(child)).rejects.toBe(cause);
  expect(native.close).toHaveBeenCalledOnce();
});
