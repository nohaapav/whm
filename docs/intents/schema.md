# SCHEMA — Intents

Companion to [spec.md](spec.md). Concrete wire formats, interfaces, and state layout.

Anything marked **⚠ UNVERIFIED** must be pinned against the live contract or API
before implementation. See [spec.md §7](spec.md#7-verification-status).

---

## Message topology

Three messages, three readers, no shared state. Every arrow is guardian-signed and independently
verifiable; nothing is passed as a caller argument.

```
                      HYDRATION                          ETHEREUM              NEAR
                      ─────────                          ────────              ────

  publishQuote(Quote)
    │
    ├─► [A] quote VAA ──────────────────────────────────────────────────────► IntentRouter
    │        emitter: IntentQuoteEmitter                                        reads `recipient`
    │        payload: packed terms (§2)                                         re-derives A from
    │        path:    keccak256(payload)                                        keccak256(payload)
    │        once per route, replayed every fill
    │
  placeOrder(…, depositAddress, maxRelayFee)          ┌── IntentReceiver
    │                                                 │     .processOrder(B, C, fee)
    ├─► [B] NTT settlement ───────────────────────────┤       pair B↔C on the NTT
    │        emitter: WormholeTransceiver             │       manager sequence
    │        payload: NTT transfer (no room for us)   │            │
    │        carries: the value                       │            ▼
    │                                                 │     forward to depositAddress
    └─► [C] forwarding instruction ───────────────────┘            │
             emitter: IntentEmitter                                │  POA watcher
             payload: abi.encode(seq, depositAddress,              │  (not our tx)
                                 amount, maxRelayFee)              ▼
             carries: where the value goes                    account A credited
                                                              nep141:eth.omft.near
```

**[B] and [C] leave the same transaction** and are joined by the NTT manager's sequence. **[A] is
independent** — published once per route, and only the MPC variant has one at all. The 1Click variant
uses [B] + [C] and stops at the deposit address.

**[A] and [C] have different emitter addresses**, because `IntentQuoteEmitter` is a separate
deployment from `IntentEmitter`. `IntentReceiver` pins the emitter it accepts instructions from, so a
quote VAA reaches `UnauthorizedEmitter` before anything decodes it — the two message types cannot be
confused for one another regardless of what their bytes happen to look like.

## Four sequence counters, easily confused

```
  NttManager._useMessageSequence()   ← what transfer() returns, and what [C] names.
                                       NOT a Wormhole sequence.
  transceiver's Wormhole sequence    ← addresses [B].  Published with nonce 0,
                                       return value discarded on-chain.
  IntentEmitter's Wormhole sequence  ← addresses [C].
  IntentQuoteEmitter's sequence      ← addresses [A]. Separate contract,
                                       separate emitter, separate counter.
```

All four increment independently. `processOrder` re-derives the manager sequence from [B]'s payload
and requires it to equal the one [C] names — that check is what stops a caller pairing any pending
settlement with whichever instruction carries the richest ceiling.

## Derivation chain (MPC variant)

```
   Quote terms                encodeQuote (§2)
   ┌──────────────────┐       packed bytes
   │ version          │            │
   │ quoteId          │            ▼
   │ maxSlippageBps   │─────► keccak256 ─────► path (bytes32)
   │ recipientKind    │                          │
   │ destinationAsset │                          │  v1.signer.derived_public_key
   │ recipient        │                          │  { predecessor: router, path,
   └──────────────────┘                          │    domain_id: 1 }
        every field                              ▼
        inside the hash                     ed25519 pubkey
                                                 │  hex of the 32 bytes
                                                 ▼
                                            A  (NEAR implicit account)
                                                 │  POA deposit_address
                                                 │  { account_id: A, chain: "eth:1" }
                                                 ▼
                                            0xN  (Ethereum address — this is what
                                                  placeOrder is given)
```

Change any field and you get a different path, a different `A`, and a different `0xN`. That is the
whole security argument: an authorization can only ever reach the account its own terms imply.

---

## 1. Constants and account derivation

```
Hydration Wormhole chain id  73                            ✔ xc-cfg
Hydration core bridge        0x3792a6d63c31941B2805181771795D9176fA82A1   ✔ xc-cfg
Ethereum Wormhole chain id   2
IntentEmitter (Hydration)    <to deploy>                   ← router pins this
IntentRouter (NEAR)          intents-router.<parent>.near  ← MPC derivation path root

Wormhole core (NEAR)         contract.wormhole.near        ⚠ confirm
MPC signer (NEAR)            v1.signer                    ✔ live, code_hash EM7QrQMd…
Verifier                     intents.near
POA bridge RPC               https://bridge.chaindefuser.com/rpc
Solver relay RPC             https://solver-relay-v2.chaindefuser.com/rpc

ETH  (intents token id)      nep141:eth.omft.near
POA min deposit (eth:1)      100000000000            (1e11 wei)
MPC domain_id                1                       (Ed25519; 0 = Secp256k1)
Quote window                 min_deadline_ms = 120000
```

### Account derivation — `(router, path) → A → 0xN`

Two calls. The router account appears only in the first; POA never sees it.

```
MPC   derived_public_key({ predecessor: "intents-router.hydration.near",
                           path: "dca-1", domain_id: 1 })   ← router goes HERE
        → ed25519:2kbv31BMDHBK54RYMX1gKiSLCXMjWphF9sbxvH4o4D3S
        → A = 1a0723b8ff06ee3a7db5d855150156a7dfdbedeabb6b386d3c57c93c665829f5

POA   deposit_address({ account_id: A, chain: "eth:1" })     ← only A, never the router
        → 0x43F3DB4993C0452109ccd8D346AE276627A1D2b7
```

Both steps are deterministic — the worked values above are live results and
reproduce exactly.

### The path is the hash of the terms

`"dca-1"` above is a label, chosen to show the mechanics with a readable value. In production the
path is **`keccak256(encodeQuote(order))`** — the hash of the exact bytes published, available
on-chain as `IntentEmitter.computeAuthPath(order)` and mirrored by
[`IntentCodec.authPath`](../../contracts/src/intents/IntentCodec.sol).

This is load-bearing, not cosmetic. Publishing is permissionless, so with a label — or with
`quoteId` — as the path, anyone could publish _their own_ order at the same path carrying _their own_
`recipient`. Both orders would derive the same account `A`, and the router honouring either would pay
the attacker out of a balance the victim funded. Deriving from the terms makes that impossible:
change any field and you get a different path, a different `A`, and a different deposit address, so
an authorization can only ever reach the account its own recipient implies.

Consequences worth stating plainly:

- **`recipient` is inside the path.** Two destinations from one source are two accounts; they cannot
  be merged by accident.
- **`quoteId` is only a namespace.** It lets two schedules that agree on every other term stay on
  disjoint accounts. The router never interprets it.
- **Republishing is harmless.** The same terms hash to the same path, so a duplicate publish is a
  no-op rather than a second authorization.
- **`version` is inside the hash**, so a future layout derives a disjoint account set rather than
  colliding with this one.

**Step 1 — derived public key** (NEAR view call, unauthenticated):

```json
POST https://free.rpc.fastnear.com
{ "jsonrpc": "2.0", "id": 1, "method": "query", "params": {
    "request_type": "call_function", "finality": "final",
    "account_id": "v1.signer", "method_name": "derived_public_key",
    "args_base64": "<base64 of {\"path\":\"dca-1\",
                                 \"predecessor\":\"intents-router.<parent>.near\",
                                 \"domain_id\":1}>" }}
```

`domain_id: 1` → Ed25519 (`0` → Secp256k1). Ed25519 is required: a NEAR implicit
account id _is_ an Ed25519 public key.

**Step 2 — pubkey to account id.** Strip `ed25519:`, base58-decode to 32 bytes,
lowercase hex. That hex string **is** `A`; no registration or setup transaction is
needed, because `intents.near` recovers the verifying key from the id itself.

```js
const raw = bs58.decode(pk.replace("ed25519:", "")); // 32 bytes
const A = Buffer.from(raw).toString("hex"); // 64 lowercase hex chars
```

**Step 3 — deposit address** (POA, unauthenticated):

```json
POST https://bridge.chaindefuser.com/rpc
{ "id": "1", "jsonrpc": "2.0", "method": "deposit_address",
  "params": [{ "account_id": "<A hex>", "chain": "eth:1" }] }
→ { "result": { "address": "0xN", "chain": "eth:1" } }
```

### Derivation is keyed on the caller

Measured, holding the path constant:

```
intents-router.hydration.near + "dca-1" → A 1a0723b8… → 0x43F3DB49…
attacker.near                 + "dca-1" → A 551d7b45… → 0x21B26d30…
intents-router.hydration.near + "dca-1" → A 1a0723b8… → 0x43F3DB49…   (deterministic)
```

A fork of this router deployed elsewhere derives a disjoint account set and cannot
produce a signature valid for `A`. **Code identity is irrelevant; only account
identity matters.**

> `predecessor` is an explicit argument on the _view_ method, so anyone can compute
> anyone's derived key — the `attacker.near` row above was computed without any
> permission. On `sign`, `predecessor` is **not** an argument: the MPC network takes
> the true caller from the runtime. Public derivability of an address and authority
> over it are unrelated.

**Chain caveat.** The same H160 is returned for `eth:1`, `eth:8453` and `eth:42161`,
but the credited token differs by the chain the transfer actually occurred on
(`eth.omft.near` / `base.omft.near` / `arb.omft.near`). The address does not
disambiguate — be strict about the delivery chain, or watch every token id you could
receive.

### Emitter guard — both halves are mandatory

The router MUST pin **chain id and emitter address together**. Checking only one
means any contract on chain 73, or the same address on any other Wormhole chain,
can author orders the router will honour — a total compromise.

```
emitter_chain   == 73
emitter_address == left-pad-12-zero-bytes(IntentEmitter H160)   // universal address
```

Wormhole uses 32-byte universal addresses; an EVM address occupies the low 20
bytes. `UniversalAddress` from `@wormhole-foundation/sdk-connect` is already a
dependency in `xc-core/src/bridge/wormhole.ts`.

Note: the 1Click asset registry exposes ZEC as `1cs_v1:near:nep141:zec.omft.near`.
That prefix is 1Click's namespace — the **solver relay and `intents.near` use the
bare `nep141:zec.omft.near`**. Do not mix them.

---

## 2. `IntentOrder` — Wormhole message payload

Not DCA-specific. One message type covers a DCA tranche, a single Hydration swap,
or any future route — the emitter publishes an _order_, and what varies is only how
many deposits arrive against it.

### Standing authorization model

An order authorizes one triple: **"any balance in account `A` may be swapped to
`destinationAsset` and delivered to `recipient`."** That statement is identical for
a one-shot swap and for a 22-tranche DCA; the only difference is how many times it
is acted on. So one order is published per route, not per tranche, and the router
reuses it for every deposit that lands in `A`.

This is why `tranche` and `amountIn` are absent. The on-chain balance is the only
source of truth, so a drain is inherently idempotent — it swaps whatever is there,
and with nothing there it simply fails. Replay protection is unnecessary for a
standing authorization; the balance bounds it.

Two different destinations from the same source means two `quoteId`s, hence two
accounts and two deposit addresses. Keep them disjoint.

### Layout

Packed big-endian. Fixed 37-byte header, then two length-prefixed strings.
Total size `38 + destAssetLen + recipientLen`.

Implemented in [`IntentCodec.sol`](../../contracts/src/intents/IntentCodec.sol) — that library is the
normative version, and `IntentEmitter.computeTerms(order)` returns the exact bytes for a given order
so an off-chain encoder can be diffed against it rather than trusted.

```
 byte  0    1                                33      35 36 37            37+D        38+D
       ├────┼───────────────────────────────────┼──────┼──┼──┼─────────────┼──────────┼──────────┐
       │ ver│            quoteId                │ slip │k │D │ destAsset   │    R     │ recipient│
       │  1 │              32                   │   2  │1 │1 │     D       │    1     │    R     │
       └────┴───────────────────────────────────┴──────┴──┴──┴─────────────┴──────────┴──────────┘
       │◄────────────── ORDER_HEADER_SIZE = 37 ──────────────►│
                                                              │◄─ length-prefixed strings ─────►│

       total = 38 + D + R          k = recipientKind      slip = maxSlippageBps
```

Two length-prefixed strings, and the second length is only readable after the first string is
consumed. `decodeQuote` therefore validates the total against **both** lengths and rejects any buffer
that does not account exactly — a buffer two different orders could hash from is not one to read the
first of.

| Offset | Size | Field              | Type    | Notes                                                                                                                                                         |
| ------ | ---- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | 1    | `version`          | u8      | `1`. Reject anything else. Inside the hash, so a future layout derives disjoint accounts.                                                                     |
| 1      | 32   | `quoteId`          | bytes32 | Namespace value, unique per schedule. Must be non-zero. |
| 33     | 2    | `maxSlippageBps`   | u16     | Floor tolerance, committed at order creation.                                                                                                                 |
| 35     | 1    | `recipientKind`    | u8      | `0` = destination chain (`ft_withdraw`), `1` = intents account (`transfer`).                                                                              |
| 36     | 1    | `destAssetLen`     | u8      |                                                                                                                                                               |
| 37     | D    | `destinationAsset` | bytes   | UTF-8 intents token id, e.g. `nep141:zec.omft.near`. Use the bare id, **not** 1Click's `1cs_v1:` form.                                                        |
| 37+D   | 1    | `recipientLen`     | u8      |                                                                                                                                                               |
| 38+D   | R    | `recipient`        | bytes   | UTF-8 destination address. **The value the whole design protects.**                                                                                           |

`quoteId` is meaningless to the router. It exists so two schedules that agree on every other term
stay on disjoint accounts; reusing one merges their balances.

`destinationAsset` is carried rather than hardcoded — without it the router could
only ever produce one asset, and the emitter is meant to serve any route.

**`intentsAccount` is deliberately absent.** An earlier draft carried the derived `A` in the payload
so the router could re-derive and reject on mismatch. That is redundant once the path is the hash of
the terms (§4): the router computes `A` from what it received, so there is nothing to disagree with.
Carrying it would only add 32 bytes and a second way to be wrong.

**Length bounds live in the encoder, not at the call site.** A string over 255 bytes wraps to zero
through the `uint8` length cast, which would let two different orders produce the same bytes — and
therefore the same account. `encodeQuote` rejects `0` and `>255` for both strings so no caller can
obtain an ambiguous hash.

### Emit (Hydration, Solidity)

```solidity
struct IntentOrder {
    bytes32 quoteId;
    bytes32 intentsAccount;
    uint16  maxSlippageBps;
    uint8   recipientKind;
    string  destinationAsset;
    string  recipient;
}

function _encode(IntentOrder memory o) internal pure returns (bytes memory) {
    bytes memory a = bytes(o.destinationAsset);
    bytes memory r = bytes(o.recipient);
    require(a.length > 0 && a.length <= 255, "bad asset");
    require(r.length > 0 && r.length <= 255, "bad recipient");
    return abi.encodePacked(
        uint8(1), o.quoteId, o.intentsAccount, o.maxSlippageBps,
        o.recipientKind, uint8(a.length), a, uint8(r.length), r
    );
}

// same transaction as the bridge call
uint64 sequence = coreBridge.publishMessage{value: msg.value}(
    uint32(0),          // Wormhole's own nonce, unrelated to the intent nonce
    _encode(order),
    uint8(1)            // consistencyLevel: finalized
);
```

### Decode (NEAR, Rust)

```rust
pub struct IntentOrder {
    pub order_id: [u8; 32],
    pub intents_account: [u8; 32],
    pub max_slippage_bps: u16,
    pub recipient_kind: u8,
    pub destination_asset: String,
    pub recipient: String,
}

fn decode_order(p: &[u8]) -> IntentOrder {
    require!(p.len() >= 70, "short payload");
    require!(p[0] == 1, "bad version");

    let alen = p[68] as usize;
    let rlen_off = 69 + alen;
    require!(p.len() > rlen_off, "short payload");
    let rlen = p[rlen_off] as usize;
    require!(p.len() == rlen_off + 1 + rlen, "length mismatch");

    IntentOrder {
        order_id:          p[1..33].try_into().unwrap(),
        intents_account:   p[33..65].try_into().unwrap(),
        max_slippage_bps:  u16::from_be_bytes(p[65..67].try_into().unwrap()),
        recipient_kind:    p[67],
        destination_asset: String::from_utf8(p[69..69 + alen].to_vec()).expect("utf8"),
        recipient:         String::from_utf8(p[rlen_off + 1..].to_vec()).expect("utf8"),
    }
}
```

Parse the second length only after the first string, and validate the total length
against both — a payload whose declared lengths do not sum exactly to the buffer
must be rejected rather than truncated.

---

## The forwarding instruction — the emitter's other message

The order above is the _authorization_, read on NEAR. The emitter publishes a second, unrelated
message per order, read on **Ethereum**, telling `IntentReceiver` where that order's funds go. Both
variants use it; it has nothing to do with the NEAR router.

Plain `abi.encode`, not packed — the decoder is Solidity, and the bytes are never hashed:

```solidity
abi.encode(
    uint64  transferSequence,  // the NTT manager's sequence for the settlement it pairs with
    address depositAddress,    // where the receiver forwards
    uint256 amount,            // what the settlement delivers, already quantized to TRIM_UNIT
    uint256 maxRelayFee        // ceiling on what the caller may claim
)
```

Fixed 128 bytes, all static — no strings, so no length games:

```
 word   0                1                2                3
        ├────────────────┼────────────────┼────────────────┼────────────────┐
        │ transferSeq    │ depositAddress │     amount     │  maxRelayFee   │
        │ u64, left-pad  │ addr, left-pad │     u256       │     u256       │
        └────────────────┴────────────────┴────────────────┴────────────────┘
          32 bytes         32               32               32
```

Published from the same transaction as the settlement, so both land in one `LogMessagePublished`
sweep of the source receipt — which is how the relayer finds it:

```
  source tx receipt (Hydration)
  ┌──────────────────────────────────────────────────────────┐
  │ LogMessagePublished(sender = WormholeTransceiver, …)   ──► [B] settlement
  │ LogMessagePublished(sender = IntentEmitter,        …)  ──► [C] instruction
  └──────────────────────────────────────────────────────────┘
        │                                    │
        │ filter topics[1] == emitter        │ decode data → sequence, depositAddress,
        │                                    │               amount, maxRelayFee
        ▼                                    ▼
   nothing to do here              match sequence against [B], then processOrder
```

`sender` is the only indexed field on `LogMessagePublished`, which is enough to pick our emitter's
messages out of a receipt without needing the core bridge's own address.

**Why `transferSequence` is the join key.** It is the NTT **manager's** message sequence, returned by
`NttManager.transfer` and written into the manager message as `bytes32(uint256(sequence))`. It is
_not_ a Wormhole sequence: the settlement VAA is addressed by the transceiver's Wormhole sequence and
the instruction by the emitter's, and those are three independent counters. `processOrder` re-derives
the manager sequence from the settlement payload and rejects a mismatch, which is what stops a caller
pairing any pending settlement with whichever instruction carries the richest ceiling.

**Why `amount` is carried rather than read from the settlement.** The receiver would otherwise have
to parse the NTT transfer payload to learn it. Carrying it costs 32 bytes and makes the instruction
self-describing; the settlement still has to have actually landed before anything moves.

**Delivered is not released.** `processOrder` cannot infer that funds arrived from the settlement
having been delivered. NTT's inbound rate limiter consumes the VAA and marks the manager message
executed *before* it decides whether to release, so a rate-limited transfer is queued and credits
nothing while `isVAAConsumed` reads true. The receiver therefore asks the manager directly —
`isMessageExecuted(digest) && getInboundQueuedTransfer(digest).txTimestamp == 0` — and reverts
`SettlementNotReleased` otherwise, on top of the balance check. The digest is
`keccak256(abi.encodePacked(sourceChainId, managerMessage))`, where `managerMessage` is the slice
`NttPayload` already walks past.

| `isMessageExecuted` | `txTimestamp` | state |
| --- | --- | --- |
| false | 0 | never delivered or attested |
| true | 0 | released |
| true | ≠ 0 | queued — nothing credited |
| true | 0 | queued, then completed — released |

**Consistency level.** Published instantly (200) rather than finalized. The instruction carries no
authority of its own — it is inert until a settlement naming the same sequence arrives — so waiting
on finality would only delay the relayer. The one cost is a reorg window: if the publishing
transaction were dropped after guardians signed, the manager's counter would rewind and a later,
different transfer could reuse that sequence. On a GRANDPA chain that needs a block dropped
pre-finalization, so it is collator-level rather than routine. See the verification table in
[spec.md](spec.md#7-verification-status) — level 200 is not yet confirmed to work from chain 73.

---

## 3. VAA envelope checks — every `finalize` call

The VAA is verified on **every** call. It is not stored, and there is no
registration step: VAAs are permanent, publicly retrievable data, so the bot
resubmits the same one for each tranche and the router re-derives the terms from
guardian-signed bytes each time.

```rust
let vm = wormhole_core.parse_and_verify_vaa(vaa);      // guardian quorum

require!(vm.emitter_chain == 73, "wrong source chain");            // Hydration
require!(vm.emitter_address == self.emitter_address, "wrong emitter");
require!(vm.consistency_level >= 1, "not finalized");

let order = decode_order(&vm.payload);
require!(order.intents_account == self.derived_raw(order.order_id), "account mismatch");
```

Both emitter checks are mandatory and neither is sufficient alone — see §1.

> **No stored order state, by choice.** Caching the decoded order to save
> verification gas would make the security argument transitive (storage → writer →
> VAA) and introduce a write-once invariant to defend for the life of the contract.
> Re-verifying is cheap next to an MPC signing round, and it keeps the property flat:
> `recipient` comes from guardian-signed bytes on every call, full stop. The only
> thing worth publishing once rather than per tranche is the **message on Hydration**
> — that saving is on the emitter side and needs nothing from the router.

Replay is a non-issue and needs no guard. Resubmitting the same VAA is the intended
mode of operation: it authorizes draining whatever balance `A` currently holds, so
a repeat call with an empty balance simply fails. The balance bounds the authority.

⚠ **UNVERIFIED:** the NEAR core bridge's method name and returned struct shape
(`parse_and_verify_vaa` vs `verify_vaa`, and its field names).

---

## 4. Intent construction and signing ⚠ BLOCKING UNKNOWN

**The single highest-risk assumption in the design.** The MPC signs exactly the
bytes handed to it; `intents.near` independently reconstructs what it believes
should have been signed and compares. A one-byte divergence yields a silently
invalid intent.

### The message (inner JSON, `nep413`)

`nonce` and `recipient` are siblings of `message`, **not** inside it:

```json
{
  "signer_id": "<64-hex implicit account A>",
  "deadline": "2026-08-21T12:05:00.000Z",
  "intents": [
    {
      "intent": "token_diff",
      "diff": {
        "nep141:eth.omft.near": "-10000000000000000",
        "<destinationAsset from the order>": "5000000"
      }
    },
    {
      "intent": "ft_withdraw",
      "token": "zec.omft.near",
      "receiver_id": "zec.omft.near",
      "amount": "5000000",
      "msg": "<recipient from the order>"
    }
  ]
}
```

Sign convention: **negative = given up, positive = received.**

The second intent depends on `recipientKind`: `0` emits `ft_withdraw` (leaves NEAR
via POA), `1` emits `transfer` to an intents account instead.

⚠ **UNVERIFIED:** the `ft_withdraw` shape for POA tokens — whether `receiver_id` is
the token contract with the external address in `msg`, how the withdrawal fee is
accounted, and whether it may share the array with `token_diff` or must follow
settlement as a second intent.

### Candidate signing constructions

Exactly one is correct. Determine which from the verifier's source; do not guess.

| Standard      | Bytes fed to the signer                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `raw_ed25519` | Most likely the raw UTF-8 of `message` — Ed25519 hashes internally, so no pre-hash. |
| `nep413`      | `sha256( LE_u32(2^31 + 413) ‖ borsh({message, nonce, recipient, callback_url}) )`   |

```rust
let to_sign: Vec<u8> = /* raw message bytes, or the NEP-413 hash */;

signer::ext(self.mpc_signer.clone())
    .with_attached_deposit(SIGN_DEPOSIT)
    .with_static_gas(SIGN_GAS)
    .sign(SignRequest {
        payload:   to_sign,
        path:      hex::encode(order.order_id),
        domain_id: 1,                              // Ed25519
    })
```

⚠ **UNVERIFIED:** `SignRequest`'s field names on `sign`. The _view_ method
`derived_public_key({path, predecessor, domain_id})` is confirmed, but the signing
struct previously used `key_version`.

### Nonces

Must be unique per signer account. With `tranche` gone, derive from a per-order
counter held in router state:

```
nonce = sha256(order_id ‖ u64_be(counter))
```

Increment the counter only when a signature is successfully produced, so a failed
`sign` does not burn a nonce. Deterministic derivation also means a retry after a
failed _publish_ reproduces the same nonce rather than consuming a new one.

### `MultiPayload` — what the bot publishes

```json
{
  "standard": "nep413",
  "payload": {
    "recipient": "intents.near",
    "nonce": "<base64 of the 32-byte nonce>",
    "message": "<the JSON string above, escaped>"
  },
  "public_key": "ed25519:<bs58 of MPC-derived pubkey>",
  "signature": "ed25519:<bs58 of MPC signature>"
}
```

Note `payload.recipient` is `intents.near` — the NEP-413 _verifying contract_, not
the order's destination address. Two unrelated meanings of the word; don't conflate
them.

---

## 5. `IntentRouter` interface

```rust
#[near(contract_state)]
pub struct IntentRouter {
    wormhole_core:    AccountId,
    mpc_signer:       AccountId,                      // v1.signer
    intents_contract: AccountId,                      // intents.near
    emitter_chain:    u16,                            // 73
    emitter_address:  [u8; 32],                       // IntentEmitter, universal
    derived:  LookupMap<[u8;32], PublicKey>,          // cached MPC pubkeys (perf only)
    counters: LookupMap<[u8;32], u64>,                // nonce counters
    signed:   LookupMap<([u8;32], u64), MultiPayload>,
}

#[near]
impl IntentRouter {
    /// Cache the MPC pubkey for a path. Pure optimisation — the value is
    /// deterministic and publicly computable, so this is not security-relevant.
    pub fn register_path(&mut self, order_id: [u8;32]) -> Promise;

    /// Verify the VAA and swap A's current balance to the recipient it carries.
    /// Permissionless; anyone may relay. The same VAA is resubmitted every tranche.
    pub fn finalize(&mut self, vaa: Base64VecU8, quote_hash: String,
                    amount_out: U128) -> Promise;

    #[private]
    pub fn on_signed(
        &mut self, order_id: [u8;32], counter: u64, payload: NepPayload,
        #[callback_result] sig: Result<SignatureResponse, PromiseError>,
    ) -> MultiPayload;

    pub fn get_signed_intent(&self, order_id: [u8;32], counter: u64) -> Option<MultiPayload>;
    pub fn derived_account(&self, order_id: [u8;32]) -> Option<AccountId>;
}
```

`finalize` takes `quote_hash` only to bind the emitted payload to the quote the bot
will publish; the router cannot reach the relay to validate it.

### Why `amount_out` is the only amount passed

The VAA carries what the user **commits** — `recipient`, `destinationAsset`,
`maxSlippageBps` — all immutable policy. Amounts are _observations_, so they cannot
be committed at publish time:

- **`amount_in`** — Hydration knows what it sends, not what arrives; the relay fee is
  deducted in flight. And one VAA serves every tranche, each with a different amount.
  So the router reads `A`'s balance from `intents.near` via `mt_batch_balance_of`,
  making it trustless — no caller input at all.
- **`amount_out`** — a live solver quote. Not derivable on-chain: there is no ZEC
  oracle, and `quote_hash` is an opaque relay handle a contract cannot resolve.
  Committing it in the VAA would recreate the stale-limit-price failure that ruled
  out pre-minted 1Click quotes (`spec.md` §1).

So `amount_out` must come from the caller, and it is bounded by policy rather than
trusted:

| Bot supplies          | Consequence                                            |
| --------------------- | ------------------------------------------------------ |
| `amount_out` inflated | relay rejects it — amounts disagree with its own quote |
| `amount_out` too low  | rejected by the floor check against `maxSlippageBps`   |

Neither misdirects funds; `recipient` never comes from a caller argument.

**Consequence of reading the balance:** if a tranche lands between the bot's quote
and the router's balance read, the signed diff covers a larger amount than the quote
and the relay rejects it. Benign — the balance is untouched and the next tick
re-quotes against the new balance — and rare, since tranches are hours or days
apart. Adding the promise hop for the balance read is worth removing a caller input.

### Concurrency

The router does **not** serialize `finalize`. It cannot: settlement happens on
`intents.near` via the bot's `publish_intent`, so there is no callback telling the
router when an intent completed.

Two concurrent `finalize` calls therefore produce two validly-signed intents
against one balance. This is safe but wasteful — both carry the same recipient, the
first to settle consumes the balance, the second fails on insufficient funds. No
loss, no misdirection. Serialization is the bot's job (§7), and it is an efficiency
concern rather than a safety one.

### Events

Emit the signed payload so the bot needs no view call on the happy path:

```json
{ "standard": "intent_router", "version": "1.0.0", "event": "intent_signed",
  "data": [{
    "order_id":          "0x…",
    "counter":           7,
    "signer_account":    "1a0723b8…",
    "quote_hash":        "…",
    "amount_in":         "10000000000000000",
    "amount_out":        "5000000",
    "destination_asset": "nep141:zec.omft.near",
    "recipient":         "t1…",
    "signed_data":       { "...MultiPayload..." }
  }] }
```

Echoing `recipient` and both amounts beside the signature makes the log an audit
trail: any observer can verify that every signature the router ever emitted targeted
a VAA-committed recipient. Worth monitoring even though a mismatch should be
impossible.

---

## 6. Off-chain bot — exact calls

**Poll balance** (unauthenticated view on `intents.near`):

```json
{
  "method": "query",
  "params": {
    "request_type": "call_function",
    "finality": "final",
    "account_id": "intents.near",
    "method_name": "mt_batch_balance_of",
    "args_base64": "<base64 {\"account_id\":\"<hex>\",\"token_ids\":[\"nep141:eth.omft.near\"]}>"
  }
}
```

**Quote** — `POST https://solver-relay-v2.chaindefuser.com/rpc`, header `X-API-Key: <Partner Portal JWT>`:

```json
{
  "id": 1,
  "jsonrpc": "2.0",
  "method": "quote",
  "params": [
    {
      "defuse_asset_identifier_in": "nep141:eth.omft.near",
      "defuse_asset_identifier_out": "<destinationAsset from the order>",
      "exact_amount_in": "10000000000000000",
      "min_deadline_ms": 120000
    }
  ]
}
```

```json
{
  "result": [
    {
      "quote_hash": "…",
      "amount_in": "…",
      "amount_out": "…",
      "expiration_time": "2026-08-21T12:10:27Z"
    }
  ]
}
```

An empty array or `null` means no solver took it — back off and re-quote. Note
the 1Click distribution-channel JWT is **not** a relay credential and yields
`result: null` for every pair, including liquid ones.

**Publish:**

```json
{ "id": 1, "jsonrpc": "2.0", "method": "publish_intent", "params": [{
    "quote_hashes": ["<quote_hash>"],
    "signed_data": { "...MultiPayload from the event..." } }]}
```

```json
{ "result": { "status": "OK", "intent_hash": "…" } }
```

**Status** — `get_status({intent_hash})`:

| Status                   | Meaning                      | Bot action                                          |
| ------------------------ | ---------------------------- | --------------------------------------------------- |
| `PENDING`                | received, awaiting execution | keep polling                                        |
| `TX_BROADCASTED`         | sent to the verifier         | keep polling                                        |
| `SETTLED`                | done                         | release lock, record                                |
| `NOT_FOUND_OR_NOT_VALID` | expired or errored           | release lock; balance is intact, retry from polling |

---

## 7. Bot state machine

One instance per intents account. Exactly one in-flight intent per account.

```
IDLE ──balance > 0──► QUOTING ──quote ok──► FINALIZING ──event──► PUBLISHING
  ▲                      │                      │                    │
  │                      │ no solver            │ tx fail            │ SETTLED
  │                      ▼                      ▼                    ▼
  └──────────────── BACKOFF ◄───────────────────┴──────────── IDLE ◄──┘
```

Invariants:

- Never hold two in-flight intents for one account — the second would sign
  against funds the first already committed.
- Never treat a quote as durable. If `expiration_time` passes before the signed
  payload arrives, discard and re-quote. Costs nothing; no funds move on an
  expired quote.
- Balance is the only source of truth. Do not track individual deposits, and do
  not persist anything whose loss would strand funds — a fresh bot with an empty
  database must resume correctly from balance alone.
- The router does not serialize `finalize` (§5) — the per-account lock here is the
  only thing preventing two signed intents against one balance. Losing it costs a
  wasted signature, not funds.
- Retries are safe: nonce derivation is deterministic, so re-publishing after a
  failed `publish_intent` reuses the same nonce rather than burning a new one.
