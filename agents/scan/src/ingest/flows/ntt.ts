import {
  InboundTransferQueuedEvt,
  LogMessagePublishedEvt,
  ReceivedMessageEvt,
  TransferRedeemedEvt,
} from "../../abi";
import { CHAINS } from "../../chains";
import type { Flow, LogEvent } from "../../types";
import { parseNttTransfer } from "../payload";
import { vaaId } from "../vaa";

interface Published {
  sender: `0x${string}`;
  sequence: bigint;
  payload: `0x${string}`;
}

interface Received {
  /** NTT's own name for it, but this is the VAA hash — not the digest deliveries settle on. */
  digest: `0x${string}`;
  emitterChainId: number;
  emitterAddress: `0x${string}`;
  sequence: bigint;
}

/**
 * NTT transfers, both directions, keyed on the digest NTT itself settles on.
 *
 * Chains are indexed in parallel and at wildly different speeds, so events arrive in no particular
 * order — a destination at the tip while its source is still backfilling would have nothing to
 * attach to. The digest is the key because it is the one name every delivery event carries and the
 * source can derive: whichever side arrives first creates the row, the other merges into it, and
 * the lifecycle comes out ordered however the events did not.
 *
 * Nothing on-chain publishes that digest beside its VAA — the transceiver's `ReceivedMessage`
 * carries the VAA hash, a different value — so it is derived from the published payload, exactly as
 * NTT computes it.
 *
 * The two terminal states are exclusive at first delivery: a rate-limited transfer is queued and
 * returns before anything is credited, so `TransferRedeemed` is the release and nothing else is.
 * `completeInboundQueuedTransfer` emits it later, which is why `redeemed` outranks `queued`.
 */
export const ntt: Flow = {
  name: "ntt",
  table: "ntt_transfers",
  key: { column: "digest", type: "TEXT" },
  unique: ["vaa_id"],
  states: { published: 0, received: 1, queued: 2, redeemed: 3 },
  columns: {
    /** The VAA carrying it, in `chain/emitter/sequence` form. Joins to `wh_messages`. */
    vaa_id: "TEXT",
    source_chain: "TEXT",
    source_manager: "TEXT",
    recipient_manager: "TEXT",
    /** The manager's own sequence — what a feature riding this rail correlates on. */
    manager_sequence: "BIGINT",
    /** Trimmed to `decimals`, the precision the rail carries rather than the token's. */
    amount: "NUMERIC",
    decimals: "SMALLINT",
    source_token: "TEXT",
    /** As the 32 bytes the message carries; only an EVM destination trims to an address. */
    recipient: "TEXT",
    to_chain: "INTEGER",
    /** What the transceiver marks consumed. A different hash from the digest, and both matter. */
    vaa_hash: "TEXT",
    published: "JSONB",
    received: "JSONB",
    settled: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_ntt_transfers_seq ON ntt_transfers (source_chain, source_manager, manager_sequence);`,
    `CREATE INDEX IF NOT EXISTS idx_ntt_transfers_recipient ON ntt_transfers (recipient);`,
  ],
  legs: [
    {
      role: "wormhole-core",
      abi: LogMessagePublishedEvt,
      state: "published",
      // The same transceiver publishes peer and init broadcasts; only transfers parse.
      key: (a: Published, ev: LogEvent) =>
        parseNttTransfer(a.payload, CHAINS[ev.chain].wormholeId)?.digest ?? null,
      patch: (a: Published, ev: LogEvent) => {
        const t = parseNttTransfer(a.payload, CHAINS[ev.chain].wormholeId)!;
        return {
          vaa_id: vaaId(CHAINS[ev.chain].wormholeId, a.sender, a.sequence),
          source_chain: ev.chain,
          source_manager: t.sourceManager,
          recipient_manager: t.recipientManager,
          manager_sequence: t.sequence.toString(),
          amount: t.amount.toString(),
          decimals: t.decimals,
          source_token: t.sourceToken,
          recipient: t.to,
          to_chain: t.toChain,
          published: ev.ref,
        };
      },
    },
    {
      // The one leg that names the VAA rather than the digest, so it addresses the row the other
      // way round. It carries only a timestamp and a hash, so on the rare occasion the source has
      // not been indexed yet and there is nothing to update, nothing of substance is lost.
      role: "ntt",
      abi: ReceivedMessageEvt,
      state: "received",
      keyBy: "vaa_id",
      key: (a: Received) => vaaId(a.emitterChainId, a.emitterAddress, a.sequence),
      patch: (a: Received, ev: LogEvent) => ({ vaa_hash: a.digest, received: ev.ref }),
    },
    {
      role: "ntt",
      abi: TransferRedeemedEvt,
      state: "redeemed",
      keyBy: "digest",
      key: (a: { digest: `0x${string}` }) => a.digest,
      patch: (_a: unknown, ev: LogEvent) => ({ settled: ev.ref }),
    },
    {
      role: "ntt",
      abi: InboundTransferQueuedEvt,
      state: "queued",
      keyBy: "digest",
      key: (a: { digest: `0x${string}` }) => a.digest,
      patch: (_a: unknown, ev: LogEvent) => ({ settled: ev.ref }),
    },
  ],
};
