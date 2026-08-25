import { isAddress } from "viem";

import type { MigrationStep } from "./types";
import { deploy } from "../../actions/intent-quote-emitter/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy IntentQuoteEmitter UUPS proxy on Hydration",
  action: async (ctx) => {
    const wormhole = ctx.env.WORMHOLE_CORE_HYDRATION;
    if (!wormhole || !isAddress(wormhole)) {
      throw new Error(`Missing or invalid WORMHOLE_CORE_HYDRATION: ${wormhole}`);
    }

    return await deploy({
      ...ctx.wallet.hydration,
      wormhole: wormhole as `0x${string}`,
    });
  },
};

export default step;
