// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IntentEmitter} from "../../src/intents/IntentEmitter.sol";
import {IntentCodec} from "../../src/intents/IntentCodec.sol";
import {IIntentEmitter} from "../../src/intents/interfaces/IIntentEmitter.sol";
import {HydrationConsts} from "../../src/utils/hydration/HydrationConsts.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockNttManager} from "../mocks/MockNttManager.sol";

/// @dev Stands in for the DISPATCH precompile: any call mints the configured WETH to the caller,
///      which is what a successful `router.sell` looks like from the emitter's point of view.
///
///      It mints the native side too. Hydration's native currency *is* WETH (asset 20) — one
///      balance behind two interfaces — and the emitter relies on that to pay the rail's delivery
///      price out of the swap output. Two unrelated mocks cannot share a balance, so the identity
///      is reproduced here with a cheatcode.
contract MockDispatch {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public weth;
    uint256 public out;
    bytes public lastCall;

    function configure(address _weth, uint256 _out) external {
        weth = _weth;
        out = _out;
    }

    fallback() external {
        lastCall = msg.data;
        if (out > 0) {
            MockERC20(weth).mint(msg.sender, out);
            VM.deal(msg.sender, msg.sender.balance + out);
        }
    }
}

/// @dev Records what was published, and can be given a non-zero message fee.
contract MockCoreBridge {
    uint256 public fee;
    uint64 public nextSequence = 42;

    bytes public lastPayload;
    uint32 public lastNonce;
    uint8 public lastConsistency;
    uint256 public lastValue;

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function messageFee() external view returns (uint256) {
        return fee;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64 sequence)
    {
        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistencyLevel;
        lastValue = msg.value;

        sequence = nextSequence;
        nextSequence++;
    }
}

/// @dev The codec is a library, so its reverts are inlined into the caller rather than raised in a
///      subcall — `expectRevert` needs a real call frame to catch. This is that frame.
contract CodecHarness {
    function decode(bytes memory terms) external pure returns (IIntentEmitter.Order memory) {
        return IntentCodec.decodeOrder(terms);
    }
}

