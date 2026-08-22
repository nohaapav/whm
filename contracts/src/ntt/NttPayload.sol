// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {BytesParsing} from "wormhole-solidity-sdk/libraries/BytesParsing.sol";

/// @title NttPayload — the one field an intent settlement is matched on
/// @dev Mirrors `TransceiverStructs.parseTransceiverMessage` + `parseNttManagerMessage` from
///      hydration-ntt at NTT_COMMIT 0f19d43f7ae88adf36e62364d4157db8da7a68ee, reading only as far as
///      the manager's message id. Field by field, using the same `BytesParsing` primitives NTT does.
library NttPayload {
    using BytesParsing for bytes;

    /// @notice The Wormhole transceiver's payload prefix.
    bytes4 internal constant WH_TRANSCEIVER_PAYLOAD_PREFIX = 0x9945FF10;

    error InvalidPrefix(bytes4 prefix);

    /// @notice The manager's sequence for a settlement — `NttManager.transfer`'s return value, which
    ///         the manager writes as `bytes32(uint256(sequence))`.
    /// @param payload A Wormhole transceiver VAA's payload.
    function sequenceOf(bytes memory payload) internal pure returns (uint64) {
        uint256 offset = 0;

        bytes4 prefix;
        (prefix, offset) = payload.asBytes4Unchecked(offset);
        if (prefix != WH_TRANSCEIVER_PAYLOAD_PREFIX) revert InvalidPrefix(prefix);

        (, offset) = payload.asBytes32Unchecked(offset); // sourceNttManagerAddress
        (, offset) = payload.asBytes32Unchecked(offset); // recipientNttManagerAddress
        (, offset) = payload.asUint16Unchecked(offset); // nttManagerPayload length

        bytes32 id;
        (id, offset) = payload.asBytes32Unchecked(offset);
        return uint64(uint256(id));
    }
}
