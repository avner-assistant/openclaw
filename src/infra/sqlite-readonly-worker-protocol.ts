// Keep the one-shot execFile output limit when inspections use IPC.
export const SQLITE_READONLY_WORKER_MAX_BUFFER = 1024 * 1024;

export type SqliteReadOnlyWorkerMode = "sync" | "async" | "reclaim";
export type SqliteReadOnlyWorkerResult =
  | { ok: true; location: string }
  | { ok: true; warnings: string[] }
  | { ok: false; message: string };
