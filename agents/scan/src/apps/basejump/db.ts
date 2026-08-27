import { h160 } from "@galacticcouncil/common/utils";

import { pool } from "../../db";
import { validLegs } from "../../flow";

import { transfers } from "./flows";

const VALID = validLegs(transfers);

/**
 * Newest first by when the transfer was initiated, not by when we happened to write the row —
 * `updated_at` tracks the backfill's progress, which is not the transfer's age. A delivery whose
 * source has not been indexed yet sorts by write time until it is.
 */
const NEWEST = `COALESCE((initiated->>'blockTimestamp')::numeric,
                         EXTRACT(EPOCH FROM updated_at) * 1000) DESC`;

export interface AddressCandidates {
  sender: string | null;
  recipient: string[];
}

/**
 * What an address search can match. An EVM address may be either end; an ss58 one only ever names a
 * recipient, since the source chains are EVM.
 *
 * @param input Whatever was typed.
 */
export function addressFilter(input: string): AddressCandidates {
  const s = input.trim();
  if (h160.isEvmAddress(s)) {
    const lower = s.toLowerCase();
    return { sender: lower, recipient: [lower] };
  }
  if (h160.isSs58Address(s)) {
    return { sender: null, recipient: [s.toLowerCase()] };
  }
  return { sender: null, recipient: [] };
}

export async function listTransfers(filter: {
  state?: string;
  address?: AddressCandidates;
  asset?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const conds: string[] = [VALID];
  const params: unknown[] = [];

  if (filter.state) {
    params.push(filter.state);
    conds.push(`state = $${params.length}`);
  }

  if (filter.address) {
    const or: string[] = [];
    if (filter.address.sender) {
      params.push(filter.address.sender);
      or.push(`lower(sender) = $${params.length}`);
    }
    if (filter.address.recipient.length) {
      params.push(filter.address.recipient);
      or.push(`lower(recipient) = ANY($${params.length})`);
    }
    conds.push(or.length ? `(${or.join(" OR ")})` : "FALSE");
  }

  if (filter.asset) {
    params.push(filter.asset.toLowerCase());
    conds.push(`lower(source_asset) = $${params.length}`);
  }

  const where = `WHERE ${conds.join(" AND ")}`;
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM transfers ${where}`, params);
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT * FROM transfers ${where} ORDER BY ${NEWEST} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows, total: total.rows[0].n };
}

export async function getTransfer(id: string): Promise<Record<string, unknown> | null> {
  const r = await pool.query(`SELECT * FROM transfers WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}
