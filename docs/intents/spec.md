# SPEC — Intents: Hydration → NEAR Intents

Hydration users acquire any NEAR-Intents-supported asset (BTC, ZEC, NEAR, …). Their asset is sold
for WETH on Hydration, settled to Ethereum over NTT, and forwarded into a **deposit address** that
NEAR Intents credits. What varies is only where that deposit address comes from.

## Two variants, one API

Both call the same entry point, and **the contracts cannot tell them apart** — `depositAddress` is
just an address:

```solidity
placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee)
```

**1Click.** The deposit address is minted by a quote, one per swap. It expires, the rate floor is
frozen inside it, and getting one needs an HTTP call and a user to authorize the destination. Nothing
beyond the shared transport is required. Implemented.

**MPC-derived.** The deposit address is derived — `path → A → 0xN` — and is permanent, deterministic,
and reusable for every fill. One user signature at schedule creation covers all of them; the rate
floor is enforced per fill on NEAR instead of being frozen up front. Costs two extra pieces:
`IntentQuoteEmitter` on Hydration and `IntentRouter` on NEAR. The Hydration side is implemented; the
router is not built.

Everything up to and including the Ethereum forward is **shared** — see
[Shared transport](#shared-transport) below.

The variants diverge only after the funds land at the deposit address:

- **1Click** — the quote's solver network settles it. `intent`'s relayer app nudges 1Click so the deposit is
  noticed promptly. Nothing else is needed.
- **MPC-derived** — POA credits the derived NEAR account `A`, and `IntentRouter` swaps and delivers
  under the authority of a published order. **§1 onward covers only this variant.**

### Why the MPC variant exists

The 1Click variant needs a fresh quote per swap, which means an HTTP call in the critical path and a
user present to authorize the destination. Neither works for an on-chain DCA firing unattended for
weeks. The MPC variant replaces the per-swap quote with a **standing authorization**: one
guardian-signed message says "any balance in this account may be swapped to `destinationAsset` and
delivered to `recipient`", and every tranche reuses it.

An off-chain bot may relay, but a fully compromised bot must not be able to redirect funds — which is
the constraint the rest of this document is built around.

---

## Shared transport

Identical for both variants. Two Wormhole messages leave the same Hydration transaction, because NTT
carries no payload of its own — the destination has to travel separately.

```
HYDRATION   IntentEmitter.placeOrder(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee)
              1. sell assetIn → WETH via the router   (no-op when assetIn is already WETH)
              2. deduct cost = NTT deliveryPrice + wormhole messageFee, from the swap output
              3. quantize to TRIM_UNIT (1e10) — NTT trims to 8dp, WETH is 18dp
              4. nttManager.transfer(amount, 2, IntentReceiver)   → transferSequence
              5. wormhole.publishMessage(abi.encode(
                     transferSequence, depositAddress, amount, maxRelayFee))
              → emits OrderPlaced

ETHEREUM    IntentReceiver.processOrder(nttVaa, instructionVaa, feeRequested)
              1. verify the instruction (guardian quorum, emitter pinned to chain 73 + address)
              2. require instruction.sequence == settlement's NTT manager sequence
              3. require feeRequested <= maxRelayFee
              4. deliver the settlement through the transceiver, unless already delivered
              5. forward (amount - feeRequested) to depositAddress; pay the caller its fee
              → emits OrderProcessed, RelayFeePaid
```

**Why two messages and not one.** The Wormhole TokenBridge's `transferTokensWithPayload` carries a
payload _and_ restricts redemption to the named recipient. NTT does neither: it has no payload field,
and `receiveMessage` is permissionless. So the destination rides its own message, and the two are
bound by the **NTT manager's sequence** — not a Wormhole sequence, and not chain-global. Pairing a
settlement with someone else's instruction fails that check.

**Why delivery is atomic with the forward.** Because NTT delivery is permissionless, a generic
relayer can deliver a settlement before we do — funds would then sit in the receiver with nothing to
move them. `processOrder` handles both cases in one call: it delivers if needed, then forwards. Since
the caller does all of it, the caller is the one paid, so there is nothing to snipe.

**Why the fee ceiling is a caller argument.** `maxRelayFee` is committed per order rather than set by
an operator. Paired with a colluding relayer, a ceiling is a claim on the order's value, so it
belongs to whoever's funds are at risk. A scheduler stores it alongside `depositAddress`, so placing
an order still needs nothing off-chain.

**Not payable.** Both fees come out of the swap output, which works only because Hydration's native
currency _is_ WETH — one balance behind two interfaces. That is what lets an on-chain scheduler place
an order with no funding step.

Relaying is [`agents/relayer`](../../agents/relayer/)'s `intent` feature: it subscribes to the
Hydration WETH transceiver, finds the instruction in the source transaction's `LogMessagePublished`
logs, prices the fee by estimating the real call, and submits. Retries ride the relayer
engine's Redis-backed backoff; an order stale beyond the age cap is dropped rather than retried
forever.

---

## 1. Rejected approaches

Five ways to make the **unattended** case work without MPC derivation, all tested against the live
APIs, all dead. Recorded so nobody re-litigates them.

None of this is a criticism of 1Click. The 1Click variant is in production and is the right tool when
a user is present: they request the quote, they see the destination, and the address only has to
survive one swap. Every problem below comes from removing the user, not from 1Click.

**A fresh 1Click quote per tranche** needs an HTTP call inside the critical path of an on-chain
schedule — which an on-chain schedule cannot make. Delegating it to a bot moves the problem rather
than solving it: whoever requests the quote picks `recipient`, and with no user in the loop nothing
checks that choice. A compromised bot would redirect funds at the source, before any on-chain rule
could object. In the user-present flow the user _is_ that check.

**Pre-minting N addresses at schedule creation** freezes `minAmountOut` at quote time. Late tranches
then execute against a stale floor and refund instead of filling. It also cannot express a rolling,
unbounded-N schedule.

**Reusing one 1Click address** is impossible: they are non-deterministic. Byte-identical requests
return different addresses in all three deposit modes, so nothing can re-derive one.

**An `ANY_INPUT` collector** only sweeps once a pool clears $1,000, and is `INTENTS`-only —
`400 "ANY_INPUT only supports depositType INTENTS or CONFIDENTIAL_INTENTS"` — so Wormhole cannot
deliver into it at all.

**Letting the bot hold the intents key** fails on `intents.near` having no per-key scoping: _"Every
public key registered to an account can sign intents on its behalf."_ A key is unbounded authority,
so a compromised bot could withdraw anywhere.

MPC derivation is what remains, and it removes the key from every human-operated component.

---

## 2. Architecture

Two independent paths leave Hydration: **funds go to Ethereum, the authorization
message goes to NEAR.** They meet only inside the router.

```
═══ PHASE 1 · dispatch ═══════════════════════════════════════════════════

 HYDRATION  (on-chain, autonomous — no off-chain dependency)
   DCA tranche fires
     ├── IntentEmitter.placeOrder(…, 0xN, relayFee) ─►  VALUE PATH ┐
     │     sell for WETH, settle over NTT + publish the            │
     │     forwarding instruction (see Shared transport)           │
     │                                                             │
     └── IntentQuoteEmitter.publishQuote(Quote) ────► MESSAGE PATH ┼─┐
           once per route, not per tranche                         │ │
                                                                   │ │
 ETHEREUM                                          ◄───────────────┘ │
   IntentReceiver.processOrder → forwards native ETH to 0xN          │
     │                                                               │
     │ POA bridge watcher — not our transaction                      │
     ▼                                                               │
 NEAR  (on-chain)                                                    │
   intents acct A credited with nep141:eth.omft.near                 │
                                                                     │
 NEAR  (Wormhole core)                             ◄─────────────────┘
   guardians sign → VAA available to anyone
   published once per order; the bot resubmits the same VAA every tranche

═══ PHASE 2 · authorize & settle ═════════════════════════════════════════

 OFF-CHAIN BOT  (untrusted, holds no keys)
   sees balance > 0 → quote → quote_hash ──────────────────┐
                                                           ▼
 NEAR  IntentRouter.finalize(vaa, quote_hash, amount_out)
   1. verify VAA + emitter (chain 73 + address)
   2. recipient := vaa.payload          ← never a caller argument
   3. require amount_out ≥ floor
   4. v1.signer.sign(...)               [async, MPC]
   5. emit signed MultiPayload ─────────────────────────────┐
                                                            ▼
 OFF-CHAIN BOT
   publish_intent(quote_hashes, signed_data) ───────────────┐
                                                            ▼
 NEAR  intents.near
   relay pairs our intent with the solver's → settles → ft_withdraw
                                                            │
 ZCASH                                                      ▼
   ZEC arrives at the recipient carried in the VAA
```

> **The POA step is not a transaction we build.** `0xN` is POA's deposit address
> for account `A`; sending native ETH there _is_ the deposit into NEAR Intents,
> and POA's off-chain watcher does the crediting.
>
> One asset, two ends — POA states the mapping directly:
>
> ```json
> {
>   "defuse_asset_identifier": "eth:1:native",
>   "origin_chain_address": "native",
>   "near_token_id": "eth.omft.near",
>   "intents_token_id": "nep141:eth.omft.near"
> }
> ```
>
> You deliver native ETH on Ethereum; the tradeable claim exists on NEAR as
> `nep141:eth.omft.near`. The ETH itself stays custodied on Ethereum — ordinary
> lock-and-mint. This is already true of every phase-1 swap; 1Click just hides it
> behind a per-quote address. The only change here is that the address is bound to
> an account we derive rather than to a throwaway quote.
>
> It cannot be otherwise: the intents ledger and every solver live on NEAR, so the
> claim must exist inside `intents.near` before a solver can trade it for ZEC.
>
> (Note the registry distinguishes `nep141:eth.omft.near` — `blockchain: "eth"`,
> delivered on Ethereum — from `nep141:eth.bridge.near`, `blockchain: "near"`.
> The `nep141:` prefix denotes the token standard, not where you deposit.)

The trust boundary is the VAA. `recipient` is read from guardian-signed bytes
verified inside the contract on every call, never from a caller argument and never
from mutable storage. The router holds no order state to protect.

### Why a compromised bot cannot steal

- It cannot forge a VAA — that needs a Wormhole guardian quorum.
- It cannot alter `recipient` — the router re-reads it from the verified VAA on every call.
- It cannot request an MPC signature — only the router's code can, and only over
  a payload built from a verified VAA.
- It cannot mutate the signed intent — any edit invalidates the Ed25519 signature.
- VAA relay is permissionless, so withholding is weak censorship: anyone can relay.

Residual powers: **stall**, and **choose which solver quote** (see §6).

---

## 3. Key derivation and the constant address

No private key for the intents account exists anywhere. It is MPC-derived.

**Two separate calls, and the router account appears only in the first.** POA has
no idea the router exists — it only ever sees `A`.

```
MPC   derived_public_key({ predecessor: "intents-router.hydration.near",
                           path: "dca-1", domain_id: 1 })   ← router goes HERE
        → ed25519:2kbv31BMDHBK54RYMX1gKiSLCXMjWphF9sbxvH4o4D3S
        → A = 1a0723b8ff06ee3a7db5d855150156a7dfdbedeabb6b386d3c57c93c665829f5

POA   deposit_address({ account_id: A, chain: "eth:1" })     ← only A, never the router
        → 0x43F3DB4993C0452109ccd8D346AE276627A1D2b7
```

Step by step:

1. `v1.signer.derived_public_key({predecessor, path, domain_id: 1})` → Ed25519 pubkey.
   `domain_id: 1` selects Ed25519; `0` is Secp256k1.
2. NEAR implicit account id `A` = lowercase hex of that pubkey's 32 bytes (base58-decode
   the part after `ed25519:`). Self-registering with `intents.near` — the account id _is_
   the public key, so no setup transaction and no registration.
