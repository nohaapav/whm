# Archived deployment records

Write-once audit records for deployments that are **no longer part of any live path**. Nothing here
is ever resumed: the runner only reads `deployments/<context>/<migration>.json`, so a record moved
here is out of its reach by construction. Kept for provenance — addresses, wiring calls and
timestamps of what was deployed and when.

Two reasons a record lands here:

**Moonbeam / MRL era.** Every corridor used to hop through Moonbeam (`BasejumpProxy`,
`OracleDispatcher`, `XcmTransactor`, the intents MDA + Wormhole TokenBridge). Hydration now has its
own Wormhole core and NTT managers, so all of it is dead. The contracts stay on chain, owned by their
committees, disarmed rather than deleted.

| Record | What it deployed |
| --- | --- |
| `basejump-base.json` | Base → Moonbeam → Hydration corridor (Base `Basejump`, Moonbeam `BasejumpProxy`, `XcmTransactor`, Hydration `BasejumpLanding`). The **landing it created is still live and holds the EURC pool** — the direct corridor reuses it. |
| `basejump-ethereum.json` | Same shape for the Ethereum → Hydration corridor. |
| `oracle-relay-solana.json` | Solana `OracleEmitter` + Moonbeam `OracleDispatcher` + `XcmTransactor`. The Solana emitter is still live; only the Moonbeam half is dead. |
| `oracle-relay-ethereum.json` | Ethereum `OracleEmitter` + its own Moonbeam dispatcher/transactor pair. Same split. |
| `nintent-ethereum.json` | Hydration `IntentEmitterWtt` — swapped to WETH and bridged via the Moonbeam MDA + TokenBridge. |
| `nintent-ethereum-alpha.json` | The pooled BJP intents alternative (`BasejumpProxy`, `BasejumpLandingNative`, `IntentRouter`) plus the Ethereum `IntentReceiver`. |

**Superseded by a fresh deploy.**

| Record | Why |
| --- | --- |
| `basejump-base-ntt.json` | First direct Base source (`0x9c007310c2972f656bc4903a16f936fc0cfbc4d2`, 2026-08-17). Ownership handover never ran and the Hydration end was never deployed; it was replaced by a fresh deploy that drops the unused `tokenBridge` slot. Disarmed with `setLandingDest(0)` — it is armed otherwise, and a call would settle gross into the pool with no receiver to pay the sender. |
