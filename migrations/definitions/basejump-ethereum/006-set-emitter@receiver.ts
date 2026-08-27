import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/basejump-receiver/setAuthorizedEmitter";

const step: MigrationStep = {
  name: "006-set-emitter@receiver",
  description: "Authorize the Ethereum emitter as fast-path source",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    // Read from step 001, not env: a fresh deployment is a NEW Wormhole emitter, and an
    // env-copied address could authorize one that does not exist on this context. This is the
    // go-live switch — a per-corridor receiver keeps it inside the migration instead of leaving
    // it as a hand-pasted TC call.
    const sourceEmitter = ctx.outputs["001-deploy-emitter"].proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet.hydration,
      receiverAddress: ctx.outputs["005-deploy-receiver"].proxyAddress as `0x${string}`,
      emitterChain: Number(required("WORMHOLE_ID_ETHEREUM")),
      emitter: pad(sourceEmitter as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