3. POA: `deposit_address({account_id: A, chain: "eth:1"})` → `0xN`. Permanent and
   deterministic; verified stable across repeated calls and distinct per account.
4. `0xN` is stored in the DCA schedule at creation. The on-chain leg never needs
   another off-chain call.

### Path scope

`path` is **per DCA schedule**, not per tranche. All tranches of one schedule share
one `A` and one `0xN`, so balances merge — which is what makes the drain loop
idempotent (§5).

The order published for a path is a **standing authorization** — "any balance in `A`
may be swapped to `destinationAsset` and delivered to `recipient`" — so it is
published once and resubmitted for every deposit, whether that is one swap or
twenty-two tranches. VAAs are permanent public data, so the bot hands the router the
same one each time and the router re-verifies it — no stored state, no per-tranche
message, no replay key. The balance bounds what an authorization can do.
See `schema.md` §2 and §3.

Per-tranche paths would also work — unlike pre-minted 1Click quotes these carry no
rate and never expire — but they buy only bookkeeping, at the cost of storing N
addresses instead of one.

### Why nobody else's deployment can reach `A`

Derivation is keyed on `(predecessor, path)`. Measured, with the path held constant:

```
intents-router.hydration.near + "dca-1" → A 1a0723b8… → 0x43F3DB49…
attacker.near                 + "dca-1" → A 551d7b45… → 0x21B26d30…
intents-router.hydration.near + "dca-1" → A 1a0723b8… → 0x43F3DB49…   (deterministic)
```

