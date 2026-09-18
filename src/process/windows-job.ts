import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createWindowsJobBindings } from "./supervisor/service-child-windows-job-native.ts";
import { resolveWindowsJobEntrypointUrl } from "./windows-job-entrypoint.ts";

export type WindowsJobExtinction = { status: "confirmed" } | { status: "uncertain"; cause: Error };

export type ManagedWindowsJob = {
  inspect: () => number[];
  beginStop: () => void;
  stop: () => void;
  close: () => void;
  readonly ready: Promise<void>;
  readonly commandPid: number | undefined;
  isControlMessage: (message: unknown) => boolean;
  certify: () => Promise<WindowsJobExtinction>;
};

export type WindowsJobLaunch = {
  command: string;
  args: string[];
  options: Omit<SpawnOptions, "stdio" | "signal">;
  stdio: Array<number | "ignore" | "ipc">;
};

let native: ReturnType<typeof createWindowsJobBindings> | undefined;
function bindings() {
  if (!native) {
    const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
    native = createWindowsJobBindings(koffi);
    native.assertLayouts();
  }
  return native;
}

/** The host retains one kill-on-close Job; the launcher admits target code only inside it. */
export function spawnWindowsJobChild(
  command: string,
  args: string[],
  options: SpawnOptions,
  beforeLaunch?: () => void,
): { child: ChildProcess; job: ManagedWindowsJob } | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const configuredStdio = options.stdio;
  const stdio: Exclude<StdioOptions, string> = Array.isArray(configuredStdio)
    ? [...configuredStdio]
    : Array.from({ length: 3 }, () => configuredStdio ?? "pipe");
  while (stdio.length < 3) {
    stdio.push("pipe");
  }
  const api = bindings();
  const name = `Local\\OpenClawChild-${randomUUID()}`;
  const handle = api.requireHandle(api.CreateJobObjectW(null, name), "CreateJobObjectW(child)");
  const ready = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  let child: ChildProcess | undefined;
  let admitted = false;
  let exited = false;
  let stopped = false;
  let closed = false;
  let commandPid: number | undefined;
  let stopDeadline: number | undefined;
  let certification: Promise<WindowsJobExtinction> | undefined;
  const job: ManagedWindowsJob = {
    ready: ready.promise,
    get commandPid() {
      return commandPid;
    },
    isControlMessage: (message) =>
      Boolean(message && typeof message === "object" && "job" in message && message.job === name),
    beginStop: () => {
      stopped = true;
    },
    inspect: () => {
      if (closed) {
        throw new Error("Windows command Job is closed");
      }
      return api.readJobProcessIds(handle);
    },
    stop: () => {
      stopped = true;
      stopDeadline ??= performance.now() + 4_000;
      if (closed) {
        return;
      }
      if (!api.TerminateJobObject(handle, 1)) {
        throw api.lastError("TerminateJobObject(child)");
      }
      // The helper may still be starting outside the Job, but has not received user code.
      if (!admitted) {
        child?.kill("SIGKILL");
      }
    },
    close: () => {
      stopped = true;
      if (!closed) {
        if (!api.CloseHandle(handle)) {
          throw api.lastError("CloseHandle(child Job)");
        }
        closed = true;
      }
    },
    certify: () => {
      certification ??= (async (): Promise<WindowsJobExtinction> => {
        try {
          // An empty Job before launcher admission is not proof of completed ownership.
          while (!exited || job.inspect().length !== 0) {
            if (stopDeadline !== undefined && performance.now() >= stopDeadline) {
              throw new Error("Windows Job descendant extinction deadline expired");
            }
            await delay(25);
          }
          job.close();
          return { status: "confirmed" };
        } catch (error) {
          try {
            job.close();
          } catch {
            // Preserve the observation failure; never certify a failed native close.
          }
          return {
            status: "uncertain",
            cause: error instanceof Error ? error : new Error(String(error)),
          };
        }
      })();
      return certification;
    },
  };
  try {
    if (!api.SetExtendedLimits(handle, 9, api.extendedLimits, api.extendedLimitsSize)) {
      throw api.lastError("SetInformationJobObject(child)");
    }
    const { stdio: _stdio, signal: _signal, ...commandOptions } = options;
    const commandEnv = { ...(options.env ?? process.env) };
    const launch: WindowsJobLaunch = {
      command,
      args: [...args],
      options: {
        ...commandOptions,
        cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
        env: commandEnv,
      },
      stdio: stdio.map((entry, fd) => (entry === "ipc" || entry === "ignore" ? entry : fd)),
    };
    if (!stdio.includes("ipc")) {
      stdio.push("ipc");
    }
    const launched = spawn(
      process.execPath,
      [fileURLToPath(resolveWindowsJobEntrypointUrl()), name],
      {
        cwd: launch.options.cwd,
        // Case-insensitive preloads must run only in the contained target.
        env: Object.fromEntries(
          Object.entries(commandEnv).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS"),
        ),
        stdio,
        windowsHide: options.windowsHide,
        signal: options.signal,
      },
    );
    child = launched;
    const fail = (error: Error) => {
      ready.reject(error);
      try {
        job.stop();
      } catch {
        // Certification retains the deadline and reports native cleanup failure as uncertainty.
      }
    };
    launched.on("error", fail);
    launched.once("exit", () => {
      exited = true;
      ready.reject(new Error("Windows Job launcher exited before command startup"));
    });
    launched.once("close", () => {
      exited = true;
      ready.reject(new Error("Windows Job launcher closed before command startup"));
    });
    launched.on("message", (message: unknown) => {
      if (!job.isControlMessage(message)) {
        return;
      }
      // SAFETY: only our launcher writes control messages carrying this private Job token.
      const control = message as { type: string; pid: number; error: string; code?: string };
      if (control.type === "ready" && !admitted && !stopped) {
        try {
          beforeLaunch?.();
          admitted = true;
          launched.send(launch, (error) => error && launched.emit("error", error));
        } catch (error) {
          launched.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      } else if (control.type === "spawned") {
        commandPid = control.pid;
        ready.resolve();
      } else if (control.type === "error") {
        launched.emit("error", Object.assign(new Error(control.error), { code: control.code }));
      }
    });
    return { child: launched, job };
  } catch (error) {
    job.close();
    throw error;
  }
}
