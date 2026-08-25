// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {IIntentQuoteEmitter} from "./interfaces/IIntentQuoteEmitter.sol";
import {IntentCodec} from "./IntentCodec.sol";

/// @title IntentQuoteEmitter — standing authorizations for NEAR-Intents routes
/// @notice One entry point: publish the terms a NEAR account derives from. Published once per route,
///         not once per order, so a schedule keeps placing orders against an account that already
///         exists. See docs/intents/{spec,schema}.md.
contract IntentQuoteEmitter is Initializable, UUPSUpgradeable, IIntentQuoteEmitter {
    /// @notice Terms carry no authority of their own — a quote is bound by its path — so they
    ///         publish instantly.
    uint8 public constant CONSISTENCY_INSTANT = 200;

    IWormhole public wormhole;
    address public owner;
    uint32 public nonce;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public initializer {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Authorization ───────────────────────────────────────────

    /// @inheritdoc IIntentQuoteEmitter
    function publishQuote(Quote calldata quote)
        external
        payable
        returns (bytes32 authPath, uint64 messageSequence)
    {
        bytes memory payload = IntentCodec.encodeQuote(quote);

        uint256 fee = wormhole.messageFee();
        if (msg.value != fee) revert InvalidMessageFee(fee, msg.value);

        authPath = keccak256(payload);

        messageSequence = wormhole.publishMessage{value: fee}(nonce, payload, CONSISTENCY_INSTANT);
        nonce++;

        emit QuotePublished(authPath, msg.sender, quote.quoteId, quote.recipient, messageSequence);
    }

    /// @inheritdoc IIntentQuoteEmitter
    function computeAuthPath(Quote calldata quote) external pure returns (bytes32) {
        return IntentCodec.authPath(quote);
    }

    /// @inheritdoc IIntentQuoteEmitter
    function computeTerms(Quote calldata quote) external pure returns (bytes memory) {
        return IntentCodec.encodeQuote(quote);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
