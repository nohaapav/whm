// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

library HydrationConsts {
    uint32 internal constant PARA_ID = 2034;

    /// @notice Wormhole chain id — the id used in VAAs and NTT routes. Hydration has three distinct
    ///         identifiers: this one (73), the EVM chain id (222222), and the para id (2034).
    uint16 internal constant WORMHOLE_CHAIN_ID = 73;

    /// @notice Dispatch precompile (0x0401) — executes a SCALE-encoded runtime call as the caller.
    address internal constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;

    // --- Native asset ids ---
    uint32 internal constant WETH_ID = 20;

    /// @notice Asset id → ERC20-precompile address: 0x0100000000 | assetId.
    function toErc20(uint32 assetId) internal pure returns (address) {
        return address((uint160(1) << 32) | uint160(assetId));
    }

    /// @notice ERC20-precompile address → Asset id: low 4 bytes.
    /// @dev Assumes a valid asset-precompile address; the 0x0100000000 prefix is not checked.
    function toAssetId(address erc20) internal pure returns (uint32) {
        return uint32(uint160(erc20));
    }
}

