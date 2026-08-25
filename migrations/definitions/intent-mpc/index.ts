import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * IntentQuoteEmitter — standing authorizations for NEAR-Intents routes.
 *
 * Publishes the terms a NEAR account derives from, once per route rather than once per order. Its
 * own deployment because it moves no value, shares no state with the corridor, and must own its
 * Wormhole emitter address — IntentReceiver pins the emitter it accepts forwarding instructions
 * from, so terms published here are not instructions to it.
 *
 *   001 deploy IntentQuoteEmitter (UUPS proxy) on Hydration
 *
 * No wiring steps: nothing on-chain references this contract. The NEAR router trusts its emitter
 * address, which is an off-chain configuration concern.
 *
 * Stays deployer-owned — ownership transfer lands as a later step, so this is not yet a prod-ready
 * end state.
 *
 * Required PK env vars:
 *   PK — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/intent-quote-emitter.env
 */
const config: MigrationConfig = {
  name: "intent-quote-emitter",
  description: "Deploy IntentQuoteEmitter on Hydration",
  pks: ["PK"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK as `0x${string}`,
      ),
    };
  },
};

export default config;
