// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentEmitter — Hydration entry point for NEAR-Intents bridging
/// @notice Two independent operations. Neither reads storage, and neither knows about the other:
///
///           publishOrder   once per route — publishes a standing authorization to NEAR
///           placeOrder     per order —  sells an asset for WETH and settles it to an address
///
///         `placeOrder` has no opinion about why an address was chosen, so a derived intents
///         account and a throwaway 1Click quote address are served by the same call. Nothing
///         off-chain is needed when placing one, which is what lets an on-chain scheduler drive it.
interface IIntentEmitter {
    // ─── Types ───────────────────────────────────────────────────

    /// @notice Terms of a standing authorization: "any balance in the account these terms derive may
    ///         be swapped to `destinationAsset` and delivered to `recipient`".
    /// @param orderId Namespace value, unique per schedule — meaningless to the router, but it keeps
    ///        two schedules sharing every other term on disjoint accounts. Reuse merges balances.
    /// @param maxSlippageBps Tolerance the destination applies to the solver's quoted output.
    /// @param recipientKind 0 = withdraw off NEAR to `recipient`; 1 = `recipient` is a NEAR intents
    ///        account and the funds stay there.
    /// @param destinationAsset Intents token id to acquire, e.g. `nep141:zec.omft.near`
    /// @param recipient Final destination address. The value the whole design protects.
    /// @dev The NEAR account is absent by design: it is derived *from* these terms, so the router
    ///      recomputes it. See docs/intents/v2/schema.md §1.
    struct Order {
        bytes32 orderId;
        uint16 maxSlippageBps;
        uint8 recipientKind;
        string destinationAsset;
        string recipient;
    }

    // ─── Events ──────────────────────────────────────────────────

    /// @param authPath Hash of the terms — the MPC derivation path, and the join key for indexers
    /// @param publisher Whoever paid to publish. Carries no authority: the terms decide the
    ///        account, so publishing someone else's order is a favour, not an attack.
    /// @param orderId The publisher's namespace value, echoed to tie an account to its schedule
    /// @param recipient Final destination, echoed for indexing
    /// @param messageSequence Wormhole core sequence of the published authorization
    /// @dev `recipient` is echoed despite being recoverable from the VAA, so the log stands alone as
    ///      an audit trail: every path this contract ever emitted, beside the destination it commits
    ///      to, without parsing a VAA to check.
    event OrderPublished(
        bytes32 indexed authPath,
        address indexed publisher,
        bytes32 indexed orderId,
        string recipient,
        uint64 messageSequence
    );

    /// @param transferSequence The NTT manager's sequence — the key the receiver matches the
    ///        settlement and its instruction on
    /// @param depositAddress Where the receiver forwards, net of the relay fee
    /// @param caller Who placed the order
    /// @param assetIn Hydration asset id sold
    /// @param amountIn Amount of `assetIn` pulled from the caller
    /// @param ethOut ETH the settlement carries — net of both rails' fees, quantized
    /// @param maxRelayFee Ceiling a redeemer may claim on Ethereum
    event OrderPlaced(
        uint64 indexed transferSequence,
        address indexed depositAddress,
        address indexed caller,
        uint32 assetIn,
        uint256 amountIn,
        uint256 ethOut,
        uint256 maxRelayFee
    );

    event Swept(address indexed asset, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotConfigured();
    error ZeroAmount();
    error DispatchFailed();
    error InsufficientOutput();
    error InvalidDepositAddress();
    error SettlementRouteMismatch(address expected, address actual);

    error InvalidMessageFee(uint256 required, uint256 provided);
    // Term validation lives in `IntentOrderCodec`, which declares its own errors — those checks are
    // what make the encoding unambiguous, so they belong welded to the encoder rather than
    // duplicated by every caller.

    /// @dev The swap did not even cover the rail's own delivery price, so nothing would bridge.
    error AmountBelowDeliveryPrice(uint256 ethOut, uint256 deliveryPrice);
    /// @dev What was left after the delivery price is below one unit of the rail's precision.
    error AmountBelowTrimUnit(uint256 ethOut, uint256 trimUnit);
    /// @dev A ceiling that swallows the delivery leaves the receiver nothing to forward.
    error RelayFeeExceedsAmount(uint256 maxRelayFee, uint256 amount);

    // ─── Authorization ───────────────────────────────────────────

    /// @notice Publish a standing authorization for one route.
    /// @dev Permissionless and stateless: the path hashes the recipient, so publishing someone
    ///      else's terms derives *their* account and can only pay *them*. Republishing is harmless.
    ///      `msg.value` must be exactly the message fee — native here is WETH, so an approximate one
    ///      would be paid out of swap dust.
    /// @return authPath The derivation path these terms hash to
    /// @return messageSequence Wormhole core sequence of the authorization message
    function publishOrder(Order calldata order)
        external
        payable
        returns (bytes32 authPath, uint64 messageSequence);

    /// @notice The MPC derivation path a set of terms hashes to. Turn this into the NEAR account and
    ///         its bridge deposit address off-chain, before publishing.
    /// @dev Hashes every field, so the path commits to the whole order.
    function computeAuthPath(Order calldata order) external pure returns (bytes32);

    /// @notice The exact bytes `publishOrder` would publish for these terms.
    /// @dev Pins the off-chain encoder and the router's decoder against this one — a hash mismatch
    ///      says only that something diverged, the bytes say which field.
    function computeTerms(Order calldata order) external pure returns (bytes memory);

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Sell `amountIn` of `assetIn` for WETH and settle it toward `depositAddress` on
    ///         Ethereum, publishing the forwarding instruction beside it.
    /// @param minEthOut Floor on what arrives — after the swap, both rails' fees, and quantization.
    ///        Rounded down to the rail's precision.
    /// @param depositAddress Ethereum recipient. A derived intents account's deposit address, or a
    ///        1Click quote address — this contract cannot tell the two apart and does not try.
    /// @param maxRelayFee Ceiling a redeemer may claim on Ethereum. Committed by the caller rather
    ///        than operator-set: paired with a colluding relayer, a ceiling is a claim on the
    ///        order, so it belongs to whoever's funds are at risk. A schedule stores it beside
    ///        `depositAddress`, so placing one still needs nothing off-chain.
    /// @dev Not payable: both fees come out of the swap output, so a scheduler funds nothing. The
    ///      settlement is addressed to `intentReceiver`, not to `depositAddress` — NTT carries no
    ///      payload, so the destination travels as its own message matched on `transferSequence`.
    /// @return transferSequence The NTT manager's sequence for the settlement
    function placeOrder(
        uint32 assetIn,
        uint256 amountIn,
        uint256 minEthOut,
        address depositAddress,
        uint256 maxRelayFee
    ) external returns (uint64 transferSequence);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
