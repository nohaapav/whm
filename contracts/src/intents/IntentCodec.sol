// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IIntentEmitter} from "./interfaces/IIntentEmitter.sol";

/// @title IntentCodec — the order wire format
/// @notice Packed big-endian. The payload IS the terms, so the NEAR router hashes what it received
///         in full. Packed rather than ABI because the decoder is Rust. Layout and rationale:
///         docs/intents/v2/schema.md §2.
///
///           offset  size  field          offset  size  field
///                0     1  version            36     1  destAssetLen (D)
///                1    32  orderId            37     D  destinationAsset
///               33     2  maxSlippageBps   37+D     1  recipientLen (R)
///               35     1  recipientKind    38+D     R  recipient      total 38 + D + R
///
/// @dev Not under `utils/hydration/` — nothing here is Hydration-specific, and a second source chain
///      would share it unchanged.
library IntentCodec {
    /// @notice Wire version. Inside the hash, so a future layout derives disjoint accounts.
    uint8 internal constant VERSION = 1;

    /// @notice `recipient` is an address on the destination chain; the router withdraws off NEAR.
    uint8 internal constant KIND_WITHDRAW = 0;

    /// @notice `recipient` is a NEAR intents account; the funds stay on NEAR.
    uint8 internal constant KIND_INTENTS_ACCOUNT = 1;

    /// @dev Fixed prefix through `destAssetLen`, i.e. everything before the first string.
    uint256 internal constant ORDER_HEADER_SIZE = 37;

    /// @dev Fixed width — the transfer instruction carries no strings.
    uint256 internal constant TRANSFER_SIZE = 61;

    error InvalidOrderId();
    error InvalidRecipientKind(uint8 kind);
    error InvalidDestinationAsset(uint256 length);
    error InvalidRecipient(uint256 length);
    error InvalidVersion(uint8 version);
    /// @dev Declared lengths do not account for the buffer exactly.
    error MalformedTerms(uint256 length);
    error MalformedTransfer(uint256 length);
    error InvalidDepositAddress();

    // ─── Order ───────────────────────────────────────────────────

    /// @notice The MPC derivation path a set of terms hashes to.
    function authPath(IIntentEmitter.Order calldata o) internal pure returns (bytes32) {
        return keccak256(encodeOrder(o));
    }

    /// @notice Encode an order's terms — the exact bytes published, and the preimage of its path.
    /// @dev Length bounds live here rather than at the call site, so no caller can obtain an
    ///      ambiguous hash: over 255 wraps to zero through the `uint8` cast.
    function encodeOrder(IIntentEmitter.Order calldata o) internal pure returns (bytes memory) {
        bytes memory asset = bytes(o.destinationAsset);
        bytes memory recipient = bytes(o.recipient);

        if (o.orderId == bytes32(0)) revert InvalidOrderId();
        if (o.recipientKind > KIND_INTENTS_ACCOUNT) revert InvalidRecipientKind(o.recipientKind);
        if (asset.length == 0 || asset.length > 255) revert InvalidDestinationAsset(asset.length);
        if (recipient.length == 0 || recipient.length > 255) revert InvalidRecipient(recipient.length);

        return abi.encodePacked(
            VERSION,
            o.orderId,
            o.maxSlippageBps,
            o.recipientKind,
            uint8(asset.length),
            asset,
            uint8(recipient.length),
            recipient
        );
    }

    /// @notice Parse published terms back into an order — the mirror of the router's decoder.
    /// @dev Rejects rather than truncates: a buffer two different orders could hash from is not one
    ///      to read the first of.
    function decodeOrder(bytes memory terms) internal pure returns (IIntentEmitter.Order memory o) {
        if (terms.length < ORDER_HEADER_SIZE) revert MalformedTerms(terms.length);
        if (uint8(terms[0]) != VERSION) revert InvalidVersion(uint8(terms[0]));

        uint256 assetLen = uint8(terms[36]);
        if (assetLen == 0) revert InvalidDestinationAsset(assetLen);

        uint256 recipientLenOffset = ORDER_HEADER_SIZE + assetLen;
        if (terms.length <= recipientLenOffset) revert MalformedTerms(terms.length);

        uint256 recipientLen = uint8(terms[recipientLenOffset]);
        if (recipientLen == 0) revert InvalidRecipient(recipientLen);
        // Read the second length only after the first string, and hold the total to both.
        if (terms.length != recipientLenOffset + 1 + recipientLen) revert MalformedTerms(terms.length);

        bytes32 orderId;
        for (uint256 i = 0; i < 32; i++) {
            orderId |= bytes32(uint256(uint8(terms[1 + i])) << (8 * (31 - i)));
        }

        uint8 recipientKind = uint8(terms[35]);
        if (recipientKind > KIND_INTENTS_ACCOUNT) revert InvalidRecipientKind(recipientKind);

        o = IIntentEmitter.Order({
            orderId: orderId,
            maxSlippageBps: uint16(uint8(terms[33])) << 8 | uint16(uint8(terms[34])),
            recipientKind: recipientKind,
            destinationAsset: string(_slice(terms, ORDER_HEADER_SIZE, assetLen)),
            recipient: string(_slice(terms, recipientLenOffset + 1, recipientLen))
        });
    }

    /// @dev Solidity has no slice for `bytes memory`.
    function _slice(
        bytes memory data,
        uint256 offset,
        uint256 length
    ) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[offset + i];
        }
    }
}
