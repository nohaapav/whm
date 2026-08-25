# VERIFICATION — Intents

What has actually been checked against a live system, and what is still an assumption. Treat anything
outside the **Verified** section as untested before writing code against it.

## Blocking — resolve before building further

**Exact bytes signed under `nep413` / `raw_ed25519`.** Must be pinned against the verifier's own
verification code — see [schema.md](schema.md) §4. A wrong guess is a silent total failure: signatures
are produced and rejected with nothing to indicate which field diverged.

**Router account id is registered and controlled by us.** `hydration.near` exists but is empty with no
contract, so confirm we hold its keys. `galacticcouncil.near` is currently unregistered. The id is
permanent (see [spec.md](spec.md) §3) and must be final before the first DCA schedule exists, because
every derived account depends on it.

**Solvers quote ETH→ZEC at all** — at our tranche size, within 120s. Needs a Partner Portal
`X-API-Key`; the 1Click distribution JWT is a different credential and returns `result: null`. Test
this first — a negative result invalidates the whole design.

## Unverified

**`SignRequest` field names on `v1.signer.sign`.** The *view* method takes `domain_id`, but the `sign`
request struct needs confirming — it was `key_version`.

**Hydration honours a requested consistency level.** Every chain-73 VAA observed so far is level 202,
which is what the NTT transceivers were deployed with. Nothing has published at 200 from Hydration, so
`CONSISTENCY_INSTANT` is untested on this chain for both `IntentEmitter` and `IntentQuoteEmitter`. 202
is the proven-safe fallback.

**MPC signing latency in practice.** Drives the `min_deadline_ms` choice.

**ZEC withdrawal pattern via `ft_withdraw`.** Confirm the POA withdrawal convention and the ZEC
withdrawal fee.

## Verified

**NEAR / POA addressing.** `deposit_address` is stable and per-account — repeated calls return the
same value, distinct per account, and it works for implicit hex ids. The same H160 appears across EVM
chains with the token differing by chain: `eth:1 → eth.omft.near`, `eth:8453 → base.omft.near`,
`eth:42161 → arb.omft.near`. Native ETH on `eth:1` maps to `nep141:eth.omft.near` with `min_deposit`
of `1e11` wei.

**1Click behaviour.** Deposit addresses are non-deterministic — identical requests return different
addresses across all three modes, which is what rules out the 1Click path for DCA. `ANY_INPUT` rejects
`ORIGIN_CHAIN` with an explicit 400.

**Intents account model.** `intents.near` has no per-key scoping: *"Every public key registered to an
account can sign intents on its behalf."* Intent payloads carry a `nonce`, so signatures are
single-use. The solver relay endpoint and method shapes are confirmed from docs —
`POST https://solver-relay-v2.chaindefuser.com/rpc`.

**MPC derivation.** `v1.signer` is live on NEAR mainnet, `code_hash
EM7QrQMdd71hCHFL4RHkYQ2E4jmESpgu85mDZJu8jJJd`. The `derived_public_key({path, predecessor,
domain_id})` shape works with `domain_id: 1` returning Ed25519 — e.g.
`ed25519:2kbv31BMDHBK54RYMX1gKiSLCXMjWphF9sbxvH4o4D3S`. Derivation is keyed on `(predecessor, path)`,
so the same path from `attacker.near` yields a disjoint `A` and `0xN`. The full chain
`(router, path) → A → 0xN` is deterministic across repeated runs.

**Wormhole.** The `coreBridge` is configured for Hydration, present in the `xc-cfg` chain config.
Guardians sign chain-73 VAAs — 200 live ones sampled from Wormholescan, all signed, the newest hours
old.

## Implemented

**Hydration emitters can reach `publishMessage`.** `IntentQuoteEmitter.publishQuote` and
`IntentEmitter`'s per-order forwarding instruction both publish through the core bridge, covered by
`IntentQuoteEmitterTest` and `IntentEmitterTest`.
