/** Locale-independent Task Scheduler registration and runtime facts. */
import { spawnSync } from "node:child_process";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

type ScheduledTaskSnapshot = {
  taskPath?: string;
  actions?: Array<{ type: number; path: string; arguments: string; workingDirectory: string }>;
  state: number | null;
  enabled?: boolean;
  lastRunResult?: string;
  lastRunTime?: string;
};

type ScheduledTaskStateProbe =
  | ({ status: "found" } & ScheduledTaskSnapshot)
  | { status: "missing" }
  | { status: "unknown"; detail: string; timeoutMs?: number };

const READ_TASK = [
  "function Read-Task($task) {",
  "$result=@{taskPath=[string]$task.Path;state=$null}",
  "try { $result.state=[int]$task.State } catch {}",
  "try { $enabled=$task.Enabled; if($enabled -is [bool]) { $result.enabled=$enabled } } catch {}",
  "try { $result.lastRunResult=[int]$task.LastTaskResult } catch {}",
  "try { $result.lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) } catch {}",
  "try { $result.actions=@(foreach($action in $task.Definition.Actions) { if([int]$action.Type -eq 0) { @{type=0;path=[string]$action.Path;arguments=[string]$action.Arguments;workingDirectory=[string]$action.WorkingDirectory} } else { @{type=[int]$action.Type;path='';arguments='';workingDirectory=''} } }) } catch {}",
  "$result }",
].join("; ");

function queryTaskScheduler(
  taskName: string,
  timeoutMs?: number,
  readTask = READ_TASK,
): { status: "ok"; value: unknown } | Exclude<ScheduledTaskStateProbe, { status: "found" }> {
  const probeTimeoutMs =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$lookup=$false",
    readTask,
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect() } catch { Write-Output $_.Exception.HResult; exit 2 }",
    "try { $lookup=$true; $task=$service.GetFolder('\\').GetTask($taskName); $lookup=$false; Read-Task $task | ConvertTo-Json -Depth 4 -Compress; exit 0 } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; Write-Output $exception.HResult; if($lookup){exit 1}; exit 2 }",
  ].join("; ");
  const probe = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: probeTimeoutMs,
      // CREATE_NO_WINDOW makes Windows PowerShell 5.1 fail without output on some hosts.
      windowsHide: false,
    },
  );
  if (probe.error) {
    if (hasErrnoCode(probe.error, "ETIMEDOUT")) {
      return {
        status: "unknown",
        detail: `Scheduled Task probe timed out after ${probeTimeoutMs} ms (ETIMEDOUT).`,
        timeoutMs: probeTimeoutMs,
      };
    }
    return { status: "unknown", detail: probe.error.message };
  }
  if (probe.status === 0) {
    try {
      return { status: "ok", value: JSON.parse(probe.stdout) };
    } catch {}
    return { status: "unknown", detail: "Scheduled Task probe returned invalid JSON." };
  }
  const hresult = Number(probe.stdout.trim());
  // Only a missing task/folder during lookup proves absence, not a failed COM connection.
  return probe.status === 1 && (hresult === -2147024894 || hresult === -2147024893)
    ? { status: "missing" }
    : {
        status: "unknown",
        detail: `Scheduled Task probe failed (exit ${probe.status}): ${probe.stdout.trim() || probe.stderr.trim() || "no output from PowerShell."}`,
      };
}

function readTaskSnapshot(value: unknown): ScheduledTaskSnapshot | undefined {
  const snapshot = asOptionalRecord(value);
  if (!snapshot) {
    return undefined;
  }
  const { taskPath, actions, state, enabled, lastRunResult, lastRunTime } = snapshot;
  let parsedActions: ScheduledTaskSnapshot["actions"];
  if (Array.isArray(actions)) {
    parsedActions = [];
    for (const rawAction of actions) {
      const action = asOptionalRecord(rawAction);
      const { type, path, arguments: args, workingDirectory } = action ?? {};
      if (
        typeof type !== "number" ||
        typeof path !== "string" ||
        typeof args !== "string" ||
        typeof workingDirectory !== "string"
      ) {
        parsedActions = undefined;
        break;
      }
      parsedActions.push({ type, path, arguments: args, workingDirectory });
    }
  }
  return {
    ...(typeof taskPath === "string" && taskPath ? { taskPath } : {}),
    ...(parsedActions ? { actions: parsedActions } : {}),
    state:
      typeof state === "number" && Number.isInteger(state) && state >= 0 && state <= 4
        ? state
        : null,
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof lastRunResult === "number" && Number.isInteger(lastRunResult)
      ? { lastRunResult: String(lastRunResult) }
      : {}),
    ...(typeof lastRunTime === "string" ? { lastRunTime } : {}),
  };
}

export function probeScheduledTaskState(
  taskName: string,
  timeoutMs?: number,
): ScheduledTaskStateProbe {
  const result = queryTaskScheduler(taskName, timeoutMs);
  if (result.status !== "ok") {
    return result;
  }
  const snapshot = readTaskSnapshot(result.value);
  return snapshot
    ? { status: "found", ...snapshot }
    : { status: "unknown", detail: "Scheduled Task probe returned invalid JSON." };
}

/** Prepare a detached definition; only the guarded schtasks writer can publish it. */
export function readScheduledTaskBatterySettingsUpgrade(taskName: string) {
  const result = queryTaskScheduler(
    taskName,
    undefined,
    [
      "function Read-Task($task) {",
      "$definition=$task.Definition; $original=[string]$definition.XmlText",
      "$definition.Settings.DisallowStartIfOnBatteries=$false; $definition.Settings.StopIfGoingOnBatteries=$false",
      "@{originalXml=$original;updatedXml=[string]$definition.XmlText;logonType=[int]$definition.Principal.LogonType;registrationTrigger=@($definition.Triggers | Where-Object { [int]$_.Type -eq 7 }).Count -gt 0} }",
    ].join("; "),
  );
  const value = result.status === "ok" ? asOptionalRecord(result.value) : undefined;
  const { originalXml, updatedXml, logonType, registrationTrigger } = value ?? {};
  // Re-registration must neither ask for credentials nor fire a registration trigger.
  return typeof originalXml === "string" &&
    typeof updatedXml === "string" &&
    originalXml !== updatedXml &&
    typeof logonType === "number" &&
    [2, 3, 4, 5].includes(logonType) &&
    registrationTrigger === false
    ? { originalXml, updatedXml }
    : undefined;
}

export function probeScheduledTaskExists(taskName: string, timeoutMs?: number): boolean | null {
  const probe = probeScheduledTaskState(taskName, timeoutMs);
  return probe.status === "found" ? true : probe.status === "missing" ? false : null;
}
