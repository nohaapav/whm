import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump, Ethereum -> Hydration direct corridor. Source end ONLY.
 *
 * One contract: BasejumpEmitter on Ethereum, settling USDC over NTT into the existing Hydration
 * landing. Nothing is deployed on Hydration — `authorizedEmitters` on BasejumpReceiver is keyed by
 * source chain and Hydration has one landing, so the receiver deployed by `basejump-base` serves
 * this corridor too. See docs/basejump/spec.md "Adding a corridor".
 *
 *   001 deploy BasejumpEmitter (UUPS proxy) on Ethereum
 *   002 set the Hydration landing @emitter
 *   003 set the USDC NttManager @emitter
 *   004 set the USDC fee @emitter
 *   005 transfer ownership to the Ethereum TC Safe
 *
 * Differs from basejump-base only in constants: chain (Ethereum, wormhole id 2), token (USDC 6dp,
 * hub-side so the manager is LOCKING), and the absence of receiver steps.
 *
 * THREE TC ACTIONS SIT OUTSIDE THIS MIGRATION, all on Hydration and all owner-gated. Until they
 * land the corridor stays dark, so this migration is safe to run in full first:
 *
 *   1. receiver.setAuthorizedEmitter(2, pad(<this emitter>))  — go-live switch, TC
 *   2. landing.setDestAsset(<eth USDC>, <hydration asset 21>) — TC
 *   3. landing.setAuthorizedBridge(<receiver>, true)          — TC, already required by
 *                                                               basejump-base; not per-corridor
 *
 * Steps 1-2 are what `contracts/scripts/basejump-landing/addRoute.ts` prints calldata for; it
 * already reads USDC_SOURCE_ASSET / USDC_DEST_ASSET.
 *
 * NOT COVERED HERE, and required before the corridor carries value:
 *   - The pool must hold USDC (asset 21). It currently holds only EURC (asset 44) — one pool,
 *     per-asset balances, and `destAssetFor` is per source asset. Fund before go-live.
 *   - Nothing relays the fast path. See docs/basejump/spec.md "Relaying".
 *   - The relayer's NTT_ROUTES already carries the USDC Ethereum -> Hydration settlement leg, so
 *     the settlement rail needs no change.
 *
 * Required PK env vars:
 *   PK_ETHEREUM — Ethereum deployer
 *
 * Env file: migrations/envs/<context>/basejump-ethereum.env
 */
const config: MigrationConfig = {
  name: "basejump-ethereum",
  description: "Deploy the direct Ethereum -> Hydration Basejump corridor (USDC source)",
  pks: ["PK_ETHEREUM"],

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
    };
  },
};

export default config;
