// Windows schtasks tests cover scheduled task service lifecycle behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import {
  buildHiddenLauncherScript,
  buildStartupLauncherScript,
  resolveStartupEntryPaths,
} from "./schtasks-layout.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  isScheduledTaskEnabled,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists, probeScheduledTaskState } from "./schtasks-state-probe.js";
import {
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  resolveTaskScriptPath,
} from "./schtasks.js";

const schtasksResponses = vi.hoisted(
  (): Array<{ code: number; stdout: string; stderr: string }> => [],
);
const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync,
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async () => schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" },
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));

vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

beforeEach(() => {
  schtasksResponses.length = 0;
  spawnSync.mockReset();
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
});

describe("scheduled task runtime derivation", () => {
  async function readRuntimeFromQueryOutput(output: string) {
    schtasksResponses.push(
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: output, stderr: "" },
    );
    return await readScheduledTaskRuntime({
      USERPROFILE: "C:\\Users\\test",
      OPENCLAW_PROFILE: "default",
    });
  }

  it.each([
    { state: 3, result: 0, expected: "stopped", label: "Bereit" },
    { state: 4, result: 0, expected: "running", label: "Wird ausgeführt" },
    { state: 2, result: 0, expected: "unknown", label: "In Warteschlange" },
    { state: 0, result: 0, expected: "unknown", label: "Unbekannt" },
  ])("uses numeric task state $state on a fully localized Windows host", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        state: task.state,
        lastRunResult: task.result,
        lastRunTime: "2026-08-02T12:00:00.0000000Z",
      }),
      stderr: "",
    });
    const runtime = await readRuntimeFromQueryOutput(
      [
        "Aufgabenname: \\OpenClaw Gateway",
        `Status: ${task.label}`,
        "Letzte Laufzeit: 02.08.2026 14:00:00",
        "Letztes Ergebnis: 0",
      ].join("\r\n"),
    );
    expect(runtime.status).toBe(task.expected);
  });

  it.each([
    { state: 1, result: 267009, expected: "stopped", name: "Disabled" },
    { state: 3, result: 267009, expected: "stopped", name: "Ready" },
    { state: 4, result: -2147024891, expected: "running", name: "Running" },
    { state: 2, result: 0, expected: "unknown", name: "Queued" },
    { state: 0, result: 267009, expected: "unknown", name: "Unknown" },
  ])("uses $name rather than stale last-run result $result", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ state: task.state, lastRunResult: task.result }),
    });
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: task.expected,
      state: task.name,
      lastRunResult: String(task.result),
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(
      task.expected === "stopped",
    );
  });

  it.each([
    { state: 3 },
    { state: 3, lastRunResult: null, lastRunTime: null },
    { state: 3, lastRunResult: "unavailable", lastRunTime: false },
  ])("preserves task state and existence without optional history: %j", async (snapshot) => {
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(snapshot) });
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: "stopped",
      state: "Ready",
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(true);
  });

  it.each([null, "3", 5])(
    "preserves existence but not offline proof for state %j",
    async (state) => {
      spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ state }) });
      await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({ status: "unknown" });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each(["-2147024894", "-2147024893"])(
    "recognizes lookup HRESULT %s as missing",
    async (stdout) => {
      spawnSync.mockReturnValue({ status: 1, stdout });
      await expect(readRuntimeFromQueryOutput("")).resolves.toEqual({
        status: "stopped",
        missingUnit: true,
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(false);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each([
    { name: "access denied", status: 1, stdout: "-2147024891" },
    { name: "COM activation missing", status: 2, stdout: "-2147221164" },
    { name: "connection missing file", status: 2, stdout: "-2147024894" },
    { name: "malformed HRESULT", status: 1, stdout: "-2147024894 trailing" },
    { name: "invalid JSON", status: 0, stdout: "not JSON" },
    { name: "non-object JSON", status: 0, stdout: "null" },
    { name: "spawn failure", status: null, stdout: "", error: new Error("ENOENT") },
    { name: "timeout", status: null, stdout: "", error: new Error("ETIMEDOUT") },
  ])("keeps $name unavailable, not missing or stopped", async (response) => {
    spawnSync.mockReturnValue(response);
    await expect(readRuntimeFromQueryOutput("")).resolves.toMatchObject({
      status: "unknown",
      missingUnit: false,
      inspectionFailure: { code: "service-runtime-inspection-failed" },
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

  it("requires current Scheduler running state before retiring the Startup owner", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ state: 3, lastRunResult: 267009 }),
      })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ state: 4, lastRunResult: 0 }) });
    await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});

