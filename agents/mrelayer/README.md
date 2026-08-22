# mrelayer

Wormhole VAA relayer for cross-chain token transfers.

## Relayers

### Hydration NTT Relayer (`start:hydration`)

Redeems Wormhole NTT transfers **to Hydration** from Ethereum, Base, Solana, and Sui. It watches
the eleven deployed origin transceivers and submits each transfer VAA to its corresponding
Hydration transceiver.

### Intent Relayer (`start:intent`)

Relays the intents v2 path **from Hydration to Ethereum**. Hydration settles WETH over NTT and
publishes a forwarding instruction beside it; this relayer pairs the two and calls
`IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)`, which delivers the settlement,
forwards it to the instruction's `depositAddress`, and reimburses the caller. `feeRequested` is
priced by the [quoter](../quoter/) service and retried with backoff while it exceeds the order's
`maxRelayFee`. Uses its own **reimbursed** wallet (`INTENT_PRIVKEY`), separate from the generic
relayers.

Only the settlement is subscribed to — the instruction is derived from the source transaction on
demand, so there is no pairing state to lose across restarts.

## Environment Variables

### Common (all relayers)

| Variable              | Description                                                        | Default          |
| --------------------- | ------------------------------------------------------------------ | ---------------- |
| `PRIVKEY`             | Signing key (the **intent** relayer uses `INTENT_PRIVKEY` instead) | Required         |
| `REDIS_HOST`          | Redis host                                                         | `localhost`      |
| `REDIS_PORT`          | Redis port                                                         | `6379`           |
| `SPY_ENDPOINT`        | Wormhole Spy endpoint                                              | `localhost:7073` |
| `WORMHOLE_API_KEY`    | Wormholescan API key (raises rate limit)                           | optional         |
| `GAS_WARN_MULTIPLIER` | Low-gas warning threshold (× min gas)                              | `50`             |
| `DISCORD_WEBHOOK_URL` | Low-gas / out-of-gas alerts                                        | optional         |

### Hydration NTT relayer — `start:hydration` (NTT origins → Hydration)

| Variable              | Description                                 | Default                               |
| --------------------- | ------------------------------------------- | ------------------------------------- |
| `HYDRATION_RPC`       | Hydration EVM RPC endpoint (chain `222222`) | `https://hydration-rpc.n.dwellir.com` |
| `NTT_ETH_FROM_SEQ`    | Start sequence for Ethereum NTT VAAs        | `0`                                   |
| `NTT_BASE_FROM_SEQ`   | Start sequence for Base NTT VAAs            | `0`                                   |
| `NTT_SOLANA_FROM_SEQ` | Start sequence for Solana NTT VAAs          | `0`                                   |
| `NTT_SUI_FROM_SEQ`    | Start sequence for Sui NTT VAAs             | `0`                                   |

### Intent relayer — `start:intent` (Hydration → Ethereum, reimbursed)

| Variable                   | Description                                          | Default                               |
| -------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `INTENT_PRIVKEY`           | Reimbursed signing wallet (separate from `PRIVKEY`)  | Required                              |
| `NTT_TRANSCEIVER`          | WormholeTransceiver (WETH) on Hydration — subscribed | Required                              |
| `INTENT_EMITTER`           | IntentEmitter on Hydration — publishes instructions  | Required                              |
| `INTENT_RECEIVER`          | IntentReceiver proxy on Ethereum                     | Required                              |
| `QUOTER_URL`               | quoter service base URL                              | `http://localhost:8080`               |
| `ETH_RPC`                  | Ethereum RPC endpoint                                | `https://eth.llamarpc.com`            |
| `HYDRATION_RPC`            | Hydration EVM RPC (reads the source tx receipt)      | `https://hydration-rpc.n.dwellir.com` |
| `HYDRATION_FROM_SEQ`       | Start sequence for Hydration VAAs                    | `0`                                   |
| `INTENT_GAS_LIMIT`         | Gas limit quoted for `processOrder`                   | `500000`                              |
| `INTENT_RETRIES`           | Max attempts per settlement                          | `8`                                   |
| `INTENT_RETRY_BASE_MS`     | Backoff base — `min(2^n · base, max)`                | `60000`                               |
| `INTENT_RETRY_MAX_MS`      | Backoff ceiling                                      | `4200000`                             |
| `INTENT_MAX_VAA_AGE_MS`    | Drop a settlement once its VAA is older than this    | `3600000`                             |

## Development

```bash
# Install dependencies
npm install

# Run Hydration NTT relayer (dev)
npm run dev:hydration

# Run intent relayer (dev)
npm run dev:intent

# Start Redis locally
npm run redis

# Start Wormhole Spy (mainnet)
npm run mainnet-spy
```

## Production

```bash
# Build
npm run build

# Run Hydration NTT relayer
npm run start:hydration

# Run intent relayer
npm run start:intent
```

## Docker

```bash
# Build image
docker build -t mrelayer .

# Run Hydration NTT relayer (default)
docker run -e PRIVKEY=<key> -e HYDRATION_RPC=<rpc> mrelayer

# Run intent relayer
docker run -e INTENT_PRIVKEY=<key> -e NTT_TRANSCEIVER=<addr> -e INTENT_EMITTER=<addr> \
  -e INTENT_RECEIVER=<addr> mrelayer start:intent
```

## Docker Stack

```bash
docker stack deploy -c stack.yml mrelayer
```

`stack.yml` runs both relayers plus Redis and a mainnet Spy. Fill the `FILL THIS …` placeholders
before deploying.

## Notes

### Chain 73 and the engine's SDK

`@wormhole-foundation/relayer-engine` depends on `@certusone/wormhole-sdk`, which predates Hydration
and does not know chain 73. `app.chain(73).address(…)` therefore throws `Unrecognized wormhole
chainId 73` from the engine's `encodeEmitterAddress`. The intent relayer registers its handler under
the pre-encoded emitter key instead (see `onEmitter` in `src/app-intent.ts`) — for an EVM chain that
encoding is just the address left-padded to 32 bytes. Everything else in the engine degrades
gracefully on an unrecognised chain id: the TokenBridge middleware skips, providers are never built
for it, and only a missed-VAA metrics label reads `undefined`.

One consequence worth knowing: the engine only prefixes `0x` onto a `sourceTxHash` for chains its SDK
recognises as EVM, so chain-73 hashes arrive bare and the handler prefixes them itself.
