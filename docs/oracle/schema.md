# Oracle Relay Schema

Cross-chain data flow per source, contract / program structure per side, shared encoding pipeline, and agent topology.

## Cross-chain data flow

### Solana source

```
═══════════════════════════════════════════════════════════════════════════════════
                       SOLANA SOURCE — DATA FLOW
═══════════════════════════════════════════════════════════════════════════════════


   SOLANA                       WORMHOLE                     HYDRATION (EVM)
  ─────────                     ─────────                   ────────────────

┌──────────────────┐
│  Kamino Scope    │
│  Oracle          │
│  (price feeds)   │
└────────┬─────────┘
         │ read price
         ▼
┌───────────────────┐       ┌───────────────┐
│ oracle-emitter    │       │               │
│ (Anchor program)  │──────►│   Wormhole    │
│                   │  VAA  │   Guardians   │
│ - send_price()    │       │   Network     │
│ - send_rate()     │       │               │
│                   │       └───────┬───────┘
│ ABI-encodes:      │               │
│  action + assetId │               │ signed VAA
│  + value + ts     │               │ (chainId = 1)
└───────────────────┘               │
                                    └──────────────────────┐
                                                           ▼
                                                 ┌───────────────────────┐
                                                 │  MessageReceiver      │
                                                 │  (UUPS Proxy)         │
                                                 │                       │
                                                 │  - VAA validation     │
                                                 │  - replay protection  │
                                                 │  - emitter auth       │
                                                 └───────────┬───────────┘
                                                             │ inherits
                                                             ▼
                                                 ┌───────────────────────┐
                                                 │  OracleReceiver       │
                                                 │  (UUPS Proxy)         │
                                                 │                       │
                                                 │  Routes by action:    │
                                                 │  ┌──────────────────┐ │
                                                 │  │ ACTION_PRICE (1) │ │
                                                 │  │ ACTION_RATE  (2) │ │
                                                 │  └────────┬─────────┘ │
                                                 │  - stale checks       │
                                                 │  - value ÷ 1e10       │
                                                 │  - assetId → oracle   │
                                                 └───────────┼───────────┘
                                                             │ same-chain call
                                                             ▼
                                                 ┌───────────────────────┐
                                                 │  ManagedOracle        │
                                                 │  setPrice(int256)     │
                                                 │  (authorizes this     │
                                                 │   receiver's address) │
                                                 └───────────────────────┘
```

### Ethereum source

```
═══════════════════════════════════════════════════════════════════════════════════
                       ETHEREUM SOURCE — DATA FLOW
═══════════════════════════════════════════════════════════════════════════════════


   ETHEREUM                       WORMHOLE                    HYDRATION (EVM)
  ──────────                     ─────────                   ────────────────

┌──────────────────┐
│  wstETH          │
│  0x7f39…2Ca0     │
│  stEthPerToken() │
└────────┬─────────┘
         │ staticcall
         │ (uint256 18-dec)
         ▼
┌───────────────────┐       ┌───────────────┐
│  OracleEmitter    │       │               │
│  (UUPS Proxy)     │──────►│   Wormhole    │
│                   │  VAA  │   Guardians   │
│ - send(assetId)   │       │   Network     │
│ - feeds[assetId]  │       │               │
│ - registerFeed()  │       └───────┬───────┘
│                   │               │
│ ABI-encodes:      │               │ signed VAA
│  action + assetId │               │ (chainId = 2)
│  + rate + ts      │               │
└───────────────────┘               │
         ▲                          │
         │ staticcall               └──────────────────────┐
         │ (uint256 18-dec)                                ▼
┌────────┴─────────┐                              ┌───────────────────────┐
│  apyUSD          │                              │  MessageReceiver      │
│  0x38ee…8a6a     │                              │  (UUPS Proxy, fresh   │
│  convertToAssets │                              │   per-source instance)│
│  (1e18)          │                              │                       │
└──────────────────┘                              │  - VAA validation     │
                                                  │  - replay protection  │
                                                  │  - emitter auth       │
                                                  │    (chainId=2 → addr) │
                                                  └───────────┬───────────┘
                                                              │ inherits
                                                              ▼
                                                  ┌───────────────────────┐
                                                  │  OracleReceiver       │
                                                  │  (UUPS Proxy, fresh   │
                                                  │   per-source instance)│
                                                  │                       │
                                                  │  ACTION_RATE (2) only │
                                                  │  - stale checks       │
                                                  │  - value ÷ 1e10       │
                                                  │  - assetId → oracle   │
                                                  └───────────┼───────────┘
                                                              │ same-chain call
                                                              ▼
                                                  ┌───────────────────────┐
                                                  │  ManagedOracle        │
                                                  │  setPrice(int256)     │
                                                  └───────────────────────┘
```

