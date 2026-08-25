import { pad } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentReceiverJson from "../../../contracts/out/IntentReceiver.sol/IntentReceiver.json";

const step: MigrationStep = {
  name: "005-set-emitter@receiver",
  description: "Pin the Hydration IntentEmitter the receiver accepts instructions from",
  action: async (ctx) => {
    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const receiver = ctx.outputs["002-deploy-receiver"].proxyAddress as `0x${string}`;

    // Wormhole addresses are 32 bytes — left-pad the 20-byte EVM address.
    const emitterAddress = pad(emitter, { size: 32 });

    const { walletClient, publicClient } = ctx.wallet.ethereum;
    const { abi } = intentReceiverJson as ifs.ContractArtifact;

    // Until this lands the receiver reverts NotConfigured, so the corridor stays dark.
    const txHash = await walletClient.writeContract({
      address: receiver,
      abi,
      functionName: "setEmitter",
      args: [emitterAddress],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, receiver, emitter, emitterAddress };
  },
};

export default step;
