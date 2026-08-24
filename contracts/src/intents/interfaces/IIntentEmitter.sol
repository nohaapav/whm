// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentEmitter — Hydration entry point for NEAR-Intents bridging
/// @notice One operation: `placeOrder` sells an asset for WETH and settles it to an address on
///         Ethereum, publishing the forwarding instruction beside it.
///
///         It has no opinion about why an address was chosen, so a derived intents account and a
///         throwaway 1Click quote address are served by the same call. Nothing off-chain is needed
///         when placing one, which is what lets an on-chain scheduler drive it.
///
/// @dev The standing authorization a derived account comes from is published by
///      `IntentQuoteEmitter`, which owns its own Wormhole emitter address.
interface IIntentEmitter {

    // ─── Events ──────────────────────────────────────────────────

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

    /// @dev The swap did not even cover the rail's own delivery price, so nothing would bridge.
    error AmountBelowDeliveryPrice(uint256 ethOut, uint256 deliveryPrice);
    /// @dev What was left after the delivery price is below one unit of the rail's precision.
    error AmountBelowTrimUnit(uint256 ethOut, uint256 trimUnit);
    /// @dev A ceiling that swallows the delivery leaves the receiver nothing to forward.
    error RelayFeeExceedsAmount(uint256 maxRelayFee, uint256 amount);

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