An attacker deploying byte-identical code to another account derives a different
key, a different account, and a different deposit address. **Code identity is
irrelevant to derivation; only account identity matters.** So forks of this router
are harmless — they operate on a disjoint set of accounts.

> **`predecessor` is an argument on the view method, but not on `sign`.** Anyone can
> _compute_ anyone's derived public key — the table above computes `attacker.near`'s
> — because `derived_public_key` is a public read. When the router calls `sign`,
> however, the MPC network takes the predecessor from the runtime's true caller;
> there is no field to lie in. Public derivability of the address and authority over
> it are entirely separate.

### Deploy to a sub-account

Derivation binds to an account **id**. If that id could ever be re-registered by
someone else, they would inherit every derived account in the system. Deploy to a
sub-account of a name you control — `intents-router.hydration.near` — since only
`hydration.near` can create sub-accounts beneath itself. A standalone top-level
name leaves the id's future in the registrar's hands.

### The invariant that carries the whole design

Nothing external constrains how `A` is spent. `A` is a public key, not a contract
— it has no policy and cannot refuse anyone, and `intents.near` honours _any_
valid A-signature it is shown. There is no protocol rule saying "this account may
only be spent via `finalize`."

Two layers produce the guarantee, and only the first is cryptographic.

**Layer 1 — who can sign for `A`.** MPC derivation is keyed on `(caller, path)`, so only
`router.near` derives `K_A`; a call from any other account yields a different key for a different
account. Cryptographic, and it stops everyone else.

