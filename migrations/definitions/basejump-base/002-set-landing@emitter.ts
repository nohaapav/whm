import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setLanding } from "../../actions/basejump-emitter/setLanding";

const step: MigrationStep = {
  name: "002-set-landing@emitter",
  description: "Point NTT settlement at the Hydration landing pool",
  action: async (ctx) => {
    const landing = ctx.env.HYDRATION_LANDING;
    if (!landing || /^0x0+$/.test(landing)) {
      throw new Error("HYDRATION_LANDING is unset or zero — it is the existing Hydration pool");
    }

    return await setLanding({
      ...ctx.wallet.base,
      emitterAddress: ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`,
      landing: pad(landing as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
