import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentReceiverJson from "../../../contracts/out/IntentReceiver.sol/IntentReceiver.json";

const step: MigrationStep = {
  name: "006-authorize-relayer-1@receiver",
  description: "Grant relayer 1 the exclusive window on processOrder",
  action: async (ctx) => {
    const relayer = ctx.env.RELAYER_1;
    if (!relayer || !isAddress(relayer)) {
      throw new Error(`Missing or invalid RELAYER_1: ${relayer}`);
    }

    const receiver = ctx.outputs["002-deploy-receiver"].proxyAddress as `0x${string}`;

    const { walletClient, publicClient } = ctx.wallet.ethereum;
    const { abi } = intentReceiverJson as ifs.ContractArtifact;

    // First grant switches the window on for everyone else, so processOrder stops being a free
    // opportunity for anyone reading the mempool. Revoking the last one reopens it.
    const txHash = await walletClient.writeContract({
      address: receiver,
      abi,
      functionName: "setAuthorizedRelayer",
      args: [relayer as `0x${string}`, true],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === "reverted") throw new Error(`setAuthorizedRelayer reverted in ${txHash}`);

    return { txHash, receiver, relayer };
  },
};

export default step;
