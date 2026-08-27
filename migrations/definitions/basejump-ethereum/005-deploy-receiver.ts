import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump-receiver/deploy";

const step: MigrationStep = {
  name: "005-deploy-receiver",
  description: "Deploy BasejumpReceiver UUPS proxy on Hydration",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deploy({
      ...ctx.wallet.hydration,
      wormholeId: Number(required("WORMHOLE_ID_HYDRATION")),
      wormholeCore: required("WORMHOLE_CORE_HYDRATION") as `0x${string}`,
    });
  },
};

export default step;
