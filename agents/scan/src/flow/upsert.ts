import type { Pool, PoolClient } from "pg";

import type { Flow } from "../types";
import { rankFn } from "./schema";

export type Row = Record<string, unknown> & { state: string };

export interface Applied {
  row: Row;
  created: boolean;
  previousState: string | null;
}

/** One statement per (flow, key column) — the shape never varies, only the values. */
const statements = new Map<string, string>();

/**
 * The upsert every leg goes through. Rows merge rather than overwrite: state advances by rank and
 * never regresses, and every other column is COALESCEd, so legs may arrive in any order and a leg
 * that carries only part of the record leaves the rest alone.
 *
 * Every column is written on every call, absent ones as null. One SQL shape per flow is worth more
 * than the few bytes a narrower statement would save.
 *
 * @param f The flow.
 * @param keyBy Column the key addresses — the primary key, or one of the flow's unique columns.
 */
function sql(f: Flow, keyBy: string): string {
  const memo = `${f.table}:${keyBy}`;
  const hit = statements.get(memo);
  if (hit) return hit;

  const t = f.table;
  const rank = rankFn(f);
  const cols = Object.keys(f.columns);
  const prev = `WITH prev AS (SELECT state FROM ${t} WHERE ${keyBy} = $1)`;
  const returning = `RETURNING ${t}.*, (SELECT state FROM prev) AS previous_state`;

  let out: string;
  if (keyBy === f.key.column) {
    const values = cols.map((_, i) => `$${i + 3}`).join(", ");
    const merge = cols.map((c) => `  ${c} = COALESCE(EXCLUDED.${c}, ${t}.${c})`).join(",\n");
    out = [
      prev,
      `INSERT INTO ${t} (${f.key.column}, state, ${cols.join(", ")}, updated_at)`,
      `VALUES ($1, $2, ${values}, NOW())`,
      `ON CONFLICT (${f.key.column}) DO UPDATE SET`,
      `  state = CASE WHEN ${rank}(EXCLUDED.state) > ${rank}(${t}.state)`,
      `               THEN EXCLUDED.state ELSE ${t}.state END,`,
      merge + ",",
      `  updated_at = NOW()`,
      returning,
    ].join("\n");
  } else {
    // An alternate key cannot create the row — it only exists once the leg that bound this column
    // has landed. Within a transaction that ordering is guaranteed by log index.
    const merge = cols
      .map((c, i) => `  ${c} = COALESCE($${i + 3}::${f.columns[c]}, ${t}.${c})`)
      .join(",\n");
    out = [
      prev,
      `UPDATE ${t} SET`,
      `  state = CASE WHEN ${rank}($2) > ${rank}(${t}.state) THEN $2 ELSE ${t}.state END,`,
      merge + ",",
      `  updated_at = NOW()`,
      `WHERE ${keyBy} = $1`,
      returning,
    ].join("\n");
  }

  statements.set(memo, out);
  return out;
}

/**
 * Merge one leg's contribution into its row.
 *
 * @param db Pool or an in-transaction client.
 * @param f The flow.
 * @param keyBy Column the key addresses.
 * @param key The correlation key.
 * @param state The state this leg claims.
 * @param patch Columns to merge; anything not named is left untouched.
 * @returns The merged row, or null when an alternate key matched nothing.
 */
export async function reconcile(
  db: Pool | PoolClient,
  f: Flow,
  keyBy: string,
  key: string,
  state: string,
  patch: Record<string, unknown>,
): Promise<Applied | null> {
  const values = Object.keys(f.columns).map((c) => patch[c] ?? null);
  const r = await db.query(sql(f, keyBy), [key, state, ...values]);
  const row = r.rows[0] as (Row & { previous_state: string | null }) | undefined;
  if (!row) return null;
  return { row, created: row.previous_state === null, previousState: row.previous_state };
}
