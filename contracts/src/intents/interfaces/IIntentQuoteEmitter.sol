// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentQuoteEmitter — standing authorizations for NEAR-Intents routes
/// @notice Publishes the terms a NEAR account is derived from, once per route rather than once per
///         quote. Publishing reads no storage and moves no value.
///
/// @dev Owns its Wormhole emitter address. `IntentReceiver` pins the emitter it accepts forwarding
///      instructions from, so terms published here are not instructions to it.
interface IIntentQuoteEmitter {
    // ─── Types ───────────────────────────────────────────────────

    /// @notice Terms of a standing authorization: "any balance in the account these terms derive may
    ///         be swapped to `destinationAsset` and delivered to `recipient`".
    /// @param quoteId Namespace value, unique per schedule — meaningless to the router, but it keeps
    ///        two schedules sharing every other term on disjoint accounts. Reuse merges balances.
    /// @param maxSlippageBps Tolerance the destination applies to the solver's quoted output.
    /// @param recipientKind 0 = withdraw off NEAR to `recipient`; 1 = `recipient` is a NEAR intents
    ///        account and the funds stay there.
    /// @param destinationAsset Intents token id to acquire, e.g. `nep141:zec.omft.near`
    /// @param recipient Final destination address. The value the whole design protects.
    /// @dev The NEAR account is absent by design: it is derived *from* these terms, so the router
    ///      recomputes it. See docs/intents/schema.md §1.
    struct Quote {
        bytes32 quoteId;
        uint16 maxSlippageBps;
        uint8 recipientKind;
        string destinationAsset;
        string recipient;
    }

    // ─── Events ──────────────────────────────────────────────────

    /// @param authPath Hash of the terms — the MPC derivation path, and the join key for indexers
    /// @param publisher Whoever paid to publish. Carries no authority: the terms decide the
    ///        account, so publishing someone else's quote is a favour, not an attack.
    /// @param quoteId The publisher's namespace value, echoed to tie an account to its schedule
    /// @param recipient Final destination, echoed for indexing
    /// @param messageSequence Wormhole core sequence of the published authorization
    /// @dev `recipient` is echoed despite being recoverable from the VAA, so the log stands alone as
    ///      an audit trail: every path this contract ever emitted, beside the destination it commits
    ///      to, without parsing a VAA to check.
    event QuotePublished(
        bytes32 indexed authPath,
        address indexed publisher,
        bytes32 indexed quoteId,
        string recipient,
        uint64 messageSequence
    );

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error InvalidMessageFee(uint256 required, uint256 provided);
    // Term validation lives in `IntentCodec`, which declares its own errors — those checks are what
    // make the encoding unambiguous, so they belong welded to the encoder rather than duplicated by
    // every caller.

    // ─── Authorization ───────────────────────────────────────────

    /// @notice Publish a standing authorization for one route.
    /// @dev Permissionless and stateless: the path hashes the recipient, so publishing someone
    ///      else's terms derives *their* account and can only pay *them*. Republishing is harmless.
    ///      `msg.value` must be exactly the message fee — native here is WETH, so an approximate one
    ///      would be paid out of swap dust.
    /// @return authPath The derivation path these terms hash to
    /// @return messageSequence Wormhole core sequence of the authorization message
    function publishQuote(Quote calldata quote)
        external
        payable
        returns (bytes32 authPath, uint64 messageSequence);

    /// @notice The MPC derivation path a set of terms hashes to. Turn this into the NEAR account and
    ///         its bridge deposit address off-chain, before publishing.
    /// @dev Hashes every field, so the path commits to the whole quote.
    function computeAuthPath(Quote calldata quote) external pure returns (bytes32);

    /// @notice The exact bytes `publishQuote` would publish for these terms.
    /// @dev Pins the off-chain encoder and the router's decoder against this one — a hash mismatch
    ///      says only that something diverged, the bytes say which field.
    function computeTerms(Quote calldata quote) external pure returns (bytes memory);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
