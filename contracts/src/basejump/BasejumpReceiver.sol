// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {MessageReceiver} from "../MessageReceiver.sol";

import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";
import {IBasejumpPayload} from "./interfaces/IBasejumpPayload.sol";
import {IBasejumpReceiver} from "./interfaces/IBasejumpReceiver.sol";

/// @title BasejumpReceiver — Hydration end of the direct corridor
/// @notice Verifies the fast-path VAA published by a source BasejumpEmitter and delivers it through
///         the landing pool on this chain. Succeeds the MRL-era `BasejumpProxy`: the same
///         receive-and-deliver role, minus the Moonbeam hop and its `XcmTransactor`.
/// @dev Initialized through the inherited `MessageReceiver.initialize(wormhole)`. Delivery is
///      same-chain, so a landing revert unwinds `receiveMessage` and `processedVaas` is never
///      written — no owner power to replay a VAA is needed. `BasejumpProxy.resetProcessedVaa`
///      existed only because XCM could fail *after* the VAA was marked processed, a failure mode
///      the missing hop removes.
contract BasejumpReceiver is MessageReceiver, IBasejumpReceiver, IBasejumpPayload {
    /// @notice Landing pool on this chain.
    bytes32 public landing;

    /// @inheritdoc IBasejumpReceiver
    function completeTransfer(bytes memory vaa) external {
        receiveMessage(vaa);
    }

    // ─── Internal ────────────────────────────────────────────────

    function _processMessage(IWormhole.VM memory vm) internal override {
        if (landing == bytes32(0)) revert LandingNotSet();

        TransferPayload memory transfer = abi.decode(vm.payload, (TransferPayload));

        // `data` is forwarded untouched. The deployed landing discards it (its parameter is
        // commented out), so an inbound-intent corridor — one whose recipient is a Hydration
        // contract that must act on delivery — needs the landing upgraded to invoke a callback.
        // The wire format carries it either way, so that upgrade needs no change on this side.
        IBasejumpLanding(address(uint160(uint256(landing)))).transfer(
            transfer.sourceAsset, transfer.amount, transfer.recipient, transfer.data
        );

        emit TransferProcessed(transfer.sourceAsset, transfer.amount, transfer.recipient);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setLanding(bytes32 _landing) external onlyOwner {
        landing = _landing;
    }
}
