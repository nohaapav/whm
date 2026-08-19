// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IBasejumpReceiver — destination end of a direct EVM → Hydration corridor
/// @notice Verifies a fast-path VAA and delivers it through the landing pool on the same chain.
///         Declares no outbound entrypoint: a receiver cannot bridge, enforced by the compiler
///         rather than by configuration.
interface IBasejumpReceiver {
    // ─── Events ──────────────────────────────────────────────────

    event TransferProcessed(address indexed sourceAsset, uint256 amount, bytes32 indexed recipient);

    // ─── Errors ──────────────────────────────────────────────────

    error LandingNotSet();

    // ─── Functions ───────────────────────────────────────────────

    /// @notice Verify a fast-path VAA and pay the recipient out of the landing pool.
    /// @dev Delivery is same-chain and atomic: a landing revert unwinds the whole call, leaving the
    ///      VAA unconsumed for the relayer to retry.
    function completeTransfer(bytes memory vaa) external;
}
