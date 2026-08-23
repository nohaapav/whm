# relayer

Wormhole VAA relayer. Watches guardian-signed VAAs over a Spy stream and submits them to the
contract that consumes them, with Redis-backed retries and missed-VAA recovery from
[`@wormhole-foundation/relayer-engine`](https://github.com/wormhole-foundation/relayer-engine).

## Features

A feature runs when its signing key is present — which is how the deployment already separates them.
Supplying both keys runs both in one process, each on its own engine app and Redis namespace.

### `hydration-ntt` — enabled by `PRIVKEY`

Redeems NTT transfers **into Hydration** from Ethereum, Base, Solana, and Sui. Watches the eleven
deployed origin transceivers ([routes.ts](src/features/hydration-ntt/routes.ts)) and submits each
transfer VAA to that route's Hydration transceiver.

### `intent` — enabled by `INTENT_PRIVKEY`

Relays intents v2 **from Hydration to Ethereum**. Hydration settles WETH over NTT and publishes a
forwarding instruction beside it; this pairs the two and calls
`IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)`, which delivers the settlement,
forwards it to the order's `depositAddress`, and reimburses the caller. The fee comes from the
[quoter](../quoter/) service and is retried with backoff while it exceeds the order's `maxRelayFee`.
Uses its own **reimbursed** wallet, separate from `PRIVKEY`.

Only the settlement is subscribed to — the instruction is derived from the source transaction on
demand, so there is no pairing state to lose across restarts.

## Environment Variables

### Shared

| Variable              | Description                              | Default          |
| --------------------- | ---------------------------------------- | ---------------- |
| `SPY_ENDPOINT`        | Wormhole Spy endpoint                    | `localhost:7073` |
| `REDIS_HOST`          | Redis host                               | `localhost`      |
| `REDIS_PORT`          | Redis port                               | `6379`           |
| `WORMHOLE_API_KEY`    | Wormholescan API key (raises rate limit) | optional         |
| `GAS_WARN_MULTIPLIER` | Low-gas warning threshold (× min gas)    | `50`             |
| `DISCORD_WEBHOOK_URL` | Low-gas / out-of-gas alerts              | optional         |
| `LOG_LEVEL`           | winston level                            | `info`           |

### `hydration-ntt`

| Variable              | Description                                 | Default                               |
| --------------------- | ------------------------------------------- | ------------------------------------- |
| `PRIVKEY`             | Signing key — also what enables the feature | —                                     |
| `APP_NAME`            | Engine namespace — **see below**            | `hydration-ntt-relayer`               |
| `HYDRATION_RPC`       | Hydration EVM RPC (chain `222222`)          | `https://hydration-rpc.n.dwellir.com` |
| `NTT_ETH_FROM_SEQ`    | Cold-start floor for Ethereum VAAs          | `0`                                   |
| `NTT_BASE_FROM_SEQ`   | Cold-start floor for Base VAAs              | `0`                                   |
| `NTT_SOLANA_FROM_SEQ` | Cold-start floor for Solana VAAs            | `0`                                   |
| `NTT_SUI_FROM_SEQ`    | Cold-start floor for Sui VAAs               | `0`                                   |
| `NTT_RETRIES`         | Max attempts per VAA                        | `8`                                   |

### `intent`

| Variable                  | Description                                          | Default                               |
| ------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `INTENT_PRIVKEY`          | Reimbursed signing key — also enables the feature    | —                                     |
| `INTENT_APP_NAME`         | Engine namespace — **see below**                     | `intent-relayer`                      |
| `NTT_TRANSCEIVER`         | WormholeTransceiver (WETH) on Hydration — subscribed | Required                              |
| `INTENT_EMITTER`          | IntentEmitter on Hydration                           | Required                              |
| `INTENT_RECEIVER`         | IntentReceiver proxy on Ethereum                     | Required                              |
| `ETH_RPC`                 | Ethereum RPC                                         | `https://eth.llamarpc.com`            |
| `HYDRATION_RPC`           | Hydration RPC (reads the source tx receipt)          | `https://hydration-rpc.n.dwellir.com` |
| `QUOTER_URL`              | quoter service base URL                              | `http://localhost:8080`               |
| `INTENT_GAS_LIMIT`        | Gas limit quoted for `processOrder`                  | `500000`                              |
| `HYDRATION_FROM_SEQ`      | Cold-start floor for Hydration VAAs                  | `0`                                   |
| `INTENT_RETRIES`          | Max attempts per settlement                          | `8`                                   |
| `INTENT_RETRY_BASE_MS`    | Backoff base — `min(2^n · base, max)`                | `60000`                               |
| `INTENT_RETRY_MAX_MS`     | Backoff ceiling                                      | `4200000`                             |
| `INTENT_MAX_VAA_AGE_MS`   | Drop a settlement once its VAA is older than this    | `3600000`                             |

## Development

```bash
pnpm install
pnpm --filter @whm/relayer dev      # esbuild watch + run (reads .env)
pnpm --filter @whm/relayer redis    # local Redis
pnpm --filter @whm/relayer mainnet-spy
```

## Production

```bash
pnpm --filter @whm/relayer build    # → dist/index.js
pnpm --filter @whm/relayer start
pnpm --filter @whm/relayer docker:up
```

## Notes

### `APP_NAME` / `INTENT_APP_NAME` are load-bearing

Every Redis key the engine writes derives from the app's `name`:

```
queue          {name}:{name}-relays
seen VAAs      {name}:missedVaasV3:seenVaas:{chain}:{emitter}
failed fetch   {name}:missedVaasV3:failedToFetch:{chain}:{emitter}
safe sequence  {name}:missedVaasV3:safeSequence:{chain}:{emitter}
```

Renaming orphans that state. The missed-VAA worker then falls back to the `*_FROM_SEQ` floors and
rescans — replaying a backlog, or silently skipping everything before the floor. Do not rename to
tidy up; the defaults match what is already in Redis.

The `*_FROM_SEQ` values only matter on a cold start. Once a `safeSequence` exists the engine reads
from there, which is why they can sit at `0`.

### Retry budget vs age cap

Throwing from a handler is the engine's retry mechanism, not a crash: BullMQ fails that one job and
reschedules it with backoff. But it is bounded — after `retries` attempts the job lands in the failed
set for good. The intent feature's backoff budget (~2h) deliberately exceeds its age cap (1h), so an
unprofitable order exits via the logged "stale" path rather than accumulating in `failed`. Raising
`INTENT_MAX_VAA_AGE_MS` above the retry window would break that.

### Chain 73 and the engine's SDK

relayer-engine depends on `@certusone/wormhole-sdk`, which predates Hydration and has no chain 73.
`app.chain(73).address(…)` therefore throws `Unrecognized wormhole chainId`. The engine layer
registers handlers under the pre-encoded emitter key instead
([engine/emitter.ts](src/engine/emitter.ts)) — for an EVM chain that encoding is only the address
left-padded to 32 bytes. Everything else degrades gracefully: the TokenBridge middleware skips it, no
provider is built for it, and only a missed-VAA metrics label reads `undefined`.

One consequence: the engine prefixes `0x` onto a `sourceTxHash` only for chains its SDK recognises as
EVM, so chain-73 hashes arrive bare and are normalised in [engine/vaa.ts](src/engine/vaa.ts).

### Why dependencies are not bundled

`@certusone/wormhole-sdk` pulls the Injective/Cosmos SDKs, which have circular CJS requires and
re-exported TS enums esbuild cannot flatten — the bundle builds and then dies at load with
`Cannot read properties of undefined (reading 'Mainnet')`. So `packages: "external"`, and the
Dockerfile installs them.

Related: those same packages ship a broken range. `@injectivelabs/networks` asks for
`ts-types@^1.10.12` and resolvers pick `1.20.12`, which dropped the enum it needs — so
relayer-engine cannot load at all. `ts-types` is pinned to `1.10.12` in both
[pnpm-workspace.yaml](../../pnpm-workspace.yaml) (pnpm, local) and this package's `overrides` (npm,
Docker). Both are needed; keep them in step.
