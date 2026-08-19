import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import emitterJson from "../../../contracts/out/BasejumpEmitter.sol/BasejumpEmitter.json";

export type SetLandingParams = WalletContext & {
  emitterAddress: `0x${string}`;
  landing: `0x${string}`;
};

export type SetLandingResult = {
  txHash: string;
  landing: string;
};

export async function setLanding(
  params: SetLandingParams,
): Promise<SetLandingResult> {
  const { publicClient, walletClient, emitterAddress, landing } = params;
  const { abi } = emitterJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: emitterAddress,
    abi,
    functionName: "setLanding",
    args: [landing],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    landing,
  };
}
