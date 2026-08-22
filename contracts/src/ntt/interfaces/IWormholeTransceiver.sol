// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IWormholeTransceiver — NTT's Wormhole transceiver, destination side
/// @dev Hand-written: the pinned Solidity SDK ships no NTT interfaces. Signatures match
///      hydration-ntt evm/src/interfaces/{IWormholeTransceiver,IWormholeTransceiverState}.sol at
///      NTT_COMMIT 0f19d43f7ae88adf36e62364d4157db8da7a68ee (deployment version 2.0.0).
interface IWormholeTransceiver {
    /// @notice Verify a transfer VAA and hand it to the manager, which releases to the recipient the
    ///         message names.
    /// @dev Permissionless and the expensive half of a delivery — it verifies every guardian
    ///      signature. Reverts if the VAA was already consumed.
    function receiveMessage(bytes memory encodedMessage) external;

    /// @notice Whether a VAA has already been consumed by this transceiver.
    function isVAAConsumed(bytes32 hash) external view returns (bool);
}
