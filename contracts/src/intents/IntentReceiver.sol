// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {IWormholeTransceiver} from "../ntt/interfaces/IWormholeTransceiver.sol";
import {NttPayload} from "../ntt/NttPayload.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";

import {IIntentReceiver} from "./interfaces/IIntentReceiver.sol";

/// @title IntentReceiver — Ethereum end of the NTT intent path
/// @notice One call carries an order the last hop it takes on our side:
///
///           1. MATCH   — the settlement and the emitter's instruction must name the same sequence.
///           2. DELIVER — submit the NTT VAA, releasing native ETH here.
///           3. FORWARD — pay the caller its fee, send the rest to the instruction's depositAddress.
///
///         Atomic, so whoever calls it did all of it and is the one paid. NTT's delivery is
///         permissionless unlike the TokenBridge's payload-3 completion, so a settlement may already
///         be here; that skips step 2 rather than failing.
///
/// @dev Nothing is caller-supplied. The amount, the destination and the fee ceiling all come from a
///      guardian-signed instruction whose emitter is pinned, and the amount must actually have
///      landed here before any of it moves.
contract IntentReceiver is Initializable, UUPSUpgradeable, IIntentReceiver {
    using NttPayload for bytes;

    address public owner;
    IWormhole public wormhole;
    IWormholeTransceiver public transceiver;

    /// @notice The Hydration IntentEmitter, as a Wormhole universal address.
    bytes32 public emitterAddress;

    mapping(bytes32 => bool) public processed;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole, address _transceiver) public initializer {
        owner = msg.sender;
        wormhole = IWormhole(_wormhole);
        transceiver = IWormholeTransceiver(_transceiver);
    }

    /// @notice Accept settlements.
    receive() external payable {}

    // ─── Core ────────────────────────────────────────────────────

    /// @inheritdoc IIntentReceiver
    function processOrder(bytes calldata nttVaa, bytes calldata instructionVaa, uint256 feeRequested)
        external
    {
        if (emitterAddress == bytes32(0)) revert NotConfigured();

        (uint64 sequence, address depositAddress, uint256 amount, uint256 maxRelayFee) =
            _instruction(instructionVaa);

        IWormhole.VM memory settlement = wormhole.parseVM(nttVaa);
        uint64 settled = settlement.payload.sequenceOf();
        if (settled != sequence) revert SequenceMismatch(sequence, settled);

        if (feeRequested > maxRelayFee) revert FeeExceedsCeiling();

        // Skipped when a generic NTT relayer already delivered.
        if (!transceiver.isVAAConsumed(settlement.hash)) {
            transceiver.receiveMessage(nttVaa);
        }

        if (address(this).balance < amount) revert NotFunded(amount, address(this).balance);

        uint256 forwardAmount = amount - feeRequested;

        _pay(depositAddress, forwardAmount);
        emit OrderProcessed(sequence, depositAddress, forwardAmount);

        if (feeRequested > 0) {
            _pay(msg.sender, feeRequested);
            emit RelayFeePaid(sequence, msg.sender, feeRequested);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /// @dev Verify the emitter's instruction, consume it, and read its terms.
    /// @return sequence The settlement this instruction was published with
    /// @return depositAddress Where it forwards
    /// @return amount What the settlement delivers — NTT trims to the precision the emitter already
    ///         quantized to, so the delivery equals this exactly
    /// @return maxRelayFee Ceiling on the caller's claim
    function _instruction(bytes calldata instructionVaa)
        internal
        returns (uint64 sequence, address depositAddress, uint256 amount, uint256 maxRelayFee)
    {
        (IWormhole.VM memory vm, bool valid,) = wormhole.parseAndVerifyVM(instructionVaa);

        if (!valid) revert InvalidInstruction();

        if (
            vm.emitterChainId != HydrationConsts.WORMHOLE_CHAIN_ID ||
            vm.emitterAddress != emitterAddress
        ) {
            revert UnauthorizedEmitter(vm.emitterChainId, vm.emitterAddress);
        }

        if (processed[vm.hash]) revert AlreadyRedeemed();
        processed[vm.hash] = true;

        (sequence, depositAddress, amount, maxRelayFee) =
            abi.decode(vm.payload, (uint64, address, uint256, uint256));
        if (depositAddress == address(0)) revert MalformedInstruction();
    }

    /// @dev Everything this contract moves is native ETH.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Pin the emitter the instructions must come from.
    function setEmitter(bytes32 emitter) external onlyOwner {
        emitterAddress = emitter;
        emit EmitterUpdated(emitter);
    }

    /// @notice Emergency withdrawal.
    function sweep(address to, uint256 amount) external onlyOwner {
        _pay(to, amount);
        emit Swept(to, amount);
    }
}
