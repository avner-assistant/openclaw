import * as records from "./session-row-projection-record.js";

// Exact reads retain a small cache; larger list pages need their whole backfill window.
const DEFAULT_ARCHIVED_MATERIALIZED_ROWS = 100;

export function isColdArchivedSessionRow(row: records.Row) {
  return row.entry?.archivedAt !== undefined && !row.materialized;
}

/** Archived metadata outlives its bounded, reader-populated materialization cache. */
export function createSessionRowProjectionArchive(params: {
  rows: ReadonlyMap<string, records.Row>;
  put: (row: records.Row) => void;
  release: (id: string) => void;
  prepare: (row: records.Row) => records.Row | undefined;
}) {
  const materialized = new Set<string>();
  let limit = DEFAULT_ARCHIVED_MATERIALIZED_ROWS;
  function demote(row: records.Row): records.Row {
    const id = records.identity(row);
    materialized.delete(id);
    params.release(id);
    const cold = records.dematerialize(row);
    params.put(cold);
    return cold;
  }
  function trim() {
    while (materialized.size > limit) {
      demote(params.rows.get(materialized.values().next().value!)!);
    }
  }
  return {
    demote,
    setPageSize: (size: number) => {
      limit = Math.max(DEFAULT_ARCHIVED_MATERIALIZED_ROWS, size);
      trim();
    },
    forget: (id: string) => materialized.delete(id),
    clear: () => materialized.clear(),
    invalidate() {
      for (const id of materialized) {
        demote(params.rows.get(id)!);
      }
    },
    describe(initial: records.Row | undefined) {
      if (initial?.entry?.archivedAt === undefined) {
        return initial;
      }
      const row = initial.materialized ? initial : params.prepare(initial);
      if (records.ready(row) && row.entry.archivedAt !== undefined) {
        const id = records.identity(row);
        materialized.delete(id);
        materialized.add(id);
        trim();
      }
      return row;
    },
  };
}
