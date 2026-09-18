import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds, withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  projectGatewaySessionEntry,
} from "../config/sessions/combined-store-gateway.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { retainUserProfileCatalog } from "../state/user-profile-list.js";
import {
  readSessionRowFacts,
  readSessionRowHasBoard,
} from "./server-methods/session-placement-read-projection.js";
import { yieldSessionListWork } from "./session-projection-work.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import {
  createSessionRowProjectionArchive,
  isColdArchivedSessionRow as isCold,
} from "./session-row-projection-archive.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { createSessionRowProjectionContext } from "./session-row-projection-context.js";
import {
  readResidentSessionRow,
  readSessionRowEntry,
} from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjectionSelection } from "./session-row-projection-selection.js";
import { createSessionRowProjectionTranscriptUpdates } from "./session-row-projection-transcript.js";
import { prepareSessionRowScopes } from "./session-row-scope.js";

/** Committed publications own invalidation; each admitted physical store is hydrated once. */
export async function createSessionRowProjection(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  modelCatalog?: records.Inputs["modelCatalog"];
  getModelCatalog?: () => Promise<records.Inputs["modelCatalog"]>;
  context?: Parameters<typeof readSessionRowFacts>[0]["context"];
}) {
  // Publications may borrow startup admission; projection work retains its own authority.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let cfg = params.cfg;
  let modelCatalog = params.modelCatalog;
  const rows = new Map<string, records.Row>();
  let stores = new Map<
    string,
    { target: SessionStoreTarget; agentId: string; identity: string | symbol; filename: string }
  >();
  const byStore = new Map<string, Set<string>>(),
    byAgent = new Map<string, Set<string>>();
  const byParent = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>();
  const indexes = { byStore, byAgent, byParent, byKey };
  const dirty = new Set<string>();
  let topologyDirty = true,
    catalogDirty = params.getModelCatalog ? Symbol("catalog") : undefined,
    disposed = false;
  let epoch = 0;
  let materializedCount = 0;
  let scope: ReturnType<typeof prepareSessionRowScopes>;
  let pending: Promise<void> | undefined;
  const selection = createSessionRowProjectionSelection({
    rows,
    ...indexes,
    dirty,
    config: () => cfg,
    isActive: () => !disposed,
    storePaths: () => stores.keys(),
    physicalPaths: (path, agentId) => scope?.physicalPaths(path, agentId) ?? [path],
    acquire: (row) => acquireEntry(row, readSessionRowEntry(row)),
  });
  const { inScope, matching, lookup, referenced, isCurrent } = selection;
  const metadata = createSessionRowProjectionContext();
  const backfill = createSessionRowProjectionBackfill({
    ready: ensureMaterialized,
    read: (id) => rows.get(id),
    current(row) {
      const current = rows.get(records.identity(row));
      return (
        !topologyDirty &&
        records.ready(current) &&
        isCurrent(row) &&
        (current.entry.archivedAt === undefined || current.materialized === row.materialized)
      );
    },
    publish(row, fields) {
      const current = rows.get(records.identity(row));
      if (
        current?.materialized &&
        (current.lastMessagePreview !== fields.lastMessagePreview ||
          !isDeepStrictEqual(current.fallbackModel, fields.fallbackModel))
      ) {
        Object.assign(current, {
          lastMessagePreview: fields.lastMessagePreview,
          fallbackModel: fields.fallbackModel,
        });
        dirty.add(records.identity(current));
        void ensureMaterialized().catch(() => {});
      }
    },
  });
  const archive = createSessionRowProjectionArchive({
    rows,
    put,
    release(id) {
      transcriptUpdates.remove(id);
      backfill.remove(id);
      dirty.delete(id);
    },
    prepare(row) {
      metadata.prepare(epoch);
      const current = acquireEntry(row, readSessionRowEntry(row));
      if (current && materialize(current)) {
        backfill.enqueue(records.identity(current));
      }
      return current;
    },
  });
  function markRelated(row: records.Row) {
    const related = new Set<string>();
    records.markRelated(row, indexes, related);
    for (const id of related) {
      const current = rows.get(id);
      if (current && !isCold(current)) {
        dirty.add(id);
      }
    }
  }
  function remove(id: string) {
    archive.forget(id);
    transcriptUpdates.remove(id);
    const row = rows.get(id);
    if (row) {
      markRelated(row);
      records.index(row, indexes, true);
      rows.delete(id);
    }
    dirty.delete(id);
    backfill.remove(id);
  }
  function put(row: records.Row) {
    const previous = rows.get(records.identity(row));
    if (previous) {
      if (previous.generation !== row.generation) {
        transcriptUpdates.remove(records.identity(row));
      }
      records.index(previous, indexes, true);
    }
    rows.set(records.identity(row), row);
    records.index(row, indexes);
  }
  function acquireEntry(row: records.Row, storedEntry: SessionEntry | undefined) {
    if (!storedEntry || storedEntry.incognito) {
      remove(records.identity(row));
      return undefined;
    }
    if (storedEntry.archivedAt !== undefined) {
      inOwnerContext(() => metadata.prepare(epoch));
    }
    const entry = projectGatewaySessionEntry(cfg, storedEntry);
    const parents = new Set(
      [
        storedEntry.parentSessionKey ?? resolveSessionParentSessionKey(row.key),
        storedEntry.spawnedBy,
        ...(metadata.current.subagentRunsByChildSessionKey.get(row.key) ?? []).map(
          (run) => run.controllerSessionKey || run.requesterSessionKey,
        ),
      ].flatMap((key) =>
        key && key !== row.key
          ? [records.parentReference(cfg, key, row.agentId, row.storeTarget.storePath)]
          : [],
      ),
    );
    const changed = !isDeepStrictEqual([storedEntry, parents], [row.storedEntry, row.parents]);
    if (changed) {
      markRelated(row);
    }
    const generation =
      !row.entry ||
      (row.entry.sessionId === entry.sessionId &&
        row.entry.lifecycleRevision === entry.lifecycleRevision)
        ? row.generation
        : Symbol("row");
    let next: records.Row = {
      ...row,
      storedEntry,
      entry,
      parents,
      generation,
      hasBoard:
        entry.archivedAt !== undefined
          ? (row.hasBoard ?? readSessionRowHasBoard(row))
          : row.hasBoard,
      fallbackModel: records.sameFallbackModelFacts(row.storedEntry, storedEntry)
        ? row.fallbackModel
        : undefined,
      ...(generation !== row.generation
        ? { lastMessagePreview: undefined, fallbackModel: undefined, materialized: undefined }
        : {}),
    };
    put(next);
    if (entry.archivedAt !== undefined && row.entry?.archivedAt === undefined) {
      next = archive.demote(next);
    } else if (entry.archivedAt === undefined) {
      archive.forget(records.identity(next));
    }
    if (changed) {
      markRelated(next);
    }
    return next;
  }
  function topology() {
    const revision = epoch;
    cfg = params.getConfig?.() ?? cfg;
    const admitted = new Set<string>();
    const nextStores: typeof stores = new Map();
    const replaced = new Set<string>();
    const loaded = loadCombinedSessionStoreForGatewayCore(cfg, {
      includeIncognito: false,
      preserveSentinelOwners: "physical",
      loadEntries(target, projection) {
        const opened = withOpenClawAgentDatabaseReadOnly(readOpenClawAgentDatabaseIdentity, {
          agentId: target.agentId,
          path: target.storePath,
        });
        if (!opened.found) {
          return [];
        }
        const databaseIdentity = opened.value.identity;
        const previous =
          stores.get(target.storePath) ??
          [...stores.values()].find((source) => source.identity === databaseIdentity);
        nextStores.set(target.storePath, {
          target,
          agentId: previous?.agentId ?? target.agentId,
          identity: databaseIdentity,
          filename: opened.value.filename,
        });
        if (previous?.identity === databaseIdentity) {
          return [...(byStore.get(previous.target.storePath) ?? [])].flatMap((id) => {
            const row = rows.get(id);
            const entry = row && (row.storedEntry ?? readSessionRowEntry(row));
            return row && entry ? [{ sessionKey: row.key, entry }] : [];
          });
        }
        replaced.add(target.storePath);
        return listSessionEntriesReadOnly({ ...target, projection, clone: false });
      },
      onStoreLoaded(target, agentId) {
        const source = nextStores.get(target.storePath);
        if (source) {
          source.agentId = agentId;
        }
      },
    });
    for (const [key, target] of loaded.targetsBySessionKey) {
      const entry = target.entry;
      if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
        continue;
      }
      const fields = {
        key: target.storeKey ?? key,
        agentId: target.agentId,
        storeTarget: target.storeTarget,
      };
      const id = records.identity(fields);
      admitted.add(id);
      if (!rows.has(id) || replaced.has(target.storeTarget.storePath)) {
        remove(id);
        const row = acquireEntry(records.create(fields), entry);
        if (row && !isCold(row)) {
          dirty.add(id);
          backfill.enqueue(id);
        }
      } else {
        const row = rows.get(id)!;
        if (row.entry?.archivedAt !== undefined) {
          acquireEntry(row, entry);
        }
      }
    }
    for (const id of rows.keys()) {
      if (!admitted.has(id)) {
        remove(id);
      }
    }
    stores = nextStores;
    scope = prepareSessionRowScopes(
      cfg,
      byAgent.keys(),
      new Map([...stores].map(([locator, source]) => [source.filename, locator])),
    );
    topologyDirty = epoch !== revision;
  }
  function mark(change: SessionRowChange) {
    epoch++;
    metadata.invalidate(change);
    if ("all" in change) {
      topologyDirty ||= change.scope === "stores" || change.scope === "config";
      if (params.getModelCatalog && (change.scope === "catalog" || change.scope === "config")) {
        catalogDirty = Symbol("catalog");
      }
      for (const previous of typeof change.scope === "string"
        ? rows.values()
        : matching(change.scope)) {
        const row =
          typeof change.scope === "object" && previous.entry?.archivedAt !== undefined
            ? inOwnerContext(() =>
                acquireEntry({ ...previous, hasBoard: undefined }, readSessionRowEntry(previous)),
              )
            : change.scope === "subagent-runs" && previous.entry?.archivedAt !== undefined
              ? inOwnerContext(() => acquireEntry(previous, previous.storedEntry))
              : previous;
        if (!row) {
          continue;
        }
        if (row.entry?.archivedAt !== undefined) {
          if (row.materialized) {
            archive.demote(row);
          }
          continue;
        }
        dirty.add(records.identity(row));
        backfill.enqueue(records.identity(row), change);
      }
    } else if (change.scope === "automation") {
      records.markAutomation(
        matching({ key: change.sessionKey }).filter((row) => !isCold(row)),
        change.agentId,
        dirty,
      );
    } else {
      const query = { ...change, key: change.sessionKey };
      const exact = matching(query);
      const found = new Set([...exact, ...matching(query, "id")]);
      for (const previous of found) {
        markRelated(previous);
        const row = inOwnerContext(() => {
          const entry = readSessionRowEntry(previous);
          return isCold(previous) || records.changesRowStructure(previous, entry)
            ? acquireEntry({ ...previous, hasBoard: undefined }, entry)
            : previous;
        });
        if (!row) {
          continue;
        }
        if (!isCold(row)) {
          dirty.add(records.identity(row));
          backfill.enqueue(records.identity(row));
        }
      }
      if (
        !exact.length &&
        !isInternalSessionEffectsKey(change.sessionKey) &&
        !isIncognitoSessionKey(change.sessionKey)
      ) {
        for (const source of stores.values()) {
          const agentId = parseAgentSessionKey(change.sessionKey)?.agentId ?? source.agentId;
          const row = records.create({
            key: change.sessionKey,
            agentId,
            storeTarget: source.target,
          });
          if (!inScope(row, change) || (!change.storePath && agentId !== source.agentId)) {
            continue;
          }
          const admitted = inOwnerContext(() => acquireEntry(row, readSessionRowEntry(row)));
          if (!admitted || isCold(admitted)) {
            continue;
          }
          dirty.add(records.identity(admitted));
          backfill.enqueue(records.identity(admitted));
        }
      }
    }
    void ensureMaterialized().catch(() => {
      /* Dirty keys retain failed background work for the next reader. */
    });
  }
  function readSourceEntry(row: records.Row, key: string) {
    const source = referenced(
      records.parentReference(cfg, key, row.agentId, row.storeTarget.storePath),
    );
    return (
      source &&
      (dirty.has(records.identity(source)) ? readSessionRowEntry(source) : source.storedEntry)
    );
  }
  function materialize(row: records.Row, configuredAgentIds = new Set(listAgentIds(cfg))) {
    if (!row.entry) {
      return false;
    }
    const links = [...records.dependents(row, byParent)].flatMap((child) => {
      let value = rows.get(child);
      if (value && dirty.has(child)) {
        value = acquireEntry(value, readSessionRowEntry(value));
      }
      return value?.entry && [...value.parents].some((ref) => referenced(ref) === row)
        ? [{ key: value.key, entry: value.entry }]
        : [];
    });
    // Keyed child refreshes reorder the parent index; presentation must stay stable.
    links.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const prepared = readResidentSessionRow({
      row: { ...row, entry: row.entry },
      cfg,
      modelCatalog,
      configuredAgentIds,
      context: metadata.current,
      subagentInputs: metadata.subagentInputs,
      gatewayContext: params.context,
      links,
      readSourceEntry: (key) => readSourceEntry(row, key),
    });
    if (!isIncognitoSessionKey(row.key) && rows.get(records.identity(row)) !== row) {
      return false;
    }
    Object.assign(row, prepared, { materializedSequence: ++materializedCount });
    return true;
  }
  function refresh(ids: readonly string[]) {
    if (disposed) {
      return;
    }
    const started = performance.now();
    metadata.prepare(epoch);
    const configuredAgentIds = new Set(listAgentIds(cfg));
    for (const [offset, id] of ids.entries()) {
      if (offset > 0 && performance.now() - started >= 12) {
        break;
      }
      const current = rows.get(id),
        revision = epoch;
      const row = current && acquireEntry(current, readSessionRowEntry(current));
      if (row && isCold(row)) {
        dirty.delete(id);
        backfill.remove(id);
        continue;
      }
      if (row && materialize(row, configuredAgentIds) && epoch === revision && !catalogDirty) {
        dirty.delete(id);
      }
    }
  }
  async function refreshBatch() {
    if (topologyDirty) {
      topology();
    }
    if (catalogDirty) {
      const revision = catalogDirty;
      const next = await params.getModelCatalog?.();
      if (disposed || catalogDirty !== revision) {
        return;
      }
      modelCatalog = next;
      archive.invalidate();
      catalogDirty = undefined;
    }
    withAgentRosterFactsBatch(cfg, () => refresh([...dirty].slice(0, 64)));
  }
  async function drain() {
    for (;;) {
      if (disposed || (!topologyDirty && !catalogDirty && !dirty.size)) {
        return;
      }
      await refreshBatch();
      if (dirty.size || topologyDirty) {
        await yieldSessionListWork();
      }
    }
  }
  function ensureMaterialized(): Promise<void> {
    if (disposed || (!topologyDirty && !catalogDirty && !dirty.size)) {
      return pending ?? Promise.resolve();
    }
    return (pending ??= yieldSessionListWork()
      .then(() => inOwnerContext(drain))
      .then(
        () => {
          pending = undefined;
          if (!disposed && (topologyDirty || catalogDirty || dirty.size)) {
            return ensureMaterialized();
          }
          return undefined;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      ));
  }
  const transcriptUpdates = createSessionRowProjectionTranscriptUpdates({
    matching,
    mark,
    read: (id) => rows.get(id),
    refresh(id) {
      const row = rows.get(id);
      if (!row || isCold(row)) {
        return;
      }
      epoch++;
      dirty.add(id);
      backfill.enqueue(id);
      void ensureMaterialized().catch(() => {});
    },
  });
  const stop = [
    retainUserProfileCatalog(),
    sessionChanges.subscribe(mark),
    onSessionLifecycleEvent(mark),
    registerPreparedModelRuntimePublicationListener((event) => {
      // An incomplete catalog read still needs the next publication to recover its rows.
      if (
        (event.phase === "catalog-published" || event.phase === "catalog-failed") &&
        event.modelFactsChanged === false &&
        modelCatalog !== undefined &&
        (!(modelCatalog instanceof Map) || ![...modelCatalog.values()].includes(undefined))
      ) {
        return;
      }
      mark({ all: true, scope: "catalog" });
    }),
    onSessionIdentityMutation((mutation) => {
      for (const key of mutation.previous.sessionKeys) {
        for (const row of matching({ key, agentId: mutation.agentId })) {
          if (mutation.previous.sessionId && row.entry?.sessionId !== mutation.previous.sessionId) {
            continue;
          }
          markRelated(row);
          if ("current" in mutation && mutation.current.sessionKeys.includes(row.key)) {
            put({
              ...row,
              entry: undefined,
              storedEntry: undefined,
              materialized: undefined,
              lastMessagePreview: undefined,
              fallbackModel: undefined,
              generation: Symbol("row"),
            });
            dirty.add(records.identity(row));
          } else {
            remove(records.identity(row));
          }
        }
      }
      if ("current" in mutation) {
        for (const sessionKey of mutation.current.sessionKeys) {
          mark({ agentId: mutation.agentId, sessionKey });
        }
      } else {
        void ensureMaterialized().catch(() => {});
      }
    }),
  ];
  const describe = (query: records.Lookup, captured?: records.Row) =>
    inOwnerContext(() => {
      if (disposed) {
        return undefined;
      }
      if (topologyDirty) {
        topology();
      }
      let row = lookup(query);
      if (row && isIncognitoSessionKey(row.key)) {
        metadata.prepare(epoch);
        materialize(row);
      } else {
        if (row && dirty.has(records.identity(row))) {
          // Keyed reads refresh only their owner; unrelated bulk work never gates a response.
          const id = records.identity(row);
          withAgentRosterFactsBatch(cfg, () => refresh([id]));
          row = lookup(query);
        }
        row = archive.describe(row);
      }
      if (captured && !isCurrent(captured)) {
        return undefined;
      }
      return records.ready(row) ? row : undefined;
    });
  function dispose() {
    disposed = true;
    transcriptUpdates.dispose();
    backfill.dispose();
    for (const unsubscribe of stop) {
      unsubscribe();
    }
    for (const map of [rows, stores, byStore, byAgent, byParent, byKey]) {
      map.clear();
    }
    dirty.clear();
    archive.clear();
  }
  function selectEntries(query: records.Query = {}) {
    if (disposed) {
      return [];
    }
    return inOwnerContext(() => {
      if (topologyDirty) {
        inOwnerContext(topology);
      }
      return withAgentRosterFactsBatch(cfg, () => selection.selectEntries(query));
    });
  }
  await inOwnerContext(refreshBatch).catch((error: unknown) => {
    dispose();
    throw error;
  });
  void ensureMaterialized().catch(() => {});
  backfill.start();
  const projection = {
    capture(query: records.Lookup) {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      const row = lookup(query);
      return row && dirty.has(records.identity(row))
        ? (acquireEntry(row, readSessionRowEntry(row)) ?? row)
        : row;
    },
    findBySessionId: selection.findBySessionId,
    describe,
    setArchivePageSize: archive.setPageSize,
    modelFacts(row: records.EntryRow) {
      return readSessionRowModelFacts({
        cfg,
        ...row,
        source: { entry: row.storedEntry, readSourceEntry: (key) => readSourceEntry(row, key) },
        modelCatalog,
        rowContext: metadata.current,
      });
    },
    present: (record: records.MaterializedRow, options?: records.SnapshotOptions) =>
      records.present(record, metadata.current, options),
    withPreparedExactRows<T>(
      queries: (config: OpenClawConfig) => readonly records.Lookup[],
      consume: (read: SessionRowReadView) => T,
    ): ReturnType<typeof withPreparedSessionRows<T>> {
      return withPreparedSessionRows(projection, () => !disposed, queries, consume);
    },
    ensureMaterialized,
    get materializedCount() {
      return materializedCount;
    },
    get dirtyRowCount() {
      return dirty.size;
    },
    get needsMaterialization() {
      return !disposed && (topologyDirty || Boolean(catalogDirty) || dirty.size > 0);
    },
    get state() {
      if (!disposed && topologyDirty) {
        inOwnerContext(topology);
      }
      if (!disposed) {
        metadata.prepare(epoch);
      }
      return { cfg, modelCatalog, rowContext: metadata.current, scope: scope.select };
    },
    isCurrent,
    selectEntries,
    snapshot(query: records.Lookup, options: records.SnapshotOptions = {}) {
      const record = describe(query);
      return record
        ? {
            row: records.present(record, metadata.current, options),
            lifecycleRunId: record.entry.lifecycleRunId,
          }
        : { row: null };
    },
    dispose,
  };
  return projection;
}

export type SessionRowProjection = Awaited<ReturnType<typeof createSessionRowProjection>>;
