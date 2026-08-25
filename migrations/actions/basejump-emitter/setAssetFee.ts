import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import emitterJson from "../../../contracts/out/BasejumpEmitter.sol/BasejumpEmitter.json";

export type SetAssetFeeParams = WalletContext & {
  emitterAddress: `0x${string}`;
  asset: `0x${string}`;
  fee: bigint;
};

export type SetAssetFeeResult = {
  txHash: string;
  asset: string;
  fee: string;
};

export async function setAssetFee(params: SetAssetFeeParams): Promise<SetAssetFeeResult> {
  const { publicClient, walletClient, emitterAddress, asset, fee } = params;
  const { abi } = emitterJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: emitterAddress,
    abi,
    functionName: "setAssetFee",
    args: [asset, fee],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    asset,
    fee: String(fee),
  };
}
