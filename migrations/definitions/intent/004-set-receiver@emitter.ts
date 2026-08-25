import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentEmitterJson from "../../../contracts/out/IntentEmitter.sol/IntentEmitter.json";

const step: MigrationStep = {
  name: "004-set-receiver@emitter",
  description: "Address the emitter's settlements to the Ethereum IntentReceiver",
  action: async (ctx) => {
    // Read from the deploy step, not env — the two ends cannot diverge that way.
    const receiver = ctx.outputs["002-deploy-receiver"].proxyAddress as `0x${string}`;
    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;

    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentEmitterJson as ifs.ContractArtifact;

    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setIntentReceiver",
      args: [receiver],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, receiver };
  },
};

export default step;
