import { LogMessagePublishedEvt } from "../../abi";
import { CHAINS } from "../../chains";
import type { Flow, LogEvent } from "../../types";
import { vaaId } from "../vaa";

interface Published {
  sender: `0x${string}`;
  sequence: bigint;
  nonce: number;
  payload: `0x${string}`;
  consistencyLevel: number;
}

/**
 * Every Wormhole message our emitters publish.
 *
 * The bottom layer: NTT settlements, intent forwarding instructions, quote authorizations and
 * oracle updates all leave through the same core, and each is a row here. Whether a message exists
 * yet, at what sequence, carrying what — the question every feature otherwise has to ask
 * wormholescan.
 *
 * The core is shared with the whole chain, so which senders count is decided by the watch list's
 * topic filter rather than here.
 */
export const messages: Flow = {
  name: "messages",
  table: "wh_messages",
  key: { column: "vaa_id", type: "TEXT" },
  states: { published: 0 },
  columns: {
    chain: "TEXT",
    emitter: "TEXT",
    sequence: "BIGINT",
    nonce: "BIGINT",
    /** 200 publishes immediately, 202 waits for finality. */
    consistency: "SMALLINT",
    payload: "TEXT",
    published: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_wh_messages_emitter ON wh_messages (chain, emitter, sequence DESC);`,
  ],
  legs: [
    {
      role: "wormhole-core",
      abi: LogMessagePublishedEvt,
      state: "published",
      key: (a: Published, ev: LogEvent) =>
        vaaId(CHAINS[ev.chain].wormholeId, a.sender, a.sequence),
      patch: (a: Published, ev: LogEvent) => ({
        chain: ev.chain,
        emitter: a.sender.toLowerCase(),
        sequence: a.sequence.toString(),
        nonce: a.nonce,
        consistency: a.consistencyLevel,
        payload: a.payload,
        published: ev.ref,
      }),
    },
  ],
};
