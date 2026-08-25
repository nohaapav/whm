// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IntentQuoteEmitter} from "../../src/intents/IntentQuoteEmitter.sol";
import {IntentCodec} from "../../src/intents/IntentCodec.sol";
import {IIntentQuoteEmitter} from "../../src/intents/interfaces/IIntentQuoteEmitter.sol";

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
    function decode(bytes memory terms) external pure returns (IIntentQuoteEmitter.Quote memory) {
        return IntentCodec.decodeQuote(terms);
    }
}

/// @title IntentQuoteEmitterTest
/// @notice Pins the property the standing-order design rests on: the derivation path is a function
///         of the terms, so an authorization can only ever reach the account its own recipient
///         implies. The wire format is read back field by field, because the NEAR router decodes by
///         offset and trusts what it finds.
contract IntentQuoteEmitterTest is Test {
    IntentQuoteEmitter public publisher;
    MockCoreBridge public coreBridge;

    bytes32 public quoteId = keccak256("schedule-1");
    bytes32 public authPath;

    uint16 constant SLIPPAGE_BPS = 50;
    uint8 constant KIND_WITHDRAW = 0;
    string constant DEST_ASSET = "nep141:zec.omft.near";
    string constant RECIPIENT = "t1KzZ3n1234567890abcdefghijkLMNOPQRS";

    function setUp() public {
        coreBridge = new MockCoreBridge();

        publisher = IntentQuoteEmitter(
            address(
                new ERC1967Proxy(
                    address(new IntentQuoteEmitter()),
                    abi.encodeCall(IntentQuoteEmitter.initialize, (address(coreBridge)))
                )
            )
        );

        (authPath,) = publisher.publishQuote(_quote());
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _quote() internal view returns (IIntentQuoteEmitter.Quote memory) {
        return IIntentQuoteEmitter.Quote({
            quoteId: quoteId,
            maxSlippageBps: SLIPPAGE_BPS,
            recipientKind: KIND_WITHDRAW,
            destinationAsset: DEST_ASSET,
            recipient: RECIPIENT
        });
    }

    /// @dev Bridge WETH directly — assetIn == WETH skips the swap, so amounts are exact and the
    ///      quantization assertions are unambiguous. The native credit mirrors what the ERC20
    ///      transfer would also move on Hydration; see MockDispatch.
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
    // ─── Order authorization ────────────────────────────────────────

    /// @notice The router decodes this by offset and trusts every field, so the layout is a
    ///         contract in itself. Read back field by field rather than by re-encoding.
    function testOrderPayloadWireFormat() public view {
        bytes memory p = coreBridge.lastPayload();

        assertEq(_u8(p, 0), 1, "version");
        assertEq(_b32(p, 1), quoteId, "quoteId");
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
        assertEq(publisher.computeTerms(_quote()), coreBridge.lastPayload(), "terms must be the payload");
    }

    /// @notice Round-trips through the decoder the router has to reimplement. What the emitter
    ///         encodes must be recoverable field for field, or the two ends disagree about an order
    ///         while both believing they parsed it.
    function testTermsRoundTripThroughTheDecoder() public view {
        IIntentQuoteEmitter.Quote memory o = IntentCodec.decodeQuote(coreBridge.lastPayload());

        assertEq(o.quoteId, quoteId, "quoteId");
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
    function testQuotePublishedInstant() public view {
        assertEq(coreBridge.lastConsistency(), 200, "authorization must publish instantly");
    }

    /// @notice The path is the hash of exactly the bytes the router receives — no prefix, no suffix,
    ///         nothing sliced off. Anything else and the router derives a different account than the
    ///         publisher computed, and deposits land somewhere nothing can reach.
    function testAuthPathIsTheHashOfTheWholePayload() public view {
        assertEq(authPath, keccak256(coreBridge.lastPayload()), "path must hash the payload in full");
        assertEq(authPath, publisher.computeAuthPath(_quote()), "view must agree with publish");
    }

    /// @notice The property the whole design rests on. Every field that decides where funds may go
    ///         is inside the hash, so no authorization can reach an account it was not derived to
    ///         reach — there is simply no VAA that hashes to someone else's path while naming your
    ///         recipient.
    function testAuthPathBindsEveryDestinationField() public view {
        IIntentQuoteEmitter.Quote memory o = _quote();

        // Same length as RECIPIENT on purpose: a shorter one would differ by its length prefix,
        // which would let this assertion pass even with the bytes themselves outside the hash.
        o.recipient = "t1AttackerZZZZZZZZZZZZZZZZZZZZZZZZZZ";
        assertEq(bytes(o.recipient).length, bytes(RECIPIENT).length, "lengths must match to bind bytes");
        assertTrue(publisher.computeAuthPath(o) != authPath, "recipient must bind");

        o = _quote();
        o.destinationAsset = "nep141:btc.omft.near";
        assertEq(bytes(o.destinationAsset).length, bytes(DEST_ASSET).length, "lengths must match");
        assertTrue(publisher.computeAuthPath(o) != authPath, "destinationAsset must bind");

        o = _quote();
        o.recipientKind = 1;
        assertTrue(publisher.computeAuthPath(o) != authPath, "recipientKind must bind");

        // Not cosmetic: if slippage were outside the hash, anyone could publish a wide-open order
        // for someone else's (asset, recipient) and have the balance drained at a rate a colluding
        // solver picked. In the hash, a looser tolerance is a different account entirely.
        o = _quote();
        o.maxSlippageBps = 5000;
        assertTrue(publisher.computeAuthPath(o) != authPath, "maxSlippageBps must bind");

        // The one field the router assigns no meaning to still has to bind, because that is the only
        // thing making account ↔ schedule a bijection: two schedules to the same recipient must not
        // share a balance, or the bot's per-account lock has to span them.
        o = _quote();
        o.quoteId = keccak256("schedule-2");
        assertTrue(publisher.computeAuthPath(o) != authPath, "quoteId must bind");
    }

    /// @notice Length prefixes are what keep the hash unambiguous — without them ("ab","c") and
    ///         ("a","bc") would derive the same account, and either recipient could drain the other.
    function testAuthPathIsUnambiguousAcrossFieldBoundaries() public view {
        IIntentQuoteEmitter.Quote memory a = _quote();
        a.destinationAsset = "ab";
        a.recipient = "c";

        IIntentQuoteEmitter.Quote memory b = _quote();
        b.destinationAsset = "a";
        b.recipient = "bc";

        assertTrue(
            publisher.computeAuthPath(a) != publisher.computeAuthPath(b), "concatenation is ambiguous"
        );
    }

    /// @notice Who publishes carries no authority, which is why there is no id to claim and no
    ///         namespace to defend. An attacker publishing the victim's terms just reproduces the
    ///         victim's own authorization; publishing their own recipient reaches their own account.
    function testPublisherHasNoAuthority() public {
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        (bytes32 same,) = publisher.publishQuote(_quote());
        assertEq(same, authPath, "identical terms must derive the same account");

        IIntentQuoteEmitter.Quote memory theirs = _quote();
        theirs.recipient = "t1AttackerAddress00000000000000000";

        vm.prank(attacker);
        (bytes32 other,) = publisher.publishQuote(theirs);
        assertTrue(other != authPath, "attacker reached the victim's account");
    }

    /// @notice Nothing is stored, so republishing is a no-op worth having: if a VAA's signatures
    ///         are ever unavailable, publish the same terms again and get the same message.
    function testRepublishIsHarmless() public {
        (bytes32 again,) = publisher.publishQuote(_quote());

        assertEq(again, authPath, "same terms must republish to the same path");
        assertEq(coreBridge.lastPayload().length, 38 + bytes(DEST_ASSET).length + bytes(RECIPIENT).length);
    }

    /// @notice Native here is WETH — the same balance the contract holds as an ERC20 — so an
    ///         approximate fee would be paid out of swap dust instead of the caller's pocket.
    function testPublishOrderRequiresExactMessageFee() public {
        coreBridge.setFee(1000);
        vm.deal(address(this), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(IIntentQuoteEmitter.InvalidMessageFee.selector, 1000, 0));
        publisher.publishQuote(_quote());

        vm.expectRevert(abi.encodeWithSelector(IIntentQuoteEmitter.InvalidMessageFee.selector, 1000, 1001));
        publisher.publishQuote{value: 1001}(_quote());

        publisher.publishQuote{value: 1000}(_quote());
        assertEq(coreBridge.lastValue(), 1000, "fee must reach the core bridge");
    }

    function testPublishOrderValidatesTerms() public {
        IIntentQuoteEmitter.Quote memory o = _quote();

        // Zero is what an uninitialized client field looks like.
        o.quoteId = bytes32(0);
        vm.expectRevert(IntentCodec.InvalidQuoteId.selector);
        publisher.publishQuote(o);

        o = _quote();
        o.recipientKind = 2;
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipientKind.selector, 2));
        publisher.publishQuote(o);

        o = _quote();
        o.destinationAsset = "";
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidDestinationAsset.selector, 0));
        publisher.publishQuote(o);

        // Both strings carry a single length byte on the wire, so 256 would wrap to zero.
        o = _quote();
        o.recipient = new string(256);
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipient.selector, 256));
        publisher.publishQuote(o);
    }

    /// @notice Terms the router would reject must not cost a Wormhole message fee.
    function testInvalidTermsRevertBeforeTheFeeCheck() public {
        coreBridge.setFee(1000);

        IIntentQuoteEmitter.Quote memory o = _quote();
        o.quoteId = bytes32(0);

        vm.expectRevert(IntentCodec.InvalidQuoteId.selector);
        publisher.publishQuote(o);
    }

}
