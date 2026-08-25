import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump-emitter/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy BasejumpEmitter UUPS proxy on Base",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deploy({
      ...ctx.wallet.base,
      wormholeId: Number(required("WORMHOLE_ID_BASE")),
      wormholeCore: required("WORMHOLE_CORE_BASE") as `0x${string}`,
    });
  },
};

export default step;
