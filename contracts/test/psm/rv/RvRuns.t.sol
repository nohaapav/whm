// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {RvVaultRuns} from "./RvVaultRuns.sol";
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

abstract contract RunsFixture is Test, IHollarBaseVault {
    RvVaultRuns internal vault;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address[3] internal users;
    uint256 internal salt;

    function _boot() internal {
        users = [makeAddr("u0"), makeAddr("u1"), makeAddr("u2")];
        vm.warp(365 days);
        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator agg = new MockAggregator(1e8);
        MockAddressesProvider provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(new MockCappedAdapter(agg)), agg))
        );

        vault = RvVaultRuns(
            address(
                new ERC1967Proxy(
                    address(new RvVaultRuns()),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        VaultInit({
                            wormhole: address(wormhole),
                            usdc: address(usdc),
                            aUsdc: address(aUsdc),
                            addressesProvider: address(provider),
                            hydrationChainId: HYDRATION_CHAIN,
                            minUsdcPrice: 99e6,
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
    }

    function _vaa(address to, uint256 amount, uint256 s) internal pure returns (bytes memory) {
        return VaaBuilder.buildSalted(
            HYDRATION_CHAIN,
            HYDRATION_EMITTER,
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(to), amount),
            s
        );
    }

    function _amount(uint256 i) internal view returns (uint256) {
        (, uint256 a,) = vault.queue(i);
        return a;
    }
}

contract RvRunsFuzz is RunsFixture {
    function setUp() public {
        _boot();
    }

    /// The head reported through the run index must equal the head a brute-force scan finds.
    function _assertHeadMatchesScan() internal {
        uint256 tail = vault.queueTail();
        address want;
        uint256 wantAmt;
        for (uint256 i = vault.queueHead(); i < tail; i++) {
            if (_amount(i) != 0) {
                (address r, uint256 a,) = vault.queue(i);
                want = r;
                wantAmt = a;
                break;
            }
        }
        (address got, uint256 gotAmt) = vault.queueHeadEntry();
        assertEq(got, want, "run index disagrees with a linear scan");
        assertEq(gotAmt, wantAmt, "run index disagrees with a linear scan");
    }

    function testFuzz_runIndexTracksTheScan(uint8[40] calldata ops) public {
        for (uint256 k = 0; k < ops.length; k++) {
            uint256 op = ops[k] % 3;
            if (op == 0) {
                salt++;
                vault.receiveMessage(_vaa(users[ops[k] % 3], 1e6 + (ops[k] % 7) * 1e5, salt));
            } else if (op == 1) {
                uint256 tail = vault.queueTail();
                uint256 want = ops[k] % 5;
                uint256 seen;
                uint256 pick = type(uint256).max;
                for (uint256 i = vault.queueHead(); i < tail; i++) {
                    if (_amount(i) == 0) continue;
                    if (seen == want) {
                        pick = i;
                        break;
                    }
                    seen++;
                }
                if (pick == type(uint256).max) continue;
                (address r,,) = vault.queue(pick);
                vm.prank(r);
                vault.cancelQueuedRedemption(pick);
            } else {
                vault.drain(1);
            }
            _assertHeadMatchesScan();
        }
    }
}

contract RvRunsBrick is RunsFixture {
    uint256 internal constant N = 185_000;
    uint256 internal victim;

    function setUp() public {
        vm.pauseGasMetering();
        _boot();
        vault.receiveMessage(_vaa(users[0], 1e6, 0));
        for (uint256 i = 1; i <= N; i++) {
            vault.receiveMessage(_vaa(users[1], 1, i));
        }
        vm.startPrank(users[1]);
        for (uint256 i = N; i >= 1; i--) {
            vault.cancelQueuedRedemption(i);
        }
        vm.stopPrank();
        victim = N + 1;
        vault.receiveMessage(_vaa(alice, 50_000e6, type(uint256).max));
        vm.resumeGasMetering();
    }

    function test_theSameGraveyardCostsNothingToCross() public {
        vault.drain(1);
        assertEq(vault.queueHead(), 1);

        uint256 g = gasleft();
        vault.drain(1);
        uint256 used = g - gasleft();

        emit log_named_uint("dead slots crossed", N);
        emit log_named_uint("gas for the drain that crosses them", used);
        assertEq(vault.owed(alice), 0, "victim paid");
        assertLt(used, 300_000, "crossing 185k dead slots is O(1)");
    }
}
