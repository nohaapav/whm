import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import emitterJson from "../../../contracts/out/BasejumpEmitter.sol/BasejumpEmitter.json";

export type SetNttManagerParams = WalletContext & {
  emitterAddress: `0x${string}`;
  asset: `0x${string}`;
  manager: `0x${string}`;
};

export type SetNttManagerResult = {
  txHash: string;
  asset: string;
  manager: string;
};

export async function setNttManager(params: SetNttManagerParams): Promise<SetNttManagerResult> {
  const { publicClient, walletClient, emitterAddress, asset, manager } = params;
  const { abi } = emitterJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: emitterAddress,
    abi,
    functionName: "setNttManager",
    args: [asset, manager],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, asset, manager };
}