**Layer 2 — what the router signs.** The router's code only builds withdrawals whose `msg` came from
a verified VAA. Code only — as strong as the code plus its immutability.

Layer 2 is the router constraining _itself_, which yields a hard implementation
rule:

> **Every code path from a public method to `v1.signer.sign` MUST be gated on a
> freshly verified VAA. No exceptions, no admin bypass, no debug helper, no
> migration shim, no generic `sign(payload)`.**

A single unguarded path to the signer hands an attacker every DCA account in the
system simultaneously. Note this binds the escape hatch too (§ below): it needs a
signature, so it must be VAA-gated rather than owner-gated — an owner-gated
rescue method is precisely the unguarded path this rule forbids.

Note also that nothing binds the **deposit** side. `0xN` is publicly derivable
with no auth, so anyone may deposit to it and the funds land in `A`. That is
harmless — the router can only ever move them to the VAA's recipient — but do not
mistake deposit-side obscurity for a control.

> **Deployment consequence.** MPC derivation binds to the router's **account id,
> not its code hash**. Redeploying different code to that account gives the new
> code control of the same funds. So an upgradeable router means the deploy key
> is a redirect capability — exactly the property being designed out. Either
> delete all full-access keys after deploy (immutable; design the refund path in
> from day one) or put upgrades behind a timelock long enough for users to exit.
> This is a required decision before mainnet, not an afterthought.

---

## 4. Components to build

| #   | Component            | Chain         | Status                                                                                                                                                                    |
| --- | -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `IntentEmitter`      | Hydration EVM | **built** — `placeOrder`                                                                                                                                                  |
| 2   | `IntentReceiver`     | Ethereum      | **built** — `processOrder`                                                                                                                                                |
| 3   | `IntentQuoteEmitter` | Hydration EVM | **built** — `publishQuote`                                                                                                                                                |
| 4   | Schedule storage     | Hydration     | to build — `0xN`, `maxRelayFee`, tranche params per schedule                                                                                                              |
| 5   | `IntentRouter`       | NEAR (Rust)   | to build — VAA verification, floor enforcement, intent construction, MPC signing                                                                                          |
| 6   | Relay bot            | off-chain     | to build — balance polling, solver quoting, `finalize`, `publish_intent`, status                                                                                          |

