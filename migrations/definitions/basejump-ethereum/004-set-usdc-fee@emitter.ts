import type { MigrationStep } from "./types";
import { setAssetFee } from "../../actions/basejump-emitter/setAssetFee";

const step: MigrationStep = {
  name: "004-set-usdc-fee@emitter",
  description: "Set the per-transfer USDC fee retained by the landing",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setAssetFee({
      ...ctx.wallet.ethereum,
      emitterAddress: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      asset: required("USDC_SOURCE_ASSET") as `0x${string}`,
      fee: BigInt(required("USDC_FEE_AMOUNT")),
    });
  },
};

export default step;
