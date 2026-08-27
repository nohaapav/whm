import type { Flow, LogEvent } from "../../types";

import { OrderPlacedEvt, OrderProcessedEvt, QuotePublishedEvt, RelayFeePaidEvt } from "./abi";

interface Placed {
  transferSequence: bigint;
  depositAddress: `0x${string}`;
  caller: `0x${string}`;
  assetIn: number;
  amountIn: bigint;
  ethOut: bigint;
  maxRelayFee: bigint;
}

interface Processed {
  transferSequence: bigint;
  depositAddress: `0x${string}`;
  amount: bigint;
}

interface FeePaid {
  transferSequence: bigint;
  relayer: `0x${string}`;
  fee: bigint;
}

interface QuoteTerms {
  authPath: `0x${string}`;
  publisher: `0x${string}`;
  quoteId: `0x${string}`;
  recipient: string;
  messageSequence: bigint;
}

const sequence = (a: { transferSequence: bigint }) => a.transferSequence.toString();

/**
 * An order, from the Hydration side that places it to the Ethereum side that forwards it.
 *
 * Both legs name the NTT manager's sequence, which is the same key the receiver pairs the
 * settlement and its instruction on — so the indexer correlates on exactly what the contract does.
 *
 * `processed` is the end of what this repo can see. What happens after the handoff is off-chain on
 * NEAR, and only 1Click can say; the settlement poller is what carries the row past it.
 */
export const orders: Flow = {
  name: "orders",
  table: "intent_orders",
  key: { column: "transfer_sequence", type: "BIGINT" },
  states: { placed: 0, processed: 1, settled: 2, refunded: 2, failed: 2 },
  requires: { processed: "placed" },
  columns: {
    caller: "TEXT",
    deposit_address: "TEXT",
    asset_in: "BIGINT",
    amount_in: "NUMERIC",
    eth_out: "NUMERIC",
    max_relay_fee: "NUMERIC",
    forwarded_amount: "NUMERIC",
    relay_fee: "NUMERIC",
    relayer: "TEXT",
    /** Raw 1Click status, kept verbatim so an unmapped one is still visible. */
    settlement_status: "TEXT",
    /** Where the user's asset actually lands. Not the Ethereum deposit address. */
    dest_address: "TEXT",
    dest_asset: "TEXT",
    dest_amount: "NUMERIC",
    dest_tx: "TEXT",
    dest_tx_url: "TEXT",
    placed: "JSONB",
    processed: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_intent_orders_caller ON intent_orders (caller);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_orders_deposit ON intent_orders (deposit_address);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_orders_dest ON intent_orders (dest_address);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_orders_placed ON intent_orders (((placed->>'blockTimestamp')::numeric) DESC);`,
  ],
  legs: [
    {
      role: "intent-emitter",
      abi: OrderPlacedEvt,
      state: "placed",
      key: sequence,
      patch: (a: Placed, ev: LogEvent) => ({
        caller: a.caller.toLowerCase(),
        deposit_address: a.depositAddress.toLowerCase(),
        asset_in: Number(a.assetIn),
        amount_in: a.amountIn.toString(),
        eth_out: a.ethOut.toString(),
        max_relay_fee: a.maxRelayFee.toString(),
        placed: ev.ref,
      }),
    },
    {
      role: "intent-receiver",
      abi: OrderProcessedEvt,
      state: "processed",
      key: sequence,
      patch: (a: Processed, ev: LogEvent) => ({
        deposit_address: a.depositAddress.toLowerCase(),
        forwarded_amount: a.amount.toString(),
        processed: ev.ref,
      }),
    },
    {
      // Same transaction as the forward, so the state it claims is the same one — it carries the
      // fee, it does not move the order along.
      role: "intent-receiver",
      abi: RelayFeePaidEvt,
      state: "processed",
      key: sequence,
      patch: (a: FeePaid) => ({
        relay_fee: a.fee.toString(),
        relayer: a.relayer.toLowerCase(),
      }),
    },
  ],
};

/**
 * Standing authorizations: the terms a NEAR account is derived from, published once per route
 * rather than once per order.
 *
 * Its own table because it is its own key space — an order names a settlement sequence, a quote
 * names the hash of its terms — but the same domain, because an order placed against a derived
 * account only means anything beside the quote it derives from.
 */
export const quotes: Flow = {
  name: "quotes",
  table: "intent_quotes",
  key: { column: "auth_path", type: "TEXT" },
  states: { published: 0 },
  columns: {
    publisher: "TEXT",
    quote_id: "TEXT",
    recipient: "TEXT",
    message_sequence: "BIGINT",
    published: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_intent_quotes_quote_id ON intent_quotes (quote_id);`,
    `CREATE INDEX IF NOT EXISTS idx_intent_quotes_recipient ON intent_quotes (recipient);`,
  ],
  legs: [
    {
      role: "intent-quote",
      abi: QuotePublishedEvt,
      state: "published",
      key: (a: QuoteTerms) => a.authPath.toLowerCase(),
      patch: (a: QuoteTerms, ev: LogEvent) => ({
        publisher: a.publisher.toLowerCase(),
        quote_id: a.quoteId.toLowerCase(),
        recipient: a.recipient,
        message_sequence: a.messageSequence.toString(),
        published: ev.ref,
      }),
    },
  ],
};
