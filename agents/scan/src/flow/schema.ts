import type { Flow } from "../types";

/** The rank function's name for a flow — used by the upsert and by any hand-written query. */
export function rankFn(f: Flow): string {
  return `${f.table}_state_rank`;
}

/**
 * The flow's DDL: its table, the rank function its states define, and its indexes. Idempotent, so a
 * process runs it at every boot.
 *
 * `CREATE TABLE IF NOT EXISTS` alone would never add a column to a table that already exists, which
 * would make adding a field to a flow silently do nothing. Every column is therefore also issued as
 * an `ADD COLUMN IF NOT EXISTS`, so a flow definition is the schema rather than merely its initial
 * shape. Populating a new column still needs the reader re-run over the events that fill it.
 *
 * @param f The flow.
 */
export function ddl(f: Flow): string {
  const cols = Object.entries(f.columns).map(([c, t]) => `  ${c} ${t}`);
  const added = Object.entries(f.columns).map(
    ([c, t]) => `ALTER TABLE ${f.table} ADD COLUMN IF NOT EXISTS ${c} ${t};`,
  );
  const cases = Object.entries(f.states)
    .map(([s, rank]) => `    WHEN '${s}' THEN ${rank}`)
    .join("\n");

  const unique = (f.unique ?? []).map(
    (u) =>
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_${f.table}_${u} ON ${f.table} (${u}) WHERE ${u} IS NOT NULL;`,
  );

  return [
    `CREATE TABLE IF NOT EXISTS ${f.table} (`,
    `  ${f.key.column} ${f.key.type} PRIMARY KEY,`,
    `  state TEXT NOT NULL,`,
    `${cols.join(",\n")},`,
    `  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `);`,
    ``,
    ...added,
    ``,
    ...unique,
    `CREATE INDEX IF NOT EXISTS idx_${f.table}_state ON ${f.table} (state);`,
    `CREATE INDEX IF NOT EXISTS idx_${f.table}_updated ON ${f.table} (updated_at DESC);`,
    ...(f.indexes ?? []),
    ``,
    `CREATE OR REPLACE FUNCTION ${rankFn(f)}(s TEXT) RETURNS INT AS $$`,
    `  SELECT CASE s`,
    cases,
    `    ELSE -1`,
    `  END;`,
    `$$ LANGUAGE SQL IMMUTABLE;`,
  ].join("\n");
}

/**
 * A SQL predicate keeping only rows whose legs have their prerequisites. A row carrying a
 * downstream leg alone — a delivery whose origin was never indexed — is excluded rather than shown
 * half-built.
 *
 * @param f The flow.
 * @param alias Table alias to qualify the columns with, for a query that joins.
 * @returns The predicate, or `TRUE` when the flow declares no prerequisites.
 */
export function validLegs(f: Flow, alias?: string): string {
  const entries = Object.entries(f.requires ?? {});
  if (entries.length === 0) return "TRUE";
  const q = alias ? `${alias}.` : "";
  return entries
    .map(([ref, needs]) => `(${q}${ref} IS NULL OR ${q}${needs} IS NOT NULL)`)
    .join(" AND ");
}