/// @title IntentEmitterTest
/// @notice Pins the three properties the design rests on:
///
///           1. the derivation path is a function of the terms, so an authorization can only ever
///              reach the account its own recipient implies;
///           2. placing an order needs nothing from off-chain — no quote, no value, and the rail's
///              delivery price comes out of the swap output;
///           3. what it promises is what the rail can carry (quantization), and `minEthOut` is a
///              floor on what *arrives* rather than on the swap.
contract IntentEmitterTest is Test {
    uint32 constant ASSET_IN = 5; // any non-WETH Hydration asset
    uint256 constant TRIM_UNIT = 1e10;
    uint256 constant DUST = 7 wei;
    /// @dev Deliberately not a multiple of TRIM_UNIT: quantization has to happen *after* the
    ///      delivery price is deducted, and a round fee would hide the difference.
    uint256 constant DELIVERY_PRICE = 2 * TRIM_UNIT + 5;

    IntentEmitter public emitter;
    MockNttManager public nttManager;
    MockCoreBridge public coreBridge;
    MockERC20 public weth;
    MockERC20 public assetIn;
    MockDispatch public dispatch;

    address public user = makeAddr("user");
    address public depositAddress = makeAddr("depositAddress");
    address public intentReceiver = makeAddr("intentReceiver");
    bytes32 public orderId = keccak256("schedule-1");
    bytes32 public authPath;

    /// @dev Zero for most cases: the fee ceiling only matters where a test asserts on it, and a
    ///      non-zero default would have to be subtracted from every quantization assertion.
    uint256 constant MAX_RELAY_FEE = 0;

    uint16 constant SLIPPAGE_BPS = 50;
    uint8 constant KIND_WITHDRAW = 0;
    string constant DEST_ASSET = "nep141:zec.omft.near";
    string constant RECIPIENT = "t1KzZ3n1234567890abcdefghijkLMNOPQRS";

    function setUp() public {
        // Hydration exposes assets as ERC20 precompiles at fixed addresses, so the mocks have to
        // live at those addresses rather than wherever `new` puts them.
        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(HydrationConsts.WETH_ID));
        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(ASSET_IN));
        weth = MockERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));
        assetIn = MockERC20(HydrationConsts.toErc20(ASSET_IN));

        deployCodeTo("IntentEmitterTest.sol:MockDispatch", HydrationConsts.DISPATCH_PRECOMPILE);
        dispatch = MockDispatch(HydrationConsts.DISPATCH_PRECOMPILE);

        coreBridge = new MockCoreBridge();

        emitter = IntentEmitter(
            address(
                new ERC1967Proxy(
                    address(new IntentEmitter()),
                    abi.encodeCall(IntentEmitter.initialize, (address(coreBridge)))
                )
            )
        );

        nttManager = new MockNttManager(address(weth));
        nttManager.setDeliveryPrice(DELIVERY_PRICE);
        emitter.setNttManager(address(nttManager));
        emitter.setIntentReceiver(intentReceiver);

        (authPath,) = emitter.publishOrder(_order());

        vm.deal(user, 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _order() internal view returns (IIntentEmitter.Order memory) {
        return IIntentEmitter.Order({
            orderId: orderId,
            maxSlippageBps: SLIPPAGE_BPS,
            recipientKind: KIND_WITHDRAW,
            destinationAsset: DEST_ASSET,
            recipient: RECIPIENT
        });
    }

    /// @dev Bridge WETH directly — assetIn == WETH skips the swap, so amounts are exact and the
    ///      quantization assertions are unambiguous. The native credit mirrors what the ERC20
    ///      transfer would also move on Hydration; see MockDispatch.
    function _bridge(uint256 amountIn, uint256 minEthOut) internal returns (uint64 sequence) {
        weth.mint(user, amountIn);
        vm.deal(address(emitter), address(emitter).balance + amountIn);

        vm.startPrank(user);
        weth.approve(address(emitter), amountIn);
        sequence = emitter.placeOrder(HydrationConsts.WETH_ID, amountIn, minEthOut, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    /// @dev Bridge through the swap path: the router produces `out` WETH for `amountIn` of ASSET_IN.
    function _swapBridge(uint256 amountIn, uint256 out, uint256 minEthOut)
        internal
        returns (uint64 sequence)
    {
        dispatch.configure(address(weth), out);
        assetIn.mint(user, amountIn);

        vm.startPrank(user);
        assetIn.approve(address(emitter), amountIn);
        sequence = emitter.placeOrder(ASSET_IN, amountIn, minEthOut, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    // ─── Wire-format readers (independent of the encoder) ───────────

    function _u8(bytes memory b, uint256 o) internal pure returns (uint8) {
        return uint8(b[o]);
    }

    function _u16(bytes memory b, uint256 o) internal pure returns (uint16) {
        return uint16(uint8(b[o])) << 8 | uint16(uint8(b[o + 1]));
    }

    function _b32(bytes memory b, uint256 o) internal pure returns (bytes32 out) {
        for (uint256 i = 0; i < 32; i++) {
            out |= bytes32(uint256(uint8(b[o + i])) << (8 * (31 - i)));
        }
    }

    function _str(bytes memory b, uint256 o, uint256 len) internal pure returns (string memory) {
        bytes memory s = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            s[i] = b[o + i];
        }
        return string(s);
    }

    /// @dev The `min_amount_out` the emitter handed `router.sell`. SCALE: pallet(1) call(1)
    ///      assetIn(4) assetOut(4) amountIn(16) minAmountOut(16), all little-endian.
    function _routerFloor() internal view returns (uint256 floor) {
        bytes memory call = dispatch.lastCall();
        for (uint256 i = 0; i < 16; i++) {
            floor |= uint256(uint8(call[26 + i])) << (8 * i);
        }
    }

    // ─── Order authorization ────────────────────────────────────────

    /// @notice The router decodes this by offset and trusts every field, so the layout is a
    ///         contract in itself. Read back field by field rather than by re-encoding.
    function testOrderPayloadWireFormat() public view {
        bytes memory p = coreBridge.lastPayload();

        assertEq(_u8(p, 0), 1, "version");
        assertEq(_b32(p, 1), orderId, "orderId");
        assertEq(_u16(p, 33), SLIPPAGE_BPS, "maxSlippageBps");
        assertEq(_u8(p, 35), KIND_WITHDRAW, "recipientKind");

        uint256 assetLen = _u8(p, 36);
        assertEq(assetLen, bytes(DEST_ASSET).length, "destAssetLen");
        assertEq(_str(p, 37, assetLen), DEST_ASSET, "destinationAsset");

        uint256 recipientLen = _u8(p, 37 + assetLen);
        assertEq(recipientLen, bytes(RECIPIENT).length, "recipientLen");
        assertEq(_str(p, 38 + assetLen, recipientLen), RECIPIENT, "recipient");

        // Declared lengths must account for the whole buffer — a payload the router could
        // truncate rather than reject is a payload with a second reading.
        assertEq(p.length, 38 + assetLen + recipientLen, "trailing bytes");
    }

    /// @notice The view the off-chain deriver and the router's decoder are pinned against. Bytes
    ///         rather than a hash, so a divergence names the field instead of just failing.
    function testComputeTermsMatchesThePublishedPayload() public view {
        assertEq(emitter.computeTerms(_order()), coreBridge.lastPayload(), "terms must be the payload");
    }

    /// @notice Round-trips through the decoder the router has to reimplement. What the emitter
    ///         encodes must be recoverable field for field, or the two ends disagree about an order
    ///         while both believing they parsed it.
    function testTermsRoundTripThroughTheDecoder() public view {
        IIntentEmitter.Order memory o = IntentCodec.decodeOrder(coreBridge.lastPayload());

        assertEq(o.orderId, orderId, "orderId");
        assertEq(o.maxSlippageBps, SLIPPAGE_BPS, "maxSlippageBps");
        assertEq(o.recipientKind, KIND_WITHDRAW, "recipientKind");
        assertEq(o.destinationAsset, DEST_ASSET, "destinationAsset");
        assertEq(o.recipient, RECIPIENT, "recipient");
    }

    /// @notice A buffer whose declared lengths do not sum to it exactly has a second reading, and
    ///         two different orders could hash from it. Reject rather than truncate.
    function testDecoderRejectsMalformedTerms() public {
        CodecHarness harness = new CodecHarness();
        bytes memory p = coreBridge.lastPayload();

        bytes memory truncated = new bytes(p.length - 1);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = p[i];
        }
        vm.expectRevert(
            abi.encodeWithSelector(IntentCodec.MalformedTerms.selector, truncated.length)
        );
        harness.decode(truncated);

        bytes memory padded = abi.encodePacked(p, hex"00");
        vm.expectRevert(
            abi.encodeWithSelector(IntentCodec.MalformedTerms.selector, padded.length)
        );
        harness.decode(padded);

        p[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidVersion.selector, 2));
        harness.decode(p);
    }

    /// @notice Published instantly. Finality buys nothing here: the path binds the order to its own
    ///         recipient, so a reorged-away authorization derives an account nobody funded.
    function testOrderPublishedInstant() public view {
        assertEq(coreBridge.lastConsistency(), 200, "authorization must publish instantly");
    }

    /// @notice The path is the hash of exactly the bytes the router receives — no prefix, no suffix,
    ///         nothing sliced off. Anything else and the router derives a different account than the
    ///         publisher computed, and deposits land somewhere nothing can reach.
    function testAuthPathIsTheHashOfTheWholePayload() public view {
        assertEq(authPath, keccak256(coreBridge.lastPayload()), "path must hash the payload in full");
        assertEq(authPath, emitter.computeAuthPath(_order()), "view must agree with publish");
    }

    /// @notice The property the whole design rests on. Every field that decides where funds may go
    ///         is inside the hash, so no authorization can reach an account it was not derived to
    ///         reach — there is simply no VAA that hashes to someone else's path while naming your
    ///         recipient.
    function testAuthPathBindsEveryDestinationField() public view {
        IIntentEmitter.Order memory o = _order();

        // Same length as RECIPIENT on purpose: a shorter one would differ by its length prefix,
        // which would let this assertion pass even with the bytes themselves outside the hash.
        o.recipient = "t1AttackerZZZZZZZZZZZZZZZZZZZZZZZZZZ";
        assertEq(bytes(o.recipient).length, bytes(RECIPIENT).length, "lengths must match to bind bytes");
        assertTrue(emitter.computeAuthPath(o) != authPath, "recipient must bind");

        o = _order();
        o.destinationAsset = "nep141:btc.omft.near";
        assertEq(bytes(o.destinationAsset).length, bytes(DEST_ASSET).length, "lengths must match");
        assertTrue(emitter.computeAuthPath(o) != authPath, "destinationAsset must bind");

        o = _order();
        o.recipientKind = 1;
        assertTrue(emitter.computeAuthPath(o) != authPath, "recipientKind must bind");

        // Not cosmetic: if slippage were outside the hash, anyone could publish a wide-open order
        // for someone else's (asset, recipient) and have the balance drained at a rate a colluding
        // solver picked. In the hash, a looser tolerance is a different account entirely.
        o = _order();
        o.maxSlippageBps = 5000;
        assertTrue(emitter.computeAuthPath(o) != authPath, "maxSlippageBps must bind");

        // The one field the router assigns no meaning to still has to bind, because that is the only
        // thing making account ↔ schedule a bijection: two schedules to the same recipient must not
        // share a balance, or the bot's per-account lock has to span them.
        o = _order();
        o.orderId = keccak256("schedule-2");
        assertTrue(emitter.computeAuthPath(o) != authPath, "orderId must bind");
    }

    /// @notice Length prefixes are what keep the hash unambiguous — without them ("ab","c") and
    ///         ("a","bc") would derive the same account, and either recipient could drain the other.
    function testAuthPathIsUnambiguousAcrossFieldBoundaries() public view {
        IIntentEmitter.Order memory a = _order();
        a.destinationAsset = "ab";
        a.recipient = "c";

        IIntentEmitter.Order memory b = _order();
        b.destinationAsset = "a";
        b.recipient = "bc";

        assertTrue(
            emitter.computeAuthPath(a) != emitter.computeAuthPath(b), "concatenation is ambiguous"
        );
    }

    /// @notice Who publishes carries no authority, which is why there is no id to claim and no
    ///         namespace to defend. An attacker publishing the victim's terms just reproduces the
    ///         victim's own authorization; publishing their own recipient reaches their own account.
    function testPublisherHasNoAuthority() public {
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        (bytes32 same,) = emitter.publishOrder(_order());
        assertEq(same, authPath, "identical terms must derive the same account");

        IIntentEmitter.Order memory theirs = _order();
        theirs.recipient = "t1AttackerAddress00000000000000000";

        vm.prank(attacker);
        (bytes32 other,) = emitter.publishOrder(theirs);
        assertTrue(other != authPath, "attacker reached the victim's account");
    }

    /// @notice Nothing is stored, so republishing is a no-op worth having: if a VAA's signatures
    ///         are ever unavailable, publish the same terms again and get the same message.
    function testRepublishIsHarmless() public {
        (bytes32 again,) = emitter.publishOrder(_order());

        assertEq(again, authPath, "same terms must republish to the same path");
        assertEq(coreBridge.lastPayload().length, 38 + bytes(DEST_ASSET).length + bytes(RECIPIENT).length);
    }

    /// @notice Native here is WETH — the same balance the contract holds as an ERC20 — so an
    ///         approximate fee would be paid out of swap dust instead of the caller's pocket.
    function testPublishOrderRequiresExactMessageFee() public {
        coreBridge.setFee(1000);
        vm.deal(address(this), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(IIntentEmitter.InvalidMessageFee.selector, 1000, 0));
        emitter.publishOrder(_order());

        vm.expectRevert(abi.encodeWithSelector(IIntentEmitter.InvalidMessageFee.selector, 1000, 1001));
        emitter.publishOrder{value: 1001}(_order());

        emitter.publishOrder{value: 1000}(_order());
        assertEq(coreBridge.lastValue(), 1000, "fee must reach the core bridge");
    }

    function testPublishOrderValidatesTerms() public {
        IIntentEmitter.Order memory o = _order();

        // Zero is what an uninitialized client field looks like.
        o.orderId = bytes32(0);
        vm.expectRevert(IntentCodec.InvalidOrderId.selector);
        emitter.publishOrder(o);

        o = _order();
        o.recipientKind = 2;
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipientKind.selector, 2));
        emitter.publishOrder(o);

        o = _order();
        o.destinationAsset = "";
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidDestinationAsset.selector, 0));
        emitter.publishOrder(o);

        // Both strings carry a single length byte on the wire, so 256 would wrap to zero.
        o = _order();
        o.recipient = new string(256);
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipient.selector, 256));
        emitter.publishOrder(o);
    }

    /// @notice Terms the router would reject must not cost a Wormhole message fee.
    function testInvalidTermsRevertBeforeTheFeeCheck() public {
        coreBridge.setFee(1000);

        IIntentEmitter.Order memory o = _order();
        o.orderId = bytes32(0);

        vm.expectRevert(IntentCodec.InvalidOrderId.selector);
        emitter.publishOrder(o);
    }

    // ─── Self-funded delivery ───────────────────────────────────────

    /// @notice The property that makes an on-chain scheduler viable: the caller sends no value, and
    ///         the rail's delivery price is deducted from what the swap produced.
    function testDeliveryPriceComesOutOfSwapOutput() public {
        uint64 sequence = _bridge(5 * TRIM_UNIT + DELIVERY_PRICE, 0);

        assertEq(nttManager.getTransfer(sequence).amount, 5 * TRIM_UNIT, "delivery price not deducted");
        assertEq(address(nttManager).balance, DELIVERY_PRICE, "rail underpaid");
        assertEq(address(emitter).balance, 5 * TRIM_UNIT, "emitter must pay exactly the quote");
    }

    /// @notice `minEthOut` is a floor on what arrives, so the floor handed to the router has to be
    ///         raised by the delivery price that output still has to cover.
    function testRouterFloorIsRaisedByDeliveryPrice() public {
        _swapBridge(100e6, 5 * TRIM_UNIT + DELIVERY_PRICE, 5 * TRIM_UNIT);

        assertEq(_routerFloor(), 5 * TRIM_UNIT + DELIVERY_PRICE, "router floor must cover delivery");
    }

    /// @notice A value carrying digits finer than the rail can represent binds at the multiple
    ///         below it — otherwise an exact fill at the floor would be trimmed under it and revert.
    function testFloorIsQuantizedDownwards() public {
        _swapBridge(100e6, 5 * TRIM_UNIT + DELIVERY_PRICE, 5 * TRIM_UNIT + DUST);

        assertEq(_routerFloor(), 5 * TRIM_UNIT + DELIVERY_PRICE, "floor must round down to the rail");
    }

    function testAmountBelowDeliveryPriceReverts() public {
        weth.mint(user, DELIVERY_PRICE);
        vm.deal(address(emitter), DELIVERY_PRICE);

        vm.startPrank(user);
        weth.approve(address(emitter), DELIVERY_PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentEmitter.AmountBelowDeliveryPrice.selector, DELIVERY_PRICE, DELIVERY_PRICE
            )
        );
        emitter.placeOrder(HydrationConsts.WETH_ID, DELIVERY_PRICE, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    // ─── Quantization ───────────────────────────────────────────────

    /// @notice The rail trims to 8 decimals, so the source must round down before promising an
    ///         amount: what settles has to equal what is released.
    function testQuantizesToTrimUnit() public {
        uint256 amountIn = 3 * TRIM_UNIT + DELIVERY_PRICE + DUST;
        uint64 sequence = _bridge(amountIn, 0);

        assertEq(nttManager.getTransfer(sequence).amount, 3 * TRIM_UNIT, "settlement must be quantized");
        // The emitter keeps what it did not bridge. DELIVERY_PRICE left on the native side, which
        // these two mocks cannot debit from the ERC20 side; the real dust is the remainder.
        assertEq(
            weth.balanceOf(address(emitter)) - DELIVERY_PRICE, DUST, "remainder must stay as dust"
        );
    }

    function testAmountBelowTrimUnitReverts() public {
        uint256 amountIn = DELIVERY_PRICE + TRIM_UNIT - 1;
        weth.mint(user, amountIn);
        vm.deal(address(emitter), amountIn);

        vm.startPrank(user);
        weth.approve(address(emitter), amountIn);
        vm.expectRevert(abi.encodeWithSelector(IIntentEmitter.AmountBelowTrimUnit.selector, 0, TRIM_UNIT));
        emitter.placeOrder(HydrationConsts.WETH_ID, amountIn, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    function testSweepRecoversDust() public {
        _bridge(TRIM_UNIT + DELIVERY_PRICE + DUST, 0);

        emitter.sweep(address(weth), address(this), DUST);
        assertEq(weth.balanceOf(address(this)), DUST, "dust not recoverable");
    }

    // ─── Settlement shape ───────────────────────────────────────────

    /// @notice An order is just "settle to this address". For an authorized route the scheduler
    ///         holds a deposit address that never changes, so firing one needs no off-chain input.
    /// @notice The settlement goes to the receiver, not the deposit address — NTT carries no payload,
    ///         so the destination travels as its own message and the two are matched on the sequence.
    function testSettlementAddressedToReceiver() public {
        uint64 sequence = _bridge(TRIM_UNIT + DELIVERY_PRICE, 0);

        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(sequence);
        assertEq(
            settled.recipient,
            bytes32(uint256(uint160(intentReceiver))),
            "settlement must be addressed to the receiver"
        );
        assertEq(settled.recipientChain, 2, "wrong settlement chain");

        (uint64 instructionSequence, address forwardTo, uint256 amount, uint256 ceiling) =
            abi.decode(coreBridge.lastPayload(), (uint64, address, uint256, uint256));

        assertEq(instructionSequence, sequence, "instruction must match the settlement");
        assertEq(forwardTo, depositAddress, "instruction must carry the deposit address");
        assertEq(amount, settled.amount, "instruction must carry what the settlement delivers");
        assertEq(ceiling, MAX_RELAY_FEE, "instruction must carry the fee ceiling");
        assertEq(coreBridge.lastConsistency(), 200, "instruction must publish instantly");
    }

    /// @notice A ceiling at or above the delivery leaves the receiver nothing to forward, so a
    ///         colluding relayer could take the order whole.
    function testRelayFeeCeilingCannotSwallowTheDelivery() public {
        uint256 amountIn = 3 * TRIM_UNIT + DELIVERY_PRICE;
        weth.mint(user, amountIn);
        vm.deal(address(emitter), address(emitter).balance + amountIn);

        vm.startPrank(user);
        weth.approve(address(emitter), amountIn);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentEmitter.RelayFeeExceedsAmount.selector, 3 * TRIM_UNIT, 3 * TRIM_UNIT)
        );
        emitter.placeOrder(HydrationConsts.WETH_ID, amountIn, 0, depositAddress, 3 * TRIM_UNIT);
        vm.stopPrank();
    }

    function testUnconfiguredReceiverReverts() public {
        vm.prank(emitter.owner());
        emitter.setIntentReceiver(address(0));

        vm.expectRevert(IIntentEmitter.NotConfigured.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT, 0, depositAddress, MAX_RELAY_FEE);
    }

    function testZeroDepositAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(IIntentEmitter.InvalidDepositAddress.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT, 0, address(0), MAX_RELAY_FEE);
    }

    /// @notice An unbounded approve overflows Hydration's u128 erc20 precompile, so the approve must
    ///         be exact — and must not survive the call.
    function testApprovalIsExactAndNotLingering() public {
        _bridge(TRIM_UNIT + DELIVERY_PRICE, 0);
        assertEq(weth.allowance(address(emitter), address(nttManager)), 0, "stale approval left");
    }

    // ─── Fail-closed rail ───────────────────────────────────────────

    function testPausedRailReverts() public {
        nttManager.setPaused(true);

        weth.mint(user, TRIM_UNIT + DELIVERY_PRICE);
        vm.deal(address(emitter), TRIM_UNIT + DELIVERY_PRICE);

        vm.startPrank(user);
        weth.approve(address(emitter), TRIM_UNIT + DELIVERY_PRICE);
        vm.expectRevert(MockNttManager.TransferPaused.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT + DELIVERY_PRICE, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();

        assertEq(weth.balanceOf(user), TRIM_UNIT + DELIVERY_PRICE, "user keeps their funds");
    }

    /// @notice A rate-limit breach reverts rather than queues — the 3-arg overload hardcodes
    ///         shouldQueue=false, so no order can settle out of turn behind a live
    ///         authorization.
    function testCapacityBreachReverts() public {
        nttManager.setOutboundCapacity(TRIM_UNIT - 1);

        weth.mint(user, TRIM_UNIT + DELIVERY_PRICE);
        vm.deal(address(emitter), TRIM_UNIT + DELIVERY_PRICE);

        vm.startPrank(user);
        weth.approve(address(emitter), TRIM_UNIT + DELIVERY_PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(MockNttManager.NotEnoughCapacity.selector, TRIM_UNIT - 1, TRIM_UNIT)
        );
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT + DELIVERY_PRICE, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    // ─── Swap path ──────────────────────────────────────────────────

    function testSwapPathBridgesRouterOutput() public {
        uint64 sequence = _swapBridge(100e6, 5 * TRIM_UNIT + DELIVERY_PRICE, 5 * TRIM_UNIT);

        assertEq(nttManager.getTransfer(sequence).amount, 5 * TRIM_UNIT, "must bridge the swap output");
    }

    /// @notice The delta check binds even if the router ignores its own limit — otherwise a
    ///         short-filled swap bridges less than the caller accepted.
    function testInsufficientOutputReverts() public {
        dispatch.configure(address(weth), TRIM_UNIT + DELIVERY_PRICE);
        assetIn.mint(user, 100e6);

        vm.startPrank(user);
        assetIn.approve(address(emitter), 100e6);
        vm.expectRevert(IIntentEmitter.InsufficientOutput.selector);
        emitter.placeOrder(ASSET_IN, 100e6, 5 * TRIM_UNIT, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    /// @notice Only this call's output may be bridged — WETH already resident (earlier dust,
    ///         donations) must not be swept into someone's order.
    function testStrayWethNotBridged() public {
        weth.mint(address(emitter), 9 * TRIM_UNIT);
        vm.deal(address(emitter), 9 * TRIM_UNIT);

        uint64 sequence = _swapBridge(100e6, TRIM_UNIT + DELIVERY_PRICE, 0);

        assertEq(
            nttManager.getTransfer(sequence).amount, TRIM_UNIT, "must bridge only this call's output"
        );
    }

    // ─── Guards ─────────────────────────────────────────────────────

    function testZeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(IIntentEmitter.ZeroAmount.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, 0, 0, depositAddress, MAX_RELAY_FEE);
    }

    function testUnconfiguredReverts() public {
        IntentEmitter fresh = IntentEmitter(
            address(
                new ERC1967Proxy(
                    address(new IntentEmitter()),
                    abi.encodeCall(IntentEmitter.initialize, (address(coreBridge)))
                )
            )
        );

        vm.prank(user);
        vm.expectRevert(IIntentEmitter.NotConfigured.selector);
        fresh.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT, 0, depositAddress, MAX_RELAY_FEE);
    }

    /// @notice Wiring a manager for the wrong token would approve and burn something this contract
    ///         never swapped into.
    function testSetNttManagerRejectsForeignToken() public {
        MockERC20 other = new MockERC20();
        MockNttManager wrong = new MockNttManager(address(other));

        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentEmitter.SettlementRouteMismatch.selector, address(weth), address(other)
            )
        );
        emitter.setNttManager(address(wrong));
    }

    function testAdminOnlyOwner() public {
        vm.startPrank(user);
        vm.expectRevert(IIntentEmitter.NotOwner.selector);
        emitter.setNttManager(address(nttManager));
        vm.expectRevert(IIntentEmitter.NotOwner.selector);
        emitter.sweep(address(weth), user, 1);
        vm.expectRevert(IIntentEmitter.NotOwner.selector);
        emitter.setOwner(user);
        vm.stopPrank();
    }
}