describe("readScheduledTaskCommand", () => {
  it.each(["cmd", "current vbs", "published vbs", "legacy vbs"] as const)(
    "reads the registered custom task action instead of the canonical launcher (%s)",
    async (kind) => {
      const taskName = "\\OpenClaw Gateway Backup";
      const scriptPath = "C:\\Services\\Backup\\gateway.cmd";
      const launcherPath = kind === "cmd" ? scriptPath : "C:\\Services\\Backup\\gateway.vbs";
      const programArguments = [
        "C:\\Node\\node.exe",
        "C:\\OtherInstall\\openclaw.mjs",
        "gateway",
        "--port",
        "19789",
      ];
      spawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          taskPath: taskName,
          state: 3,
          actions: [
            {
              type: 0,
              path: launcherPath,
              arguments: "",
              workingDirectory: "C:\\Services\\Backup",
            },
          ],
        }),
      });
      const readFile = vi
        .spyOn(fs, "readFile")
        .mockImplementation(async (pathname) =>
          Buffer.from(
            pathname === launcherPath && kind !== "cmd"
              ? kind === "current vbs"
                ? buildHiddenLauncherScript({ scriptPath, taskSupervisor: true })
                : kind === "published vbs"
                  ? `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`
                  : `CreateObject("WScript.Shell").Run """${scriptPath}""", 0, False\r\n`
              : pathname === scriptPath
                ? [
                    "@echo off",
                    'set "OPENCLAW_PROFILE=default"',
                    'set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway Backup"',
                    'set "OPENCLAW_STATE_DIR=C:\\Services\\Backup"',
                    'set "OPENCLAW_CONFIG_PATH=C:\\Services\\Backup\\openclaw.json"',
                    'cd /d "C:\\Services\\Backup"',
                    '"C:\\Node\\node.exe" "C:\\OtherInstall\\openclaw.mjs" gateway --port 19789 < NUL',
                  ].join("\r\n")
                : '@echo off\r\n"C:\\Node\\node.exe" "C:\\DefaultInstall\\openclaw.mjs" gateway --port 18789\r\n',
          ),
        );
      try {
        await expect(
          readScheduledTaskCommand(
            { USERPROFILE: "C:\\Users\\test", OPENCLAW_WINDOWS_TASK_NAME: taskName },
            { requireEffective: true, requireLoaded: true },
          ),
        ).resolves.toMatchObject({
          programArguments,
          workingDirectory: "C:\\Services\\Backup",
          sourcePath: scriptPath,
          environment: {
            OPENCLAW_PROFILE: "default",
            OPENCLAW_STATE_DIR: "C:\\Services\\Backup",
            OPENCLAW_CONFIG_PATH: "C:\\Services\\Backup\\openclaw.json",
          },
        });
        expect(readFile).toHaveBeenCalledWith(scriptPath);
      } finally {
        readFile.mockRestore();
      }
    },
  );

  async function withScheduledTaskScript(
    options: {
      scriptLines?: string[];
      scriptEncoding?: "utf8" | "gbk";
      env?:
        | Record<string, string | undefined>
        | ((tmpDir: string) => Record<string, string | undefined>);
    },
    run: (env: Record<string, string | undefined>) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-schtasks-test-"));
    try {
      const extraEnv = typeof options.env === "function" ? options.env(tmpDir) : options.env;
      const env = {
        USERPROFILE: tmpDir,
        OPENCLAW_PROFILE: "default",
        ...extraEnv,
      };
      if (options.scriptLines) {
        const scriptPath = resolveTaskScriptPath(env);
        const script = options.scriptLines.join("\r\n");
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        let scriptBytes: Buffer = Buffer.from(script, "utf8");
        if (options.scriptEncoding === "gbk") {
          // Production bytes for a code-page install: marker line + GBK body.
          resolveWindowsOemEncodingMock.mockReturnValueOnce("gbk");
          scriptBytes = encodeWindowsLauncherScript({ format: "cmd", content: script });
        }
        await fs.writeFile(scriptPath, scriptBytes);
      }
      await run(env);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("parses script with quoted arguments containing spaces", async () => {
    await withScheduledTaskScript(
      {
        // Use forward slashes which work in Windows cmd and avoid escape parsing issues.
        scriptLines: ["@echo off", '"C:/Program Files/Node/node.exe" gateway.js'],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["C:/Program Files/Node/node.exe", "gateway.js"],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads legacy UTF-8 scripts with CJK paths written before the encoding fix", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: ["@echo off", 'cd /d "C:\\Users\\苗振\\.openclaw"', "node gateway.js"],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js"],
          workingDirectory: "C:\\Users\\苗振\\.openclaw",
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads marked ANSI scripts with CJK paths under a CJK code page (#107416)", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: ["@echo off", 'cd /d "C:\\Users\\苗振\\.openclaw"', "node gateway.js"],
        scriptEncoding: "gbk",
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js"],
          workingDirectory: "C:\\Users\\苗振\\.openclaw",
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads back GBK launchers whose bytes are also valid UTF-8 (隆) without corruption", async () => {
    // GBK "隆" is C2 A1, which UTF-8 accepts as "¡"; the marker keeps readback
    // from sniffing these bytes as UTF-8 and parsing a corrupted path.
    await withScheduledTaskScript(
      {
        scriptLines: ["@echo off", 'cd /d "C:\\Users\\隆\\.openclaw"', "node gateway.js"],
        scriptEncoding: "gbk",
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js"],
          workingDirectory: "C:\\Users\\隆\\.openclaw",
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("returns null when script does not exist", async () => {
    await withScheduledTaskScript({}, async (env) => {
      const result = await readScheduledTaskCommand(env);
      expect(result).toBeNull();
    });
  });

  it.each([
    "node gateway.js\r\nnode another.js",
    'node gateway.js\r\nset "OPENCLAW_PROFILE=other"',
    'node gateway.js\r\ncd /d "C:\\Other"',
    "node gateway.js & node another.js",
  ])("rejects an ambiguous effective launcher body: %s", async (body) => {
    await withScheduledTaskScript({ scriptLines: ["@echo off", body] }, async (env) => {
      await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
        "Effective Scheduled Task service command could not be inspected.",
      );
    });
  });

  async function withWindowsLauncherFiles(
    run: (env: Record<string, string>, files: Map<string, string | Buffer>) => Promise<void>,
  ) {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" };
    const files = new Map<string, string | Buffer>([
      [resolveTaskScriptPath(env), "@echo off\r\nnode gateway.js\r\n"],
    ]);
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      if (typeof pathname !== "string") {
        throw new TypeError("Test launcher paths must be strings");
      }
      const content = files.get(pathname);
      if (content === undefined) {
        throw Object.assign(new Error("Missing test launcher"), { code: "ENOENT" });
      }
      return Buffer.from(content);
    });
    try {
      await run(env, files);
    } finally {
      readFile.mockRestore();
    }
  }

  it.each([false, true])(
    "uses Startup fallback only after proven registration absence (installed: %s)",
    async (startup) => {
      await withWindowsLauncherFiles(async (env, files) => {
        if (startup) {
          const startupPath = resolveStartupEntryPaths(env)[0]!;
          files.set(
            startupPath,
            buildStartupLauncherScript({ scriptPath: resolveTaskScriptPath(env) }),
          );
        }
        spawnSync.mockReturnValue({ status: 1, stdout: "-2147024894", stderr: "" });
        const result = await readScheduledTaskCommand(env, {
          requireEffective: true,
          requireLoaded: true,
        });
        if (startup) {
          expect(result).toMatchObject({
            programArguments: ["node", "gateway.js"],
            sourcePath: resolveTaskScriptPath(env),
          });
        } else {
          expect(result).toBeNull();
        }
        spawnSync.mockReturnValue({ status: 2, stdout: "-2147024891", stderr: "" });
        await expect(
          readScheduledTaskCommand(env, { requireEffective: true, requireLoaded: true }),
        ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
      });
    },
  );

  it.each([
    { startup: false, transition: "found" },
    { startup: false, transition: "unknown" },
    { startup: true, transition: "found" },
    { startup: true, transition: "unknown" },
  ] as const)(
    "rejects missing registration changing to $transition during inspection (Startup: $startup)",
    async ({ startup, transition }) => {
      await withWindowsLauncherFiles(async (env, files) => {
        if (startup) {
          const startupPath = resolveStartupEntryPaths(env)[0]!;
          files.set(
            startupPath,
            buildStartupLauncherScript({ scriptPath: resolveTaskScriptPath(env) }),
          );
        }
        spawnSync
          .mockReturnValueOnce({ status: 1, stdout: "-2147024894", stderr: "" })
          .mockReturnValue(
            transition === "unknown"
              ? { status: 2, stdout: "-2147024891", stderr: "" }
              : {
                  status: 0,
                  stdout: JSON.stringify({
                    taskPath: "\\OpenClaw Gateway",
                    state: 3,
                    actions: [
                      {
                        type: 0,
                        path: "C:\\NewRegistration\\gateway.cmd",
                        arguments: "",
                        workingDirectory: "",
                      },
                    ],
                  }),
                },
          );
        await expect(
          readScheduledTaskCommand(env, { requireEffective: true, requireLoaded: true }),
        ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
      });
    },
  );

  it.each([
    "cmd",
    "current vbs",
    "legacy vbs",
    "matching wrappers",
    "conflicting wrappers",
  ] as const)("reads the actual generated Startup target (%s)", async (kind) => {
    await withWindowsLauncherFiles(async (env, files) => {
      files.set(resolveTaskScriptPath(env), "@echo off\r\nnode stale-canonical.js\r\n");
      const scriptPath = "C:\\Services\\Backup\\gateway.cmd";
      const otherPath = "C:\\Services\\Other\\gateway.cmd";
      const startupPaths = resolveStartupEntryPaths(env);
      const writeLauncher = (extension: "cmd" | "vbs", target: string) => {
        const startupPath = startupPaths.find((pathname) => pathname.endsWith(`.${extension}`))!;
        const content =
          extension === "cmd"
            ? buildStartupLauncherScript({ scriptPath: target })
            : kind === "legacy vbs"
              ? `CreateObject("WScript.Shell").Run """${target}""", 0, False\r\n`
              : buildHiddenLauncherScript({ scriptPath: target });
        files.set(startupPath, encodeWindowsLauncherScript({ format: extension, content }));
      };
      if (kind === "cmd" || kind.endsWith("wrappers")) {
        writeLauncher("cmd", scriptPath);
      }
      if (kind !== "cmd") {
        writeLauncher("vbs", kind === "conflicting wrappers" ? otherPath : scriptPath);
      }
      spawnSync.mockReturnValue({ status: 1, stdout: "-2147024894", stderr: "" });
      for (const pathname of [scriptPath, otherPath]) {
        files.set(
          pathname,
          '@echo off\r\n"C:\\Node\\node.exe" "C:\\OtherInstall\\openclaw.mjs" gateway --port 19789\r\n',
        );
      }
      const result = readScheduledTaskCommand(env, {
        requireEffective: true,
        requireLoaded: true,
      });
      if (kind === "conflicting wrappers") {
        await expect(result).rejects.toThrow(
          "Effective Scheduled Task service command could not be inspected.",
        );
      } else {
        await expect(result).resolves.toMatchObject({
          sourcePath: scriptPath,
          programArguments: [
            "C:\\Node\\node.exe",
            "C:\\OtherInstall\\openclaw.mjs",
            "gateway",
            "--port",
            "19789",
          ],
        });
      }
    });
  });

  it.each([
    "registration unknown",
    "multiple actions",
    "action arguments",
    "root-relative action (backslash)",
    "root-relative action (slash)",
    "action changed",
    "saved name changed",
    "saved profile changed",
    "unrecognized vbs",
  ] as const)("rejects strict registered command inspection when %s", async (kind) => {
    const scriptPath = "C:\\Services\\Backup\\gateway.cmd";
    const action = {
      type: 0,
      path:
        kind === "unrecognized vbs"
          ? "C:\\Services\\Backup\\gateway.vbs"
          : kind === "root-relative action (backslash)"
            ? "\\gateway.cmd"
            : kind === "root-relative action (slash)"
              ? "/gateway.cmd"
              : scriptPath,
      arguments: kind === "action arguments" ? "extra" : "",
      workingDirectory: "",
    };
    const found = {
      status: 0,
      stdout: JSON.stringify({
        taskPath: "\\OpenClaw Gateway Backup",
        state: 3,
        actions: kind === "multiple actions" ? [action, action] : [action],
      }),
    };
    spawnSync.mockReturnValue(found);
    if (kind === "registration unknown") {
      spawnSync.mockReturnValue({ status: 2, stdout: "-2147024891", stderr: "" });
    } else if (kind === "action changed") {
      spawnSync.mockReturnValueOnce(found).mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          taskPath: "\\OpenClaw Gateway Backup",
          state: 3,
          actions: [{ ...action, path: "C:\\Other\\gateway.cmd" }],
        }),
      });
    }
    const readFile = vi
      .spyOn(fs, "readFile")
      .mockResolvedValue(
        Buffer.from(
          kind === "unrecognized vbs"
            ? `${buildHiddenLauncherScript({ scriptPath })}WScript.Echo "extra executable statement"\r\n`
            : [
                "@echo off",
                `set "OPENCLAW_WINDOWS_TASK_NAME=${kind === "saved name changed" ? "Other Task" : "OpenClaw Gateway Backup"}"`,
                `set "OPENCLAW_PROFILE=${kind === "saved profile changed" ? "other" : "default"}"`,
                "node gateway.js",
              ].join("\r\n"),
        ),
      );
    try {
      await expect(
        readScheduledTaskCommand(
          {
            USERPROFILE: "C:\\Users\\test",
            OPENCLAW_PROFILE: "default",
            OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Backup",
          },
          { requireEffective: true, requireLoaded: true },
        ),
      ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
    } finally {
      readFile.mockRestore();
    }
  });

  it("rejects a registered VBS target changing during the CMD read", async () => {
    const launcherPath = "C:\\Services\\gateway.vbs";
    const scriptPath = "C:\\Services\\Before\\gateway.cmd";
    let wrapper = buildHiddenLauncherScript({ scriptPath });
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        taskPath: "\\OpenClaw Gateway",
        state: 3,
        actions: [{ type: 0, path: launcherPath, arguments: "", workingDirectory: "" }],
      }),
    });
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      if (pathname === launcherPath) {
        return Buffer.from(wrapper);
      }
      expect(pathname).toBe(scriptPath);
      wrapper = buildHiddenLauncherScript({ scriptPath: "C:\\Services\\After\\gateway.cmd" });
      return Buffer.from("@echo off\r\nnode gateway.js\r\n");
    });
    try {
      await expect(
        readScheduledTaskCommand(
          { USERPROFILE: "C:\\Users\\test" },
          { requireEffective: true, requireLoaded: true },
        ),
      ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
    } finally {
      readFile.mockRestore();
    }
  });

  it.each([
    { launcher: "direct CMD", change: "replaced" },
    { launcher: "VBS target", change: "replaced" },
    { launcher: "direct CMD", change: "removed" },
  ])(
    "rejects target CMD contents changing during inspection ($launcher, $change)",
    async ({ launcher, change }) => {
      const scriptPath = "C:\\Services\\gateway.cmd";
      const launcherPath = launcher === "direct CMD" ? scriptPath : "C:\\Services\\gateway.vbs";
      let contents: string | undefined =
        '@echo off\r\nnode "C:\\BeforeInstall\\openclaw.mjs" gateway\r\n';
      spawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({
          taskPath: "\\OpenClaw Gateway",
          state: 3,
          actions: [{ type: 0, path: launcherPath, arguments: "", workingDirectory: "" }],
        }),
      });
      const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
        if (pathname !== scriptPath) {
          return Buffer.from(buildHiddenLauncherScript({ scriptPath }));
        }
        if (contents === undefined) {
          throw Object.assign(new Error("Missing test launcher"), { code: "ENOENT" });
        }
        const snapshot = Buffer.from(contents);
        contents =
          change === "removed"
            ? undefined
            : '@echo off\r\nnode "C:\\AfterInstall\\openclaw.mjs" gateway\r\n';
        return snapshot;
      });
      try {
        await expect(
          readScheduledTaskCommand(
            { USERPROFILE: "C:\\Users\\test" },
            { requireEffective: true, requireLoaded: true },
          ),
        ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
      } finally {
        readFile.mockRestore();
      }
    },
  );

  it.each(["found", "unknown"] as const)(
    "rejects native registration becoming %s during missing-launcher absence checks",
    async (transition) => {
      const found = {
        status: 0,
        stdout: JSON.stringify({
          taskPath: "\\OpenClaw Gateway",
          state: 3,
          actions: [
            { type: 0, path: "C:\\Services\\gateway.cmd", arguments: "", workingDirectory: "" },
          ],
        }),
      };
      spawnSync
        .mockReturnValueOnce(found)
        .mockReturnValue({ status: 1, stdout: "-2147024894", stderr: "" });
      const missing = Object.assign(new Error("Missing test launcher"), { code: "ENOENT" });
      const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(missing);
      const lstat = vi.spyOn(fs, "lstat").mockImplementation(async () => {
        spawnSync.mockReturnValue(
          transition === "found" ? found : { status: 2, stdout: "-2147024891", stderr: "" },
        );
        throw missing;
      });
      try {
        await expect(
          readScheduledTaskCommand(
            { USERPROFILE: "C:\\Users\\test" },
            { requireEffective: true, requireLoaded: true },
          ),
        ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
      } finally {
        lstat.mockRestore();
        readFile.mockRestore();
      }
    },
  );

  it.each(["", "< NUL", "2>err<NUL", '>>"out log" 2>&1'])(
    "rejects a script with no command before redirections: %s",
    async (redirections) => {
      await withScheduledTaskScript(
        { scriptLines: ["@echo off", "rem This is just a comment", redirections] },
        async (env) => {
          await expect(readScheduledTaskCommand(env)).resolves.toBeNull();
          await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
            "Effective Scheduled Task service command could not be inspected.",
          );
        },
      );
    },
  );

  it("parses full script with all components", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          "rem OpenClaw Gateway",
          "cd /d C:\\Projects\\openclaw",
          "set NODE_ENV=production",
          "set OPENCLAW_PORT=18789",
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--verbose"],
          workingDirectory: "C:\\Projects\\openclaw",
          environment: {
            NODE_ENV: "production",
            OPENCLAW_PORT: "18789",
          },
          environmentValueSources: {
            NODE_ENV: "inline",
            OPENCLAW_PORT: "inline",
          },
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("parses command with Windows backslash paths", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it.each([
    "< NUL",
    '>> "C:\\Logs\\gateway stdout.log" 2>&1 < NUL',
    '< NUL >> "%USERPROFILE%\\gateway.log" 2>&1',
    "1>>gateway.log 2>&1",
    "2>&1",
    '2>error.log 1>output.log 0<"nul"',
    ">out.log<NuL",
    ">>out.log 2>&1",
    '> "gateway,part;one=1.log" 2>&1',
  ])("removes only complete trailing launcher redirections: %s", async (suffix) => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          'cd /d "C:\\OpenClaw fixture"',
          'set "OPENCLAW_TEST_VALUE=retained"',
          `node gateway.js --port 18789 --msg "a >b & c" ${suffix}`,
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env, { requireEffective: true });
        expect(result).toMatchObject({
          programArguments: ["node", "gateway.js", "--port", "18789", "--msg", "a >b & c"],
          workingDirectory: "C:\\OpenClaw fixture",
          environment: { OPENCLAW_TEST_VALUE: "retained" },
        });
      },
    );
  });

  it.each([
    ["gateway.js>out.log", ["gateway.js"]],
    ['gateway.js>>"C:\\Logs\\out log" 2>&1<NUL', ["gateway.js"]],
    ['gateway.js --msg "a >b"', ["gateway.js", "--msg", "a >b"]],
    ['gateway.js --msg "a>b"<NUL', ["gateway.js", "--msg", "a>b"]],
    ['gateway.js --msg "< NUL"', ["gateway.js", "--msg", "< NUL"]],
    ['gateway.js --msg "a >b">out.log', ["gateway.js", "--msg", "a >b"]],
    ['gateway.js --port "18789">out.log', ["gateway.js", "--port", "18789"]],
  ])("preserves arguments beside quoted or attached operators: %s", async (line, args) => {
    await withScheduledTaskScript({ scriptLines: ["@echo off", `node ${line}`] }, async (env) => {
      expect((await readScheduledTaskCommand(env))?.programArguments).toEqual(["node", ...args]);
    });
  });

  it.each(["%OPENCLAW_TEST_LOG_PATH%", "!OPENCLAW_TEST_LOG_PATH!"])(
    "preserves unquoted redirect expansion boundaries: %s",
    async (target) => {
      await withScheduledTaskScript(
        {
          scriptLines: [
            "@echo off",
            'set "OPENCLAW_TEST_LOG_PATH=C:\\Logs\\gateway output.log"',
            `node gateway.js --port 18789 < NUL >> ${target} 2>&1`,
          ],
        },
        async (env) => {
          const result = await readScheduledTaskCommand(env);
          expect(result?.programArguments).toEqual([
            "node",
            "gateway.js",
            "--port",
            "18789",
            "<",
            "NUL",
            ">>",
            target,
            "2>&1",
          ]);
          await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
            "Effective Scheduled Task service command could not be inspected.",
          );
        },
      );
    },
  );

  it.each([
    [">out&whoami", [">out&whoami"]],
    [">out&whoami 2>&1", [">out&whoami", "2>&1"]],
    ["& whoami >out", ["&", "whoami", ">out"]],
    ["& echo done >out", ["&", "echo", "done", ">out"]],
    [">first && echo done >>second", [">first", "&&", "echo", "done", ">>second"]],
    ["| other >out", ["|", "other", ">out"]],
    ["(other) >out", ["(other)", ">out"]],
    [">out --extra", [">out", "--extra"]],
    [">out >", [">out", ">"]],
    [">out 2>&", [">out", "2>&"]],
    ['> ""', [">"]],
    ['> "unterminated', [">", "unterminated"]],
    ['--msg "a >b', ["--msg", "a >b"]],
    [">out <input", [">out", "<input"]],
    [">out >>>next", [">out", ">>>next"]],
    [">out 2>&12", [">out", "2>&12"]],
    [">gateway.log,extra 2>&1", [">gateway.log,extra", "2>&1"]],
    [">gateway.log;extra 2>&1", [">gateway.log;extra", "2>&1"]],
    [">gateway.log=extra 2>&1", [">gateway.log=extra", "2>&1"]],
    ["--msg a^>b >out", ["--msg", "a^>b", ">out"]],
    ['--msg "a\\" >b" >out', ["--msg", 'a" >b', ">out"]],
    ['--msg ^"a >b^" >out', ["--msg", "^a >b^", ">out"]],
    ["--port 18789>out", ["--port", "18789>out"]],
    ["gateway.js2>err", ["gateway.js2>err"]],
    ["& whoami <NUL", ["&", "whoami", "<NUL"]],
  ])("keeps the whole ambiguous launcher command: %s", async (tail, args) => {
    await withScheduledTaskScript(
      { scriptLines: ["@echo off", `node gateway.js ${tail}`] },
      async (env) => {
        expect((await readScheduledTaskCommand(env))?.programArguments).toEqual([
          "node",
          "gateway.js",
          ...args,
        ]);
      },
    );
  });

  it("preserves UNC paths in command arguments", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          '"\\\\fileserver\\OpenClaw Share\\node.exe" "\\\\fileserver\\OpenClaw Share\\dist\\index.js" gateway --port 18789',
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: [
            "\\\\fileserver\\OpenClaw Share\\node.exe",
            "\\\\fileserver\\OpenClaw Share\\dist\\index.js",
            "gateway",
            "--port",
            "18789",
          ],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("reads script from OPENCLAW_STATE_DIR override", async () => {
    await withScheduledTaskScript(
      {
        env: (tmpDir) => ({ OPENCLAW_STATE_DIR: path.join(tmpDir, "custom-state") }),
        scriptLines: ["@echo off", "node gateway.js --from-state-dir"],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result).toEqual({
          programArguments: ["node", "gateway.js", "--from-state-dir"],
          sourcePath: resolveTaskScriptPath(env),
        });
      },
    );
  });

  it("parses quoted set assignments with escaped metacharacters", async () => {
    await withScheduledTaskScript(
      {
        scriptLines: [
          "@echo off",
          'set "OC_AMP=left & right"',
          'set "OC_PIPE=a | b"',
          'set "OC_CARET=^^"',
          'set "OC_PERCENT=%%TEMP%%"',
          'set "OC_BANG=^!token^!"',
          'set "OC_QUOTE=he said ^"hi^""',
          "node gateway.js --verbose",
        ],
      },
      async (env) => {
        const result = await readScheduledTaskCommand(env);
        expect(result?.environment).toEqual({
          OC_AMP: "left & right",
          OC_PIPE: "a | b",
          OC_CARET: "^",
          OC_PERCENT: "%TEMP%",
          OC_BANG: "!token!",
          OC_QUOTE: 'he said "hi"',
        });
      },
    );
  });
});

// Enable policy is not numeric runtime state: a ready task may be disabled.
it.each([false, true])("retains observed Task Scheduler enable policy %s", (enabled) => {
  spawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({ state: 3, enabled }),
    stderr: "",
  });
  expect(probeScheduledTaskState("OpenClaw Gateway")).toMatchObject({
    status: "found",
    state: 3,
    enabled,
  });
});

it.each([undefined, null, 0, "false"])(
  "refuses to infer enable policy from a stopped task (%s)",
  async (enabled) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ state: 3, enabled }),
      stderr: "",
    });
    await expect(isScheduledTaskEnabled({ env: {} })).rejects.toThrow("enable policy");
  },
);
