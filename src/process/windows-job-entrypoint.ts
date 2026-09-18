import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export const windowsJobEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "windows-job-launcher",
  sourceExtension: ".ts",
  distWorkerPath: "process/windows-job-launcher.js",
} as const;

/** Tooling preflight has no application dependencies, including for worker resolution. */
export function resolveWindowsJobEntrypointUrl(): URL {
  const current = new URL(import.meta.url);
  const distIndex = current.pathname.lastIndexOf("/dist/");
  return distIndex < 0
    ? new URL(
        `./${windowsJobEntrypoint.sourceWorkerName}${extname(fileURLToPath(current))}`,
        current,
      )
    : new URL(
        `${current.pathname.slice(0, distIndex + 6)}${windowsJobEntrypoint.distWorkerPath}`,
        current,
      );
}
