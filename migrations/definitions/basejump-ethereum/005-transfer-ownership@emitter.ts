import type { MigrationStep } from "./types";
import { setOwner } from "../../actions/setOwner";

const step: MigrationStep = {
  name: "005-transfer-ownership@emitter",
  description: "Transfer ownership to the Ethereum Technical Committee Safe",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setOwner({
      ...ctx.wallet.ethereum,
      contract: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      newOwner: required("ETHEREUM_TC_SAFE") as `0x${string}`,
    });
  },
};

export default step;
