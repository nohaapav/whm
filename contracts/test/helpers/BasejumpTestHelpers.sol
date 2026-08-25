// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IBasejumpPayload} from "../../src/basejump/interfaces/IBasejumpPayload.sol";

/// @notice Test helper library for Basejump integration tests
/// @dev Provides utilities for VAA generation and common test operations
library BasejumpTestHelpers {
    /// @notice Build a fast-path VAA for Basejump transfers (empty data)
    function buildFastPathVAA(
        uint16 sourceChain,
        address sourceEmitter,
        address sourceAsset,
        uint256 netAmount,
        bytes32 recipient,
        uint64 transferSequence
    ) internal pure returns (bytes memory) {
        return buildFastPathVAA(sourceChain, sourceEmitter, sourceAsset, netAmount, recipient, transferSequence, "");
    }

    /// @notice Build a fast-path VAA for Basejump transfers carrying opaque delivery data
    /// @dev VAA format: abi.encode(emitterChainId, emitterAddress, payload)
    function buildFastPathVAA(
        uint16 sourceChain,
        address sourceEmitter,
        address sourceAsset,
        uint256 netAmount,
        bytes32 recipient,
        uint64 transferSequence,
        bytes memory data
    ) internal pure returns (bytes memory) {
        IBasejumpPayload.TransferPayload memory transfer = IBasejumpPayload.TransferPayload({
            sourceAsset: sourceAsset,
            amount: netAmount,
            recipient: recipient,
            transferSequence: transferSequence,
            data: data
        });

        bytes memory payload = abi.encode(transfer);
        return abi.encode(
            sourceChain,
            bytes32(uint256(uint160(sourceEmitter))),
            payload
        );
    }

    /// @notice Convert an address to bytes32 (for cross-chain addresses)
    /// @param addr Address to convert
    /// @return bytes32 representation (address in lower 20 bytes)
    function addressToBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    /// @notice Convert bytes32 to address (from cross-chain addresses)
    /// @param b bytes32 to convert
    /// @return Address from lower 20 bytes
    function bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }
}
