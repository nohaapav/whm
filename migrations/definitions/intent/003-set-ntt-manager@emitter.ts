import { isAddress } from "viem";

import type { ifs } from "@whm/common/evm";

import type { MigrationStep } from "./types";

import intentEmitterJson from "../../../contracts/out/IntentEmitter.sol/IntentEmitter.json";

const step: MigrationStep = {
  name: "003-set-ntt-manager@emitter",
  description: "Point the Hydration IntentEmitter at the WETH NttManager",
  action: async (ctx) => {
    const manager = ctx.env.NTT_MANAGER_HYDRATION;
    if (!manager || !isAddress(manager)) {
      throw new Error(`Missing or invalid NTT_MANAGER_HYDRATION: ${manager}`);
    }

    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const { walletClient, publicClient } = ctx.wallet.hydration;
    const { abi } = intentEmitterJson as ifs.ContractArtifact;

    // Reverts SettlementRouteMismatch unless the manager's token is Hydration WETH, so this call
    // also proves the address.
    const txHash = await walletClient.writeContract({
      address: emitter,
      abi,
      functionName: "setNttManager",
      args: [manager as `0x${string}`],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash, emitter, manager };
  },
};

export default step;
