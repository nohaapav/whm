# SPEC — VAA-authorized DCA into NEAR Intents

Status: design, not yet implemented. Written 2026-08-21.

Supersedes the phase-1 flow in [`../spec.md`](../spec.md), which quotes 1Click per
swap with a user present. This document covers the automated (DCA) case, where no
user is present per tranche.

Hydration runs an on-chain DCA. Each tranche bridges ETH to NEAR and must be
swapped into a destination asset (ZEC) and withdrawn to an address the user
committed once, at DCA creation. No per-tranche user signature. An off-chain bot
may relay, but a fully compromised bot must not be able to redirect funds.

---

## 1. Why the obvious designs fail

Recorded so an implementer does not re-litigate them. All four were tested
against the live APIs.

| Approach | Why it fails |
|---|---|
| Fresh 1Click quote per tranche | Requires an HTTP call inside an on-chain schedule's critical path. Whoever mints the address chooses `recipient`, so a compromised minter redirects funds at the source. |
| Pre-mint N deposit addresses at DCA creation | `minAmountOut` is frozen at quote creation, so late tranches execute against a stale floor and refund instead of filling. Also incompatible with rolling (unbounded-N) DCA. |
| Reuse one 1Click deposit address | Addresses are non-deterministic. Byte-identical requests return different addresses in all three deposit modes, so nothing can re-derive one. |
| `ANY_INPUT` collector | Rejected by product: sweeps only once a pool clears $1,000 USD. Also `INTENTS`-only — `400 "ANY_INPUT only supports depositType INTENTS or CONFIDENTIAL_INTENTS"` — so Wormhole cannot deliver to it directly. |
| Bot holds the intents key | `intents.near` has no per-key scoping: *"Every public key registered to an account can sign intents on its behalf."* A key is unbounded authority, so a compromised bot can withdraw anywhere. |

The design below removes the key from every human-operated component.

---

## 2. Architecture

Two independent paths leave Hydration: **funds go to Ethereum, the authorization
message goes to NEAR.** They meet only inside the router.

```
═══ PHASE 1 · dispatch ═══════════════════════════════════════════════════

 HYDRATION  (on-chain, autonomous — no off-chain dependency)
   DCA tranche fires → sell source asset for WETH
     ├── swapAndBridge(…, 0xN) ─────────────────────► VALUE PATH ──┐
     └── publishMessage(IntentOrder) ───────────────► MESSAGE PATH ┼─┐
                                                                   │ │
 ETHEREUM                                          ◄───────────────┘ │
   native ETH lands at 0xN                                           │
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
> for account `A`; sending native ETH there *is* the deposit into NEAR Intents,
> and POA's off-chain watcher does the crediting.
>
> One asset, two ends — POA states the mapping directly:
>
> ```json
> { "defuse_asset_identifier": "eth:1:native",
>   "origin_chain_address":    "native",
>   "near_token_id":           "eth.omft.near",
>   "intents_token_id":        "nep141:eth.omft.near" }
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
   the part after `ed25519:`). Self-registering with `intents.near` — the account id *is*
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
> *compute* anyone's derived public key — the table above computes `attacker.near`'s
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
— it has no policy and cannot refuse anyone, and `intents.near` honours *any*
valid A-signature it is shown. There is no protocol rule saying "this account may
only be spent via `finalize`."

Two layers produce the guarantee, and only the first is cryptographic:

| Layer | Mechanism | Strength |
|---|---|---|
| Who can sign for `A` | MPC derivation is keyed on `(caller, path)`, so only `router.near` derives `K_A`. A call from any other account yields a different key for a different account. | Cryptographic. Stops everyone else. |
| What the router signs | The router's code only builds withdrawals whose `msg` came from a verified VAA. | Code only. As strong as the code plus immutability. |

Layer 2 is the router constraining *itself*, which yields a hard implementation
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

| # | Component | Chain | Notes |
|---|---|---|---|
| 1 | `IntentEmitter` | Hydration EVM | Holds `swapAndBridge` and publishes `IntentOrder` via `coreBridge` (`0x3792a6d6…`, chain id 73, both already in `xc-cfg`). **Its address is what the NEAR router pins** — see `schema.md` §1. |
| 2 | Schedule storage | Hydration | Store `0xN`, `zecRecipient`, tranche params per DCA. `intentDepositAddress` moves from per-call to per-schedule. |
| 3 | `IntentRouter` | NEAR (Rust) | VAA verification, floor enforcement, intent construction, MPC signing, replay protection. |
| 4 | Relay bot | off-chain | Balance polling, solver quoting, `finalize` call, `publish_intent`, status tracking. Holds no key material. |

The bot is the only stateful off-chain piece and it is untrusted by construction.

