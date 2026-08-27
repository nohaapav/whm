import { BaseError, ContractFunctionRevertedError } from "viem";

/** Custom-error names meaning the work is already done — ours and NTT's. Matched whole. */
const DONE_ERRORS = new Set(["AlreadyRedeemed", "TransferAlreadyCompleted"]);

/**
 * Require-string reverts meaning the same. The token bridge and NTT revert with strings, which
 * arrive prefixed by the contract that raised them, so these match as fragments.
 */
const DONE_REASONS = ["transfer already completed", "already been redeemed", "VAA already processed"];

/**
 * The revert's own name: a custom error's name, or the string behind a require.
 *
 * Never match against a serialized error: viem attaches the contract ABI to it, so an ABI that
 * declares `error AlreadyRedeemed()` makes every revert — the transient ones included — look like a
 * completed transfer, and the failure is reported as a success.
 *
 * @param e Whatever the call threw.
 * @returns The name or reason, or undefined when it did not revert at all.
 */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  // A require string decodes as the builtin Error(string): `errorName` is literally "Error" and the
  // message lives in `reason`. Custom errors carry their own name.
  const name = revert.data?.errorName;
  return name && name !== "Error" ? name : revert.reason;
}

/**
 * Whether a revert means the work is already done rather than failed.
 *
 * Two places ask: the queue when a submission reverts, and the intent app when its gas estimate
 * does. Both are real calls against real state, so both meet the same reverts.
 *
 * @param name The revert name from `revertName`.
 * @returns True only when a retry could not change the outcome.
 */
export function isDone(name: string | undefined): boolean {
  if (!name) return false;
  return DONE_ERRORS.has(name) || DONE_REASONS.some((reason) => name.includes(reason));
}
