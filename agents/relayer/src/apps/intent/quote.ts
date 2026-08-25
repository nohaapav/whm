import { GAS_LIMIT, QUOTER_URL } from "./config";

/**
 * Ask the quoter what forwarding costs on Ethereum.
 *
 * `marginBps=0` asks for the relayer's real cost: the headroom buffer lives on the user's
 * `maxRelayFee`, sized by the UI, so the two must not compound. The fee is native ETH because that
 * is what the receiver holds and pays out.
 *
 * @returns The fee to claim, in wei.
 * @throws When the quoter is unreachable or errors — the caller retries with backoff.
 */
export async function quoteRelayFee(): Promise<bigint> {
  const url =
    `${QUOTER_URL}/relay-fee?chain=ethereum&feeAsset=native` +
    `&gasLimit=${GAS_LIMIT}&marginBps=0`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`quoter ${res.status}: ${await res.text()}`);

  const { feeRequested } = (await res.json()) as { feeRequested: string };
  return BigInt(feeRequested);
}
