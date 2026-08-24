import type { MigrationStep } from "./types";
import { setNttManager } from "../../actions/basejump-emitter/setNttManager";

const step: MigrationStep = {
  name: "003-set-usdc-ntt-manager@emitter",
  description: "Register the USDC NTT manager as its settlement route",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // setNttManager does NOT verify manager.token() == asset — unlike IntentEmitter's. A wrong
    // address here settles the wrong token and is only visible on the first transfer.
    return await setNttManager({
      ...ctx.wallet.ethereum,
      emitterAddress: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      asset: required("USDC_SOURCE_ASSET") as `0x${string}`,
      manager: required("USDC_NTT_MANAGER") as `0x${string}`,
    });
  },
};

export default step;
