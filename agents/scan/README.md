# @whm/scan

Indexes the chains this repo's contracts run on, and serves what it finds.

One image, several entry points. **Ingest** is the only writer: it reads every watched contract into
a shared event store, then folds that store into the two tables no feature owns — the Wormhole
messages our emitters publish, and the NTT transfers riding them. Every other container reads what
ingest wrote, owns its own tables, and serves its own pages.

```
ingest      chains → events → wh_messages + ntt_transfers      (no UI)
intents     intent_orders + intent_quotes + 1Click             :8080
basejump    transfers                                          :8081
```

Chains are indexed **in parallel and at wildly different speeds**, so events arrive in no
particular order. Every flow is built to come out ordered anyway: state advances by rank and never
regresses, and every other column merges rather than overwrites.

## Layout

```
src/
  chains.ts        chain registry — ids, Wormhole ids, tuning
  watch.ts         WHAT to index: contracts, roles, start blocks
  db.ts            the shared event store
  watchers/        evm.ts (getLogs), substrate.ts (EVM.Log out of System.Events)
  flow/            the reconciler: types, DDL generation, upsert, drain, serve
  ingest/          the writer, plus the wh_messages and ntt_transfers flows
  apps/<domain>/   one per container: flows, api, workers, entry point
public/
  shared/          styling every domain's pages use
  <domain>/        that domain's pages
```

## Configuration

Endpoints and secrets are env. **Everything else is code** — chain ids, contract addresses and
start blocks live in [src/chains.ts](src/chains.ts) and [src/watch.ts](src/watch.ts), so a
deployment cannot silently point at the wrong contract.

| Variable            | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `RPC_ETHEREUM_WSS`  | Websocket. Heads arrive over `eth_subscribe`, never by polling. |
| `RPC_HYDRATION_WSS` | Must be the substrate path, not the EVM one — see below.        |
| `DATABASE_URL`      | Postgres.                                                       |
| `ONECLICK_JWT`      | The intents domain's off-chain leg.                             |
| `PORT`              | Defaults to 8080.                                               |

A chain is enabled by the presence of its RPC and disabled by its absence; watch entries on a chain
with no endpoint are skipped.

Hydration must be read over substrate: the Basejump landing's deliveries are XCM-driven
`pallet_evm` calls with no ethereum receipt, so `eth_getLogs` cannot see them at all. Only Frontier
`EVM.Log` events expose them.

That has a consequence worth knowing. An `EVM.Log` never names its own transaction, so the hash
comes from the `Ethereum.Executed` that Frontier emits *after* the logs of each ethereum call — the
watcher buffers logs and assigns the hash when it arrives. The XCM-driven deliveries have no such
event, and keep a `blockHash-eventIndex` identity instead, which is the only name they have. The UI
links the first kind to `/extrinsic/<hash>` and the second to `/event/<block>-<index>`.

## Adding something to index

Append a watch entry:

```ts
{ chain: "ethereum", role: "basejump-source", from: 25_828_484n, at: [ADDRESS] }
```

A watch entry is the unit of both ingestion and backfill — it keeps its own cursor, so a new entry
backfills from its own `from` while everything already indexed stays at the tip. A flow then names
the `role`, never an address, which is what lets a redeployment or a second deployment of the same
role be a one-line change.

Adding an **event** to something already watched needs no re-scan: the raw log is already stored,
so a new leg picks it up on the next drain.

## Adding a flow

A flow is a table, the events that fill it, and how a row advances:

```ts
export const orders: Flow = {
  name: "orders",
  table: "intent_orders",
  key: { column: "transfer_sequence", type: "BIGINT" },
  states: { placed: 0, processed: 1, settled: 2, refunded: 2, failed: 2 },
  requires: { processed: "placed" },
  columns: { caller: "TEXT", amount_in: "NUMERIC", placed: "JSONB", processed: "JSONB" },
  legs: [{ role: "intent-emitter", abi: OrderPlacedEvt, state: "placed", key, patch }],
};
```

**Legs sharing a key are the same record.** That is the whole of what "belongs together" means
here. The table, its indexes and its state-rank function are generated from the definition.

- `states` maps a state to its rank. Equal ranks are alternatives rather than a sequence — Basejump
  either clears the landing pool or waits on a shortfall, so `completed` and `queued` share a rank.
- `requires` maps a leg to the leg it presupposes. A row carrying a delivery whose origin was never
  indexed is an orphan and is hidden rather than shown half-built.
- `key` may be async and is handed the drain's transaction, for the events that do not name their
  own record. Basejump's landing events carry no sequence, so they are matched against what is
  already stored.
- `keyBy` lets a leg address the row through a unique column instead of the primary key.

## Running it

```sh
pnpm dev:db                 # postgres on :5432
pnpm build
pnpm dev ingest             # or: intents, basejump
```

`pnpm dev <domain>` rebuilds and runs one container's worth — they are separate processes, so run
ingest alongside whichever domain you are working on.

## Notes on the NTT rail

`ntt_transfers` is keyed on the digest NTT settles delivery on, because it is the one name every
delivery event carries. Nothing on-chain publishes that digest beside its VAA — the transceiver's
`ReceivedMessage` carries the VAA *hash*, which is a different value — so it is derived from the
published payload exactly as NTT computes it,
`keccak256(sourceChainId ++ encodedNttManagerMessage)`.

The two terminal states are exclusive at first delivery. A rate-limited transfer emits
`InboundTransferQueued` and returns before anything is credited, so `TransferRedeemed` is the
release and nothing else is; `completeInboundQueuedTransfer` emits it later, which is why
`redeemed` outranks `queued`.

One consequence worth knowing: `ReceivedMessage` addresses its row by VAA id, so on a cold backfill
where a destination chain runs ahead of its source it can find nothing to update. It carries only a
hash and a timestamp, and live operation publishes ~15 minutes before it delivers, so this is a
cold-start artifact rather than a running concern.