---

## 5. Sequence, per tranche

1. DCA pallet fires; sells source asset for WETH on Hydration.
2. Emitter calls `swapAndBridge(assetIn, amountIn, minEthOut, maxFeeIn, intentId, 0xN, maxRelayFee)`.
3. Same transaction: `publishMessage(abi-encoded IntentOrder)` → VAA published.
   Only needed once per order; later tranches resubmit the same VAA.
4. Wormhole delivers native ETH to `0xN` on Ethereum.
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
expired quote. The balance *is* the state; individual deposits are never tracked.

### Timing

Only steps 9–11 sit inside the quote's validity window — the bridge latency is
entirely before step 7. MPC signing is seconds. `min_deadline_ms: 120000` is
generous; do **not** request long windows, since a quote valid for `T` is an
option the solver writes and its price scales with `√T` (a 60-minute window costs
roughly 7–8× the time premium of a 60-second one, when solvers answer at all).

---

## 6. Known residual: price integrity

The VAA fixes *destination* integrity. It does not fix *price* integrity.

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

Treat anything not marked **verified** as an assumption to test before writing code.

| Claim | Status |
|---|---|
| POA `deposit_address` is stable and per-account | **verified** — repeated calls identical; distinct per account; works for implicit hex ids |
| Same H160 across EVM chains, token differs by chain | **verified** — `eth:1 → eth.omft.near`, `eth:8453 → base.omft.near`, `eth:42161 → arb.omft.near` |
| Native ETH on `eth:1` maps to `nep141:eth.omft.near`, `min_deposit 1e11` wei | **verified** |
| 1Click deposit addresses are non-deterministic | **verified** — identical requests, different addresses, all three modes |
| `ANY_INPUT` rejects `ORIGIN_CHAIN` | **verified** — explicit 400 from the API |
| `intents.near` has no per-key scoping | **verified** — *"Every public key registered to an account can sign intents on its behalf"* |
| Intent payloads carry a `nonce` (single-use signatures) | **verified** |
| Solver relay endpoint and method shapes | **verified from docs** — `POST https://solver-relay-v2.chaindefuser.com/rpc` |
| Wormhole `coreBridge` configured for Hydration | **verified** — present in `xc-cfg` chain config |
| Exact bytes signed under `nep413` / `raw_ed25519` | **UNVERIFIED — blocking.** See `schema.md` §4. Must be pinned against the verifier's own verification code. A wrong guess is a silent total failure. |
| `v1.signer` is live on NEAR mainnet | **verified** — deployed, `code_hash EM7QrQMdd71hCHFL4RHkYQ2E4jmESpgu85mDZJu8jJJd` |
| `derived_public_key({path, predecessor, domain_id})` shape, `domain_id: 1` → Ed25519 | **verified** — returns e.g. `ed25519:2kbv31BMDHBK54RYMX1gKiSLCXMjWphF9sbxvH4o4D3S` |
| Derivation is keyed on `(predecessor, path)`; a different caller yields a different account | **verified** — same path from `attacker.near` gives a disjoint `A` and `0xN` |
| Full chain `(router, path) → A → 0xN` is deterministic | **verified** — repeated runs identical |
| `SignRequest` field names on `v1.signer.sign` | **UNVERIFIED** — the *view* method takes `domain_id`, but confirm the `sign` request struct (was `key_version`). |
| Router account id is registered and controlled by us | **UNVERIFIED — prerequisite.** `hydration.near` exists but is empty with no contract; confirm we hold its keys. `galacticcouncil.near` is currently unregistered. The id is permanent (see §3) and must be final before the first DCA schedule exists. |
| Solvers quote ETH→ZEC at all, at your tranche size, at 120s | **UNTESTED** — needs a Partner Portal `X-API-Key`; the 1Click distribution JWT is a different credential and returns `result: null`. **Test this first — it can invalidate the whole design.** |
| Hydration emitter can reach `publishMessage` | **UNVERIFIED in code** — core bridge is configured, but arbitrary message publishing from the emitter needs confirming |
| MPC signing latency in practice | **UNVERIFIED** — drives the `min_deadline_ms` choice |
| ZEC withdrawal pattern via `ft_withdraw` | **UNVERIFIED** — confirm the POA withdrawal convention and the ZEC withdrawal fee |

### Suggested order of work

1. Get a solver-relay API key and confirm ETH→ZEC quotes exist at your tranche
   size and window. **If solvers do not cover this pair, stop — nothing else matters.**
2. Pin the signed-bytes construction against the verifier source.
3. Confirm `publishMessage` reachability from the Hydration emitter.
4. Prototype the router's MPC signing path against testnet and measure latency.
5. Decide the upgradeability model (§3).
6. Then build.
