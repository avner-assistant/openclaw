import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  buildHiddenLauncherScript,
  buildTaskScript,
  encodeWindowsLauncherScript,
  readScheduledTaskCommand,
  writeTaskXmlTempFile,
} from "./schtasks-layout.js";
import {
  probeScheduledTaskState,
  readScheduledTaskBatterySettingsUpgrade,
} from "./schtasks-state-probe.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "win32")(
  "reads real Windows PowerShell task presence without an unknown result",
  () => {
    const taskName = `OpenClaw probe test ${randomUUID()}`;
    const missing = probeScheduledTaskState(taskName);
    console.log("Unregistered task probe:", missing);
    expect(missing).toEqual({ status: "missing" });

    const created = spawnSync(
      "schtasks.exe",
      ["/Create", "/TN", taskName, "/SC", "ONSTART", "/TR", "cmd.exe /c exit 0"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
    expect(created.error).toBeUndefined();
    if (created.status !== 0) {
      console.log("Task registration unavailable; verified the missing-task contract.");
      return;
    }
    try {
      const found = probeScheduledTaskState(taskName);
      console.log("Registered task probe:", found);
      expect(found).toMatchObject({ status: "found", state: 3, enabled: true });
    } finally {
      const removed = spawnSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      expect(removed.error).toBeUndefined();
      expect(removed.status, removed.stderr || removed.stdout).toBe(0);
    }
  },
  30_000,
);

it.skipIf(process.platform !== "win32").each(["current", "published"])(
  "reads the %s disabled nested task action and preserves native policy during battery migration",
  async (launcherKind) => {
    const directory = tempDirs.make("openclaw-task-action-");
    const folderName = `OpenClaw inspection ${randomUUID()}`;
    const taskName = `\\${folderName}\\Backup`;
    const scriptPath = path.join(directory, "gateway.cmd");
    const launcherPath = path.join(directory, "gateway.vbs");
    const programArguments = [process.execPath, path.join(directory, "openclaw.mjs"), "gateway"];
    const environment = {
      OPENCLAW_PROFILE: "default",
      OPENCLAW_WINDOWS_TASK_NAME: taskName,
      OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
    };
    await fs.writeFile(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: buildTaskScript({ programArguments, environment }),
      }),
    );
    await fs.writeFile(
      launcherPath,
      encodeWindowsLauncherScript({
        format: "vbs",
        content:
          launcherKind === "current"
            ? buildHiddenLauncherScript({ scriptPath })
            : `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`,
      }),
    );
    const encoded = Buffer.from(
      JSON.stringify({ folderName, launcherPath, directory }),
      "utf8",
    ).toString("base64");
    const run = (operation: string) => {
      const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); ${operation}`;
      const result = spawnSync(
        getWindowsPowerShellExePath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", windowsHide: false, timeout: 15_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      return result.stdout;
    };
    const readNativePolicy = () =>
      JSON.parse(
        run(
          "$task=$service.GetFolder($p.folderName).GetTask('Backup'); $definition=$task.Definition; @{xml=[string]$definition.XmlText;userId=[string]$definition.Principal.UserId;groupId=[string]$definition.Principal.GroupId;logonType=[int]$definition.Principal.LogonType;runLevel=[int]$definition.Principal.RunLevel;enabled=[bool]$task.Enabled;triggers=@(foreach($trigger in $definition.Triggers){@{type=[int]$trigger.Type;startBoundary=[string]$trigger.StartBoundary;enabled=[bool]$trigger.Enabled}});securityDescriptor=$task.GetSecurityDescriptor(7)} | ConvertTo-Json -Depth 4 -Compress",
        ),
      );
    try {
      run(
        "$folder=$service.GetFolder('\\').CreateFolder($p.folderName); $definition=$service.NewTask(0); $definition.RegistrationInfo.Description='Gateway 任务'; $definition.Settings.Enabled=$false; $definition.Settings.DisallowStartIfOnBatteries=$true; $definition.Settings.StopIfGoingOnBatteries=$true; $trigger=$definition.Triggers.Create(1); $trigger.StartBoundary='2099-09-15T10:00:00'; $action=$definition.Actions.Create(0); $action.Path=$p.launcherPath; $action.Arguments='inspection-argument'; $action.WorkingDirectory=$p.directory; $null=$folder.RegisterTaskDefinition('Backup',$definition,6,$null,$null,3)",
      );
      const action = {
        type: 0,
        path: launcherPath,
        arguments: "inspection-argument",
        workingDirectory: directory,
      };
      expect(probeScheduledTaskState(taskName)).toMatchObject({
        status: "found",
        taskPath: taskName,
        state: 1,
        enabled: false,
        actions: [action],
      });
      await expect(
        readScheduledTaskCommand(
          { ...process.env, ...environment },
          { requireEffective: true, requireLoaded: true },
        ),
      ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
      run(
        "$folder=$service.GetFolder($p.folderName); $definition=$folder.GetTask('Backup').Definition; $definition.Actions.Item(1).Arguments=''; $null=$folder.RegisterTaskDefinition('Backup',$definition,6,$null,$null,3)",
      );
      expect(probeScheduledTaskState(taskName)).toMatchObject({
        state: 1,
        enabled: false,
        actions: [{ ...action, arguments: "" }],
      });
      await expect(
        readScheduledTaskCommand(
          { ...process.env, ...environment },
          { requireEffective: true, requireLoaded: true },
        ),
      ).resolves.toMatchObject({
        programArguments,
        workingDirectory: directory,
        sourcePath: scriptPath,
        environment,
      });
      const nativeBefore = readNativePolicy();
      const upgrade = readScheduledTaskBatterySettingsUpgrade(taskName);
      expect(upgrade).toBeDefined();
      expect(upgrade?.originalXml).toBe(nativeBefore.xml);
      expect(upgrade?.updatedXml).toBe(
        nativeBefore.xml
          .replace("<DisallowStartIfOnBatteries>true", "<DisallowStartIfOnBatteries>false")
          .replace("<StopIfGoingOnBatteries>true", "<StopIfGoingOnBatteries>false"),
      );
      expect(upgrade?.updatedXml).toContain("Gateway 任务");
      expect(upgrade?.updatedXml).toContain(
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      );
      expect(upgrade?.updatedXml).toContain(
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      );
      // Preparing a detached COM definition must not alter the registered task or its ACL.
      expect(readNativePolicy()).toEqual(nativeBefore);
      const xmlPath = await writeTaskXmlTempFile(upgrade!.updatedXml);
      try {
        const applied = await withGatewayServiceUpdateAuthority(
          () => {},
          () => execSchtasks(["/Create", "/F", "/TN", taskName, "/XML", xmlPath]),
        );
        expect(applied.code, applied.stderr || applied.stdout).toBe(0);
      } finally {
        await fs.rm(path.dirname(xmlPath), { recursive: true, force: true });
      }
      expect(readNativePolicy()).toEqual({ ...nativeBefore, xml: upgrade!.updatedXml });
      expect(readScheduledTaskBatterySettingsUpgrade(taskName)).toBeUndefined();
    } finally {
      run(
        "$folder=$service.GetFolder($p.folderName); if($folder.GetTasks(1).Count -gt 0){$folder.DeleteTask('Backup',0)}; $service.GetFolder('\\').DeleteFolder($p.folderName,0)",
      );
    }
    expect(probeScheduledTaskState(taskName)).toEqual({ status: "missing" });
  },
  60_000,
);