Both sources deploy the **same Solidity**, but each gets its own `OracleReceiver` instance — its own
authorized emitter and its own `assetId → oracle` map. Ownership is renounced per instance, so the
two are isolated: an oracle serving both sources authorizes both receiver addresses.

## EVM contract hierarchy (shared between sources)

```
┌─────────────────────────────────────────────────────────────┐
│                    MessageReceiver                          │
│                  (UUPSUpgradeable)                          │
│                                                             │
│  Responsibilities:                                          │
│  - Parse + verify VAA via Wormhole core                     │
│  - Validate emitter chain & address (per-source whitelist)  │
│  - Prevent VAA replay (hash tracking)                       │
├─────────────────────────────────────────────────────────────┤
│                          │ extends                          │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │  OracleReceiver       │                      │
│              │                       │                      │
│              │  - Decode ABI payload │                      │
│              │  - Route by action ID │                      │
│              │  - Monotonic stale    │                      │
│              │    check per asset    │                      │
│              │  - maxPriceAge bound  │                      │
│              │  - 1e10 scaling       │                      │
│              │  - Map assetId→oracle │                      │
│              └───────────┬───────────┘                      │
│                          │ calls (same chain)               │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │  ManagedOracle        │                      │
│              │  (Hydration-side,     │                      │
│              │   not in this repo)   │                      │
│              │  setPrice(int256)     │                      │
│              └───────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

Delivery is one transaction on one chain: the same call that verifies the VAA writes the price. A
failed write reverts the verification with it, so the VAA stays unconsumed and the relay can retry.

## Source emitter structure

### Solana — `oracle-emitter` (Anchor)

```
┌────────────────────────────────────────────────────────────────┐
│              oracle-emitter (Anchor program)                   │
│                                                                │
│  Instructions:                                                 │
│  ┌───────────────┐  ┌─────────────────────┐  ┌───────────┐     │
│  │  initialize   │  │ register_price_feed │  │   send    │     │
│  │               │  │ register_pool_feed  │  │           │     │
│  │ Config acct   │  │                     │  │ price /   │     │
│  │ (owner)       │  │ PDA: [<kind>,       │  │ rate      │     │
│  │               │  │       asset_id]     │  │           │     │
│  └───────────────┘  └─────────────────────┘  └─────┬─────┘     │
│                                                    │           │
│  State:                    Oracle:                 │           │
│  ┌───────────┐  ┌────────────────────────┐         │           │
│  │  Config   │  │  Kamino Scope          │◄────────┘           │
│  │  - owner  │  │  - DatedPrice          │  read price/rate    │
│  ├───────────┤  │  - normalize to 18 dec │                     │
│  │ PriceFeed │  └────────────────────────┘                     │
│  │ - assetId │                                                 │
│  │ - index   │  ┌────────────────────────┐                     │
│  ├───────────┤  │  SPL Stake Pool        │                     │
│  │ PoolFeed  │  │  - total_lamports      │                     │
│  │ - assetId │  │  - pool_token_supply   │                     │
│  │ - pool    │  └────────────────────────┘                     │
│  └───────────┘                                                 │
│                                                                │
│  Helpers (helpers.rs):                                         │
│  - abi_encode_price_payload()  EVM-compatible ABI encoding     │
│                                                                │
│  Wormhole CPI:                                                 │
│  - wormhole-post-message-shim → wormhole.post_message()        │
└────────────────────────────────────────────────────────────────┘
```

### Ethereum — `OracleEmitter` (Solidity UUPS)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OracleEmitter (UUPSUpgradeable)                       │
│                                                                             │
│  Storage:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  wormhole          IWormhole       — Wormhole core bridge           │    │
│  │  nonce             uint32          — global publish nonce           │    │
│  │  owner             address         — admin                          │    │
│  │  feeds             mapping(bytes32 ⇒ Feed)                          │    │
│  │                                                                     │    │
│  │  struct Feed {                                                      │    │
│  │    address source;       // wstETH token, apyUSD vault, …           │    │
│  │    bytes   call;         // full calldata for staticcall            │    │
│  │  }                                                                  │    │
│  │                                                                     │    │
│  │  // action is hard-coded to 2 (RATE) in send(); sources must        │    │
│  │  // return 18-decimal uint256 natively (no normalisation).          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Functions:                                                                 │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     │
│  │  initialize        │  │  registerFeed      │  │  send              │     │
│  │  (Wormhole core)   │  │  (admin)           │  │  (permissionless,  │     │
│  │                    │  │                    │  │   payable)         │     │
│  └────────────────────┘  └────────────────────┘  └─────────┬──────────┘     │
│                                                            │                │
│                          ┌─────────────────────────────────┘                │
│                          ▼                                                  │
│             ┌────────────────────────────┐                                  │
│             │  _readSource(feed)         │                                  │
│             │  staticcall + decode       │                                  │
│             │  uint256 (18-dec native)   │                                  │
│             └─────────────┬──────────────┘                                  │
│                           │                                                 │
│                           ▼                                                 │
│             ┌────────────────────────────┐                                  │
│             │  abi.encode(               │                                  │
│             │    ACTION_RATE_UPDATE = 2, │                                  │
│             │    assetId, rate, ts)      │                                  │
│             └─────────────┬──────────────┘                                  │
│                           │                                                 │
│                           ▼                                                 │
│             ┌────────────────────────────┐                                  │
│             │  wormhole.publishMessage   │                                  │
│             │  (nonce, payload, 200)     │                                  │
│             └────────────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Encoding pipeline (shared)

Both sources produce a 128-byte payload with the same layout; the receiver decodes it identically.

```
  Source (Solana or Ethereum)              Hydration EVM

  ┌─────────────┐    Wormhole     ┌────────────────────┐
  │ ABI encode: │    VAA          │ ABI decode:        │
  │             │ ──────────────► │                    │
  │ action      │                 │ action  (byte 31)  │
  │ assetId(b32)│                 │ assetId            │
  │ value(u256) │                 │ value ÷ 1e10       │
  │  18-dec     │                 │   → 8-dec          │
  │ timestamp   │                 │ vm.timestamp used  │
  └─────────────┘                 │   for stale checks │
                                  │         │          │
                                  │         ▼          │
                                  │ oracle.setPrice()  │
                                  └────────────────────┘
