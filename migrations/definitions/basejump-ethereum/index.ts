import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump, Ethereum -> Hydration direct corridor. Both ends in one migration.
 *
 * Two contracts, one per role: BasejumpEmitter on Ethereum, BasejumpReceiver on Hydration.
 * Mirrors basejump-base step for step; only constants differ — chain (Ethereum, wormhole id 2)
 * and token (USDC 6dp, hub-side so the manager is LOCKING).
 *
 *   001 deploy BasejumpEmitter (UUPS proxy) on Ethereum
 *   002 set the Hydration landing @emitter
 *   003 set the USDC NttManager @emitter
 *   004 set the USDC fee @emitter
 *   005 deploy BasejumpReceiver (UUPS proxy) on Hydration
 *   006 authorize the Ethereum emitter @receiver          <- go-live switch
 *   007 point the receiver at the landing
 *   008 transfer receiver ownership to the Hydration TC
 *   009 transfer emitter ownership to the Ethereum TC Safe
 *
 * ONE RECEIVER PER CORRIDOR, not one shared across all of them. MessageReceiver.authorizedEmitters
 * is keyed by source chain, so a single receiver could serve every leg — but then this migration
 * would have to env-copy that receiver's address in, and its go-live switch would be a TC call
 * carrying a hand-pasted emitter address. Two manual copies on the one call that arms the corridor.
 * Deploying our own keeps both ends wired from ctx.outputs, so they cannot diverge, and makes the
 * migration self-contained: it does not depend on basejump-base having run.
 *
 * The cost is that the landing must authorize this receiver — see the TC actions below. A shared
 * receiver would need no such call, so a corridor now DOES add trust surface on the pool. The
 * landing does not scope a bridge to an asset (`transfer` reads destAssetFor for whatever source
 * asset it is handed), so this receiver gains authority over the whole pool, EURC included. Same
 * code as every other receiver and it only acts on VAAs from the emitter authorized in 006, so the
 * added surface is one more instance of an audited contract, not a new kind of trust.
 *
 * TWO TC ACTIONS SIT OUTSIDE THIS MIGRATION, both on Hydration, both owner-gated on the landing.
 * Until they land the corridor stays dark, so this migration is safe to run in full first:
 *
 *   1. landing.setAuthorizedBridge(<005-deploy-receiver.proxyAddress>, true)
 *   2. landing.setDestAsset(<eth USDC>, <hydration asset 21>)
 *
 * Both are what `contracts/scripts/basejump-landing/addRoute.ts` prints calldata for; it reads
 * USDC_SOURCE_ASSET / USDC_DEST_ASSET and takes the receiver via --bridge.
 *
 * NOT COVERED HERE, and required before the corridor carries value:
 *   - The pool must hold USDC (asset 21). It currently holds only EURC (asset 44) — one pool,
 *     per-asset balances, and `destAssetFor` is per source asset. Fund before go-live.
 *   - Nothing relays the fast path. See docs/basejump/spec.md "Relaying".
 *   - The relayer's NTT_ROUTES already carries the USDC Ethereum -> Hydration settlement leg, so
 *     the settlement rail needs no change.
 *
 * Required PK env vars:
 *   PK_ETHEREUM  — Ethereum deployer
 *   PK_HYDRATION — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/basejump-ethereum.env
 */
const config: MigrationConfig = {
  name: "basejump-ethereum",
  description: "Deploy the direct Ethereum -> Hydration Basejump corridor (USDC source)",
  pks: ["PK_ETHEREUM", "PK_HYDRATION"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      ethereum: wallet.getWallet(
        required("RPC_ETHEREUM"),
        Number(required("CHAIN_ID_ETHEREUM")),
        env.PK_ETHEREUM as `0x${string}`,
      ),
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK_HYDRATION as `0x${string}`,
      ),
    };
  },
};

export default config;
