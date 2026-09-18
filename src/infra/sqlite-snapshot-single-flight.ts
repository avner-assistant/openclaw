import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type SnapshotFlight = {
  base?: PreparedSqliteReadOnlyLocation;
  controller: AbortController;
  leases: number;
  promise: Promise<PreparedSqliteReadOnlyLocation>;
  waiters: number;
};

const snapshotFlights = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSnapshotFlights"),
  () => new Map<string, SnapshotFlight>(),
);

async function waitForFlight<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) {
    return promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const release = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      release();
      reject(signal.reason instanceof Error ? signal.reason : new Error("SQLite snapshot aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (signal.aborted) {
      abort();
    }
  });
}

function cleanupUnleasedFlight(key: string, flight: SnapshotFlight): void {
  if (flight.waiters > 0 || flight.leases > 0) {
    return;
  }
  if (snapshotFlights.get(key) === flight) {
    snapshotFlights.delete(key);
  }
  if (flight.base) {
    void flight.base.cleanupAsync();
  } else {
    flight.controller.abort();
  }
}

function releaseFlight(key: string, flight: SnapshotFlight, asyncCleanup: false): boolean;
function releaseFlight(key: string, flight: SnapshotFlight, asyncCleanup: true): Promise<boolean>;
function releaseFlight(
  key: string,
  flight: SnapshotFlight,
  asyncCleanup: boolean,
): boolean | Promise<boolean> {
  flight.leases -= 1;
  if (flight.leases > 0) {
    return asyncCleanup ? Promise.resolve(true) : true;
  }
  if (snapshotFlights.get(key) === flight) {
    snapshotFlights.delete(key);
  }
  return asyncCleanup ? flight.base!.cleanupAsync() : flight.base!.cleanup();
}

function leaseFlight(
  key: string,
  flight: SnapshotFlight,
  base: PreparedSqliteReadOnlyLocation,
): PreparedSqliteReadOnlyLocation {
  flight.leases += 1;
  let active = true;
  let pending: Promise<boolean> | undefined;
  return {
    location: base.location,
    cleanupRoot: base.cleanupRoot,
    cleanup: () => {
      if (!active || pending) {
        return !active;
      }
      active = false;
      return releaseFlight(key, flight, false);
    },
    cleanupAsync: () => {
      if (!active) {
        return pending ?? Promise.resolve(true);
      }
      active = false;
      pending = Promise.resolve(releaseFlight(key, flight, true)).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

export async function prepareSingleFlightSqliteSnapshot(
  databasePath: string,
  operation: string,
  producer: (signal: AbortSignal) => Promise<PreparedSqliteReadOnlyLocation>,
  signal?: AbortSignal,
): Promise<PreparedSqliteReadOnlyLocation> {
  const identity = readDatabasePathIdentitySync(databasePath);
  const key = `${identity.key}:${operation}`;
  let flight = snapshotFlights.get(key);
  if (!flight) {
    const controller = new AbortController();
    flight = {
      controller,
      leases: 0,
      waiters: 0,
      promise: Promise.resolve().then(() => producer(controller.signal)),
    };
    snapshotFlights.set(key, flight);
    void flight.promise.then(
      (base) => {
        flight!.base = base;
        if (snapshotFlights.get(key) === flight) {
          snapshotFlights.delete(key);
        }
        cleanupUnleasedFlight(key, flight!);
      },
      () => {
        if (snapshotFlights.get(key) === flight) {
          snapshotFlights.delete(key);
        }
      },
    );
  }
  flight.waiters += 1;
  try {
    const base = await waitForFlight(flight.promise, signal);
    signal?.throwIfAborted();
    return leaseFlight(key, flight, base);
  } finally {
    flight.waiters -= 1;
    cleanupUnleasedFlight(key, flight);
  }
}
