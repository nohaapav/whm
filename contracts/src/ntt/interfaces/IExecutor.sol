// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IExecutor — Wormhole Executor, the pay-at-source relay marketplace
/// @notice Instead of running a relayer for a route, you buy the destination execution up front: a
///         provider signs a quote off-chain, you pass it to `requestExecution` with the quoted cost as
///         `msg.value`, and an off-chain executor picks up the emitted request, fetches the VAA and
///         submits it on the destination.
/// @dev Hand-written — no Solidity interface ships with the SDK, and the quote/instruction encoders in
///      `common/wormhole/executor.ts` are the off-chain half only. VERIFY THIS SIGNATURE against the
///      deployed Executor before the migration wires an address in, the way INttManager was verified.
interface IExecutor {
    /// @param dstChain Wormhole chain id of the destination.
    /// @param dstAddr Destination contract the executor should call, as a Wormhole 32-byte address.
    /// @param refundAddr Where unused destination gas is returned.
    /// @param signedQuote The provider's signed quote (EQ01). Carries its own expiry.
    /// @param requestBytes The request body identifying what to deliver — for an NTT transfer, an
    ///        `ERN1` request. Produced by the same off-chain step that fetches the quote.
    /// @param relayInstructions Encoded destination gas / drop-off instructions. Must match the
    ///        instructions the quote was priced over, or the executor may decline the job.
    function requestExecution(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        bytes calldata signedQuote,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external payable;
}