```

The payload `timestamp` is informational. Both stale checks use `vm.timestamp`, the VAA's guardian
observation time: monotonic per asset, plus an absolute `maxPriceAge` bound (default 300s).

## Feed registration formats

```
oracle-emitter (Solana)
───────────────────────

  register_price_feed(asset_id, oracle_index)
      assetId    = bytes32 (canonical mint pubkey)
      pool_index = u16     (Kamino Scope oracle index)
      → PDA [price_feed, asset_id]

  register_pool_feed(asset_id, stake_pool)
      assetId    = bytes32
      stake_pool = Pubkey  (SPL Stake Pool address, validated on send)
      → PDA [stake_pool_feed, asset_id]


OracleEmitter (Ethereum)
────────────────────────

  registerFeed(assetId, source, call)
      Action is hard-coded to ACTION_RATE_UPDATE (2) in send().
      Source must return uint256 at 18 decimals natively.

  wstETH (rate)
    assetId = keccak256("WSTETH")
    source  = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0
    call    = abi.encodeWithSelector(0x035faf82)            // stEthPerToken()

  apyUSD (rate)
    assetId = keccak256("APYUSD")
    source  = 0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A
    call    = abi.encodeCall(IERC4626.convertToAssets, (1e18))
```

## Agents (off-chain)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          broadcaster                                        │
│                                                                             │
│  Periodically triggers source-side publish; planned chain-adapter           │
│  interface so the same loop drives both sources.                            │
│                                                                             │
│  ┌─────────┐                       ┌──────────────────┐                     │
│  │  Timer  │──┬──── solana ───────►│ oracle-emitter   │──► Wormhole         │
│  └─────────┘  │     adapter        │ (Anchor program) │                     │
│               │                    └──────────────────┘                     │
│               │                                                             │
│               └──── ethereum ─────►┌──────────────────┐                     │
│                     adapter        │ OracleEmitter    │──► Wormhole         │
│                     (planned)      │ (Solidity UUPS)  │                     │
│                                    └──────────────────┘                     │
│                                                                             │
│  Both adapters share:                                                       │
│   - thresholds.json (per-assetId change threshold)                          │
│   - full-refresh interval                                                   │
│   - change-detect → send                                                    │
│   - state.json (last value, sentAt)                                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                                relayer                                      │
│                                                                             │
│  Submitting the signed VAA is permissionless. Needs an `oracle` feature     │
│  in agents/relayer: subscribe to the source emitters, submit to the         │
│  matching per-source receiver.                                              │
│                                                                             │
│  ┌──────────┐  signed VAA        ┌──────────────────┐                       │
│  │ Wormhole │───────────────────►│   relayer        │──┐                    │
│  └──────────┘                    │ (oracle feature) │  │                    │
│                                  └──────────────────┘  │                    │
│                                                        ▼                    │
│                                    ┌──────────────────────────────────────┐ │
│                                    │  OracleReceiver.receiveMessage       │ │
│                                    │  (per-source instance on Hydration)  │ │
│                                    └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```
