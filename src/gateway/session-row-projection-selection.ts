import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import { resolveSessionKeyBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { listOpenIncognitoAgentDatabases } from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { readSessionRowEntry } from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

/** Metadata-only selection preserves cold rows, federation competitors, and exact indexes. */
export function createSessionRowProjectionSelection(params: {
  rows: ReadonlyMap<string, records.Row>;
  byStore: ReadonlyMap<string, Set<string>>;
  byAgent: ReadonlyMap<string, Set<string>>;
  byParent: ReadonlyMap<string, Set<string>>;
  byKey: ReadonlyMap<string, Set<string>>;
  dirty: ReadonlySet<string>;
  config: () => OpenClawConfig;
  isActive: () => boolean;
  storePaths: () => Iterable<string>;
  physicalPaths: (path: string, agentId?: string) => readonly string[];
  acquire: (row: records.Row) => records.Row | undefined;
}) {
  const { rows, byStore, byAgent, byParent, byKey, dirty, acquire } = params;
  function inScope(row: records.Row, query: records.Query, logicalOwnerOnly = false) {
    return (
      (!query.agentId ||
        row.agentId === query.agentId ||
        (!logicalOwnerOnly && row.storeTarget.agentId === query.agentId)) &&
      (!query.storePath ||
        params.physicalPaths(query.storePath, query.agentId).includes(row.storeTarget.storePath))
    );
  }
  function matching(query: records.Query, kind = "key") {
    const candidates = query.key
      ? byKey.get(`${kind}:${query.key}`)
      : query.storePath
        ? new Set(
            params
              .physicalPaths(query.storePath, query.agentId)
              .flatMap((path) => Array.from(byStore.get(path) ?? [])),
          )
        : query.agentId
          ? byAgent.get(query.agentId)
          : rows.keys();
    return [...(candidates ?? [])]
      .map((id) => rows.get(id))
      .filter((row): row is records.Row => row !== undefined && inScope(row, query));
  }
  function selectEntries(query: records.Query) {
    const cfg = params.config();
    const parent = query.parentSessionKey;
    const owner = parent && parseAgentSessionKey(parent)?.agentId;
    const agents = owner ? [owner] : query.agentId ? [query.agentId] : byAgent.keys();
    const children = new Set<string>();
    if (parent) {
      for (const ref of [
        ...[...agents].map((agentId) => records.parentReference(cfg, parent, agentId)),
        ...matching({ ...query, key: parent }).map((row) =>
          records.physical(row.storeTarget.storePath, parent),
        ),
      ]) {
        for (const id of byParent.get(ref) ?? []) {
          children.add(id);
        }
      }
    }
    const sessionIdOrKey = query.sessionIdOrKey;
    let keys: Set<string> | undefined;
    if (sessionIdOrKey) {
      // Broad publications can change IDs before the resident index has caught up.
      for (const id of dirty) {
        const row = rows.get(id);
        if (row && inScope(row, query, true)) {
          acquire(row);
        }
      }
      const indexed = { ...query, key: sessionIdOrKey };
      keys = new Set([...matching(indexed, "id"), ...matching(indexed)].map((row) => row.key));
    }
    // Keep every physical competitor; federation precedes ID and visibility filtering.
    const candidates = keys
      ? [...keys].flatMap((key) => matching({ ...query, key }))
      : parent
        ? [...children].map((id) => rows.get(id))
        : matching(query);
    const selected = candidates
      .map((row) =>
        row && !sessionIdOrKey && dirty.has(records.identity(row)) ? acquire(row) : row,
      )
      .filter(records.hasEntry)
      .filter((row) => inScope(row, query, true));
    return records.sort(selected, query.sortBy);
  }
  function lookup(query: records.Lookup) {
    if (!params.isActive()) {
      return undefined;
    }
    const { agentId } = query;
    const exact = matching(query).filter((row) => row.agentId === agentId);
    if (exact.length) {
      return records.first(exact, params.storePaths());
    }
    const cfg = params.config();
    const key = resolveStoredSessionKeyForAgentStore({
      cfg,
      sessionKey: query.key,
      agentId,
    });
    if (isIncognitoSessionKey(key)) {
      const ephemeralPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
      if (!listOpenIncognitoAgentDatabases().some((store) => store.storePath === ephemeralPath)) {
        return undefined;
      }
      const row = records.create({
        key,
        agentId,
        storeTarget: { agentId, storePath: ephemeralPath },
      });
      const storedEntry = readSessionRowEntry(row);
      return storedEntry
        ? Object.assign(row, { storedEntry, entry: projectGatewaySessionEntry(cfg, storedEntry) })
        : undefined;
    }
    const candidates = matching({ ...query, key }).filter((row) => row.agentId === agentId);
    return records.first(candidates, params.storePaths());
  }
  function referenced(ref: string) {
    return records.first(
      [...(byKey.get(ref) ?? [])].flatMap((id) => rows.get(id) ?? []),
      params.storePaths(),
    );
  }
  function isCurrent(row: records.Row) {
    const current = isIncognitoSessionKey(row.key)
      ? lookup({ ...row, storePath: row.storeTarget.storePath })
      : rows.get(records.identity(row));
    return records.isCurrentGeneration(row, current);
  }
  function findBySessionId(query: { sessionId: string; agentId?: string; storePath?: string }) {
    if (
      !query.agentId ||
      !query.storePath ||
      !isIncognitoOpenClawAgentSqlitePath(query.storePath, { agentId: query.agentId })
    ) {
      return matching({ ...query, key: query.sessionId }, "id");
    }
    const key = params.isActive() && resolveSessionKeyBySessionId(query);
    const row = key ? lookup({ ...query, agentId: query.agentId, key }) : undefined;
    return row?.entry?.sessionId === query.sessionId ? [row] : [];
  }
  return { inScope, matching, selectEntries, lookup, referenced, isCurrent, findBySessionId };
}