Components 1–2 are shared with the 1Click variant and already carry it. 3–6 are what the MPC variant
adds. The bot is the only stateful off-chain piece and is untrusted by construction.

`IntentQuoteEmitter` is deployed separately from `IntentEmitter`, so its Wormhole emitter address is
distinct. That address is what the NEAR router pins — see [schema.md](schema.md) §1.

---

## 5. Sequence, per tranche

1. DCA pallet fires.
2. Scheduler calls `placeOrder(assetIn, amountIn, minEthOut, 0xN, maxRelayFee)` — sells for WETH,
   settles over NTT, publishes the forwarding instruction. See
   [Shared transport](#shared-transport).
3. The quote itself was published once by `publishQuote(Quote)`, not per tranche; its VAA is
   permanent public data that the bot resubmits every time.
4. On Ethereum, `IntentReceiver.processOrder` delivers the settlement and forwards native ETH to
   `0xN`, net of the relay fee.
5. POA credits intents account `A` with `nep141:eth.omft.near`.
6. Bot observes `A`'s balance > 0. Takes a per-account lock (one in-flight intent
   per account — trivial, since each DCA maps to one account).
7. Bot calls `quote` on the solver relay with `min_deadline_ms: 120000`.
8. Bot calls `IntentRouter.finalize(vaa, quote_hash, amount_out)`. The router reads
   A's balance itself; only the solver's quoted output is supplied.
9. Router verifies the VAA, checks replay, enforces the floor, builds the intent,
   calls `v1.signer.sign(...)`.
10. On callback, router assembles the `MultiPayload` and emits it as a log
    (and stores it for view access).
11. Bot reads the signed payload and calls `publish_intent(quote_hashes, signed_data)`.
12. Bot polls `get_status` until `SETTLED`. Releases the lock.

**Failure at any of 7–12 leaves the balance untouched in `A`.** The next poll
retries from step 6. Two tranches landing before a swap are swapped together.
An expired quote is discarded and re-quoted at no cost — no funds move on an
expired quote. The balance _is_ the state; individual deposits are never tracked.

### Timing

Only steps 9–11 sit inside the quote's validity window — the bridge latency is
entirely before step 7. MPC signing is seconds. `min_deadline_ms: 120000` is
generous; do **not** request long windows, since a quote valid for `T` is an
option the solver writes and its price scales with `√T` (a 60-minute window costs
roughly 7–8× the time premium of a 60-second one, when solvers answer at all).

---

## 6. Known residual: price integrity

The VAA fixes _destination_ integrity. It does not fix _price_ integrity.

Hydration cannot compute a ZEC floor — it has no ZEC price — so `amount_out`
originates from the bot's solver quote. A compromised bot cannot send funds
elsewhere, but colluding with a solver it could accept a poor rate and extract
value via the spread.

Bounding options, in ascending strength:

1. **Sanity bounds only.** Router rejects absurd values (zero, overflow) and
   relies on solver competition plus alerting. Cheapest; documented residual.
2. **Rate floor in the VAA.** Hydration carries `maxSlippageBps` and a reference
   rate. Works for fixed-term DCAs; for a rolling DCA the reference goes stale,
   which is the same failure that killed pre-minting.
3. **On-chain price reference on NEAR.** Router checks `amount_out` against an
   oracle. Strongest, but Ref Finance has no meaningful ZEC depth (161 pools
   touch `zec.omft.near`, all but one at zero TVL), so this needs a real oracle
   feed and is its own project.

**Recommendation:** ship with (1) plus monitoring, and record the residual
explicitly. Do not describe the system as trustless without qualifying it: it is
redirect-proof, not price-proof.

---

## 7. Verification status

What has been checked against a live system, and what is still an assumption, lives in
[verification.md](verification.md) — grouped by status, blocking items first.

Three are blocking and worth naming here: the exact bytes signed under `nep413` / `raw_ed25519`, that
the router account id is registered and controlled by us, and that solvers quote ETH→ZEC at our
tranche size at all. The last one can invalidate the whole design, so test it first.
