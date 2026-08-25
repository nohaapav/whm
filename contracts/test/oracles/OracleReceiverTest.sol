// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageReceiver} from "../../src/MessageReceiver.sol";
import {OracleReceiver} from "../../src/oracles/OracleReceiver.sol";
import {MockWormhole} from "../mocks/MockWormhole.sol";

contract MockManagedOracle {
    int256 public lastPrice;
    uint256 public callCount;

    function setPrice(int256 price) external {
        lastPrice = price;
        callCount++;
    }
}

contract OracleReceiverTest is Test, MockWormhole {
    event MessageReceived(uint16 sourceChain, string message);
    event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp);

    OracleReceiver public receiver;
    address public wormhole = address(this);
    uint16 public sourceChain = 14;
    bytes32 public sourceAddress = bytes32(uint256(0xabc123));

    function setUp() public {
        OracleReceiver impl = new OracleReceiver();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(OracleReceiver.initialize, (wormhole)));
        receiver = OracleReceiver(address(proxy));
        receiver.setAuthorizedEmitter(sourceChain, sourceAddress);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _buildVaa(bytes memory payload) internal view returns (bytes memory) {
        return abi.encode(sourceChain, sourceAddress, payload);
    }

    function _buildVaaWithHash(bytes memory payload, bytes32 salt) internal view returns (bytes memory) {
        return abi.encode(sourceChain, sourceAddress, payload, salt);
    }

    // ─── Tests ───────────────────────────────────────────────────

    function testRoutesPriceUpdate() public {
        bytes32 assetId = keccak256("PRIME");
        uint256 price = 1_234_000_000_000_000_000;
        uint64 timestamp = uint64(block.timestamp);
        MockManagedOracle oracle = new MockManagedOracle();

        receiver.setOracle(assetId, address(oracle));

        bytes memory payload = abi.encode(uint8(1), assetId, price, timestamp);

        receiver.receiveMessage(_buildVaa(payload));

        (uint256 storedPrice, uint64 storedTimestamp, uint64 receivedAt) = receiver.latestPrices(assetId);
        assertEq(storedPrice, price);
        assertEq(storedTimestamp, timestamp);
        assertEq(receivedAt, uint64(block.timestamp));
    }

    function testForwardsScaledPriceToOracle() public {
        MockManagedOracle oracle = new MockManagedOracle();
        bytes32 assetId = keccak256("PRIME");
        uint256 priceWith18Decimals = 1_016_434_800_000_000_000; // 1.0164348 * 1e18
        uint64 timestamp = uint64(block.timestamp);

        receiver.setOracle(assetId, address(oracle));

        bytes memory payload = abi.encode(uint8(1), assetId, priceWith18Decimals, timestamp);

        receiver.receiveMessage(_buildVaa(payload));

        assertEq(oracle.callCount(), 1);
        assertEq(oracle.lastPrice(), int256(uint256(101_643_480)));
    }

    function testRevertsWhenOracleNotSet() public {
        bytes32 assetId = keccak256("PRIME");
        bytes memory payload = abi.encode(uint8(1), assetId, uint256(1e18), uint64(block.timestamp));

        vm.expectRevert(abi.encodeWithSelector(OracleReceiver.OracleNotSet.selector, assetId));
        receiver.receiveMessage(_buildVaa(payload));
    }

    function testRoutesDefaultMessage() public {
        string memory message = "hello hydration";

        vm.expectEmit(address(receiver));
        emit MessageReceived(sourceChain, message);

        bytes memory payload = abi.encode(message, address(0xBEEF));

        receiver.receiveMessage(_buildVaa(payload));
    }

    function testSetOracle() public {
        bytes32 assetId = keccak256("PRIME");
        receiver.setOracle(assetId, address(0xBEEF));
        assertEq(receiver.oracles(assetId), address(0xBEEF));
    }

    function testOnlyOwnerCanSetOracle() public {
        vm.prank(address(0xdead));
        vm.expectRevert(MessageReceiver.NotOwner.selector);
        receiver.setOracle(keccak256("PRIME"), address(0xBEEF));
    }

    function testRejectsReplayInReceiveMessage() public {
        bytes memory payload = abi.encode("hello hydration");
        bytes memory vaa = _buildVaa(payload);

        receiver.receiveMessage(vaa);

        vm.expectRevert("VAA already processed");
        receiver.receiveMessage(vaa);
    }

    function testRejectsOlderPriceUpdate() public {
        MockManagedOracle oracle = new MockManagedOracle();
        bytes32 assetId = keccak256("PRIME");
        receiver.setOracle(assetId, address(oracle));

        // Updates are ordered by the Wormhole envelope timestamp (block.timestamp in the mock).
        vm.warp(1000);
        bytes memory newerPayload = abi.encode(uint8(1), assetId, uint256(2_000_000_000_000_000_000), uint64(1000));
        receiver.receiveMessage(_buildVaa(newerPayload));

        // Rewind the envelope clock: this VAA is now older than the stored update.
        vm.warp(999);
        bytes memory olderPayload = abi.encode(uint8(1), assetId, uint256(1_000_000_000_000_000_000), uint64(999));
        vm.expectRevert(
            abi.encodeWithSelector(OracleReceiver.StalePriceUpdate.selector, assetId, uint64(999), uint64(1000))
        );
        receiver.receiveMessage(_buildVaaWithHash(olderPayload, bytes32("salt")));
    }

    /// @notice The envelope stamp comes from the source chain, whose block clock drifts either side
    ///         of Hydration's. Leading it must read as fresh rather than underflow the age check.
    function testAcceptsVaaStampedAheadOfLocalClock() public {
        MockManagedOracle oracle = new MockManagedOracle();
        bytes32 assetId = keccak256("PRIME");
        receiver.setOracle(assetId, address(oracle));

        vm.warp(1000);
        vaaTimestampOverride = 1011; // source 11s ahead — measured between Ethereum and Hydration

        bytes memory payload = abi.encode(uint8(1), assetId, uint256(2e18), uint64(1011));
        receiver.receiveMessage(_buildVaa(payload));

        (, uint64 storedTimestamp,) = receiver.latestPrices(assetId);
        assertEq(storedTimestamp, 1011, "envelope stamp must be stored");
        assertEq(oracle.callCount(), 1, "price must reach the oracle");
    }

    /// @notice Widening the age check forward must not loosen it backward.
    function testStillRejectsPriceOlderThanMaxAge() public {
        MockManagedOracle oracle = new MockManagedOracle();
        bytes32 assetId = keccak256("PRIME");
        receiver.setOracle(assetId, address(oracle));

        vm.warp(2000);
        vaaTimestampOverride = 1000; // 1000s old against the default 300s window

        bytes memory payload = abi.encode(uint8(1), assetId, uint256(2e18), uint64(1000));
        vm.expectRevert("Price too stale");
        receiver.receiveMessage(_buildVaa(payload));
    }
}
