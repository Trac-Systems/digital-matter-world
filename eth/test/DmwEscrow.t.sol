// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EscrowTestBase, EscrowVm, DmwEscrow} from "./EscrowTestBase.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract DmwEscrowTest is EscrowTestBase {
    function testDecimalTapFeeUsesTheSameAtomicIntegerThroughDepositAndRelease() public {
        require(token.decimals() == 18);
        uint256 baseFee = 22_600_000_000_000_000_001;
        uint256 amount = baseFee * 10;
        uint256 finder = amount * 30 / 100;
        uint256 burn = amount * 35 / 100;
        uint256 treasury = amount - finder - burn;
        DmwEscrow.Split memory split = DmwEscrow.Split(TREASURY, treasury, FINDER, finder, address(0), 0, address(0), 0, burn);
        uint256 payerBefore = token.balanceOf(PAYER);
        uint256 supplyBefore = token.totalSupply();
        vm.prank(PAYER);
        escrow.deposit(ID, amount, split, block.timestamp + 1 days);
        assertOpen(ID, amount);
        require(escrow.getDeposit(PAYER, ID).amount == amount);
        require(token.balanceOf(PAYER) == payerBefore - amount);
        escrow.release(PAYER, ID, signature(ID));
        require(token.balanceOf(TREASURY) == treasury && token.balanceOf(FINDER) == finder);
        require(token.totalSupply() == supplyBefore - burn && escrow.totalOpen() == 0);
        require(treasury + finder + burn == amount);
    }

    function testDepositStoresSplitAndEmitsCompleteRecord() public {
        vm.recordLogs();
        uint256 expiry = deposit100(ID);
        DmwEscrow.Deposit memory record = escrow.getDeposit(PAYER, ID);
        require(record.payer == PAYER && record.expiry == expiry && record.amount == 100 ether);
        require(record.splitHash == escrow.hashSplit(split100()));
        require(keccak256(abi.encode(record.split)) == keccak256(abi.encode(split100())));
        assertOpen(ID, 100 ether);
        EscrowVm.Log[] memory logs = vm.getRecordedLogs();
        EscrowVm.Log memory last = logs[logs.length - 1];
        require(last.emitter == address(escrow) && last.topics[1] == ID);
        require(address(uint160(uint256(last.topics[2]))) == PAYER);
        (uint256 amount, uint256 recordedExpiry, bytes32 splitHash, DmwEscrow.Split memory split) =
            abi.decode(last.data, (uint256, uint256, bytes32, DmwEscrow.Split));
        require(amount == record.amount && recordedExpiry == expiry && splitHash == record.splitHash);
        require(escrow.hashSplit(split) == splitHash);
    }

    function testReleasePaysAllRolesAndBurnsOnce() public {
        deposit100(ID);
        bytes memory sig = signature(ID);
        uint256 supply = token.totalSupply();
        vm.prank(RELAYER);
        escrow.release(PAYER, ID, sig);
        require(token.balanceOf(TREASURY) == 35 ether && token.balanceOf(FINDER) == 30 ether);
        require(token.balanceOf(LANDOWNER) == 15 ether && token.totalSupply() == supply - 20 ether);
        require(token.balanceOf(address(escrow)) == 0 && escrow.totalOpen() == 0);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Released);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.release(PAYER, ID, sig);
        vm.warp(block.timestamp + 11 days);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.refund(PAYER, ID);
        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), block.timestamp + 1 days);
    }

    function testNoLandownerBurnsItsAllocation() public {
        DmwEscrow.Split memory split = split100();
        split.landowner = address(0);
        split.landownerAmount = 0;
        split.burnAmount = 35 ether;
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split, block.timestamp + 1 days);
        escrow.release(PAYER, ID, signature(ID));
        require(token.balanceOf(LANDOWNER) == 0 && token.totalSupply() == 999_965 ether);
    }

    function testRefundAtBoundaryPaysOnlyPayerOnce() public {
        uint256 initial = token.balanceOf(PAYER);
        uint256 expiry = deposit100(ID);
        bytes memory sig = signature(ID);
        vm.warp(expiry - 1);
        vm.expectRevert(DmwEscrow.RefundTooEarly.selector);
        escrow.refund(PAYER, ID);
        vm.warp(expiry);
        vm.expectRevert(DmwEscrow.ReleaseExpired.selector);
        escrow.release(PAYER, ID, sig);
        vm.prank(RELAYER);
        escrow.refund(PAYER, ID);
        require(token.balanceOf(PAYER) == initial && token.balanceOf(RELAYER) == 0);
        require(token.totalSupply() == initial && escrow.totalOpen() == 0);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Refunded);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.refund(PAYER, ID);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.release(PAYER, ID, sig);
        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), block.timestamp + 1 days);
    }

    function testReleaseOneSecondBeforeExpiry() public {
        uint256 expiry = deposit100(ID);
        bytes memory sig = signature(ID);
        vm.warp(expiry - 1);
        escrow.release(PAYER, ID, sig);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Released);
    }

    function testZeroUnknownAndDuplicateRequestsRefused() public {
        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        escrow.deposit(0, 100 ether, split100(), block.timestamp + 1 days);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.release(PAYER, ID, "");
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.refund(PAYER, ID);
        deposit100(ID);
        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), block.timestamp + 1 days);
    }

    function testExpiryBoundsInclusive() public {
        uint256 nowTime = block.timestamp;
        uint256 minimum = escrow.MIN_EXPIRY();
        uint256 maximum = escrow.MAX_EXPIRY();
        vm.expectRevert(DmwEscrow.InvalidExpiry.selector);
        escrow.deposit(ID, 100 ether, split100(), nowTime + minimum - 1);
        vm.expectRevert(DmwEscrow.InvalidExpiry.selector);
        escrow.deposit(ID, 100 ether, split100(), nowTime + maximum + 1);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), nowTime + minimum);
        vm.prank(PAYER);
        escrow.deposit(bytes32(uint256(2)), 100 ether, split100(), nowTime + maximum);
    }

    function testInvalidSplitsAndZeroAmountsRefused() public {
        DmwEscrow.Split memory split = split100();
        vm.expectRevert(DmwEscrow.InvalidAmount.selector);
        escrow.deposit(ID, 0, split, block.timestamp + 1 days);
        vm.expectRevert(DmwEscrow.InvalidSplit.selector);
        escrow.deposit(ID, 101 ether, split, block.timestamp + 1 days);
        split.treasury = address(0);
        vm.expectRevert(DmwEscrow.InvalidSplit.selector);
        escrow.deposit(ID, 100 ether, split, block.timestamp + 1 days);
        split.treasury = address(escrow);
        vm.expectRevert(DmwEscrow.InvalidSplit.selector);
        escrow.deposit(ID, 100 ether, split, block.timestamp + 1 days);
        split = split100();
        split.landownerAmount = 0;
        split.burnAmount = 35 ether;
        vm.expectRevert(DmwEscrow.InvalidSplit.selector);
        escrow.deposit(ID, 100 ether, split, block.timestamp + 1 days);
        split = split100();
        split.burnAmount = type(uint256).max;
        vm.expectRevert();
        escrow.deposit(ID, 100 ether, split, block.timestamp + 1 days);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Unused && escrow.totalOpen() == 0);
    }

    function testRejectedPullDoesNotConsumeRequestId() public {
        vm.prank(PAYER);
        token.approve(address(escrow), 0);
        vm.expectRevert();
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), block.timestamp + 1 days);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Unused && escrow.totalOpen() == 0);
        vm.prank(PAYER);
        token.approve(address(escrow), 100 ether);
        deposit100(ID);
    }

    function testSignatureReplayAcrossRequestContractAndChainRefused() public {
        deposit100(ID);
        bytes memory sig = signature(ID);
        bytes32 secondId = keccak256("second");
        deposit100(secondId);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, secondId, sig);
        DmwEscrow second = new DmwEscrow(address(token), committee, ADMIN);
        vm.prank(PAYER);
        token.approve(address(second), 100 ether);
        uint256 expiry = escrow.getDeposit(PAYER, ID).expiry;
        vm.prank(PAYER);
        second.deposit(ID, 100 ether, split100(), expiry);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        second.release(PAYER, ID, sig);
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, ID, sig);
        vm.chainId(originalChain);
        escrow.release(PAYER, ID, sig);
    }

    function testIndependentTypedDataEncodingAndSplitBinding() public {
        uint256 expiry = deposit100(ID);
        bytes32 splitHash = keccak256(
            abi.encode(escrow.SPLIT_TYPEHASH(), TREASURY, 35 ether, FINDER, 30 ether, LANDOWNER, 15 ether, address(0), 0, 20 ether)
        );
        require(splitHash == escrow.getDeposit(PAYER, ID).splitHash);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DmwEscrow"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 body =
            keccak256(abi.encode(escrow.RELEASE_TYPEHASH(), ID, PAYER, 100 ether, splitHash, expiry, uint256(0)));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, body));
        require(digest == escrow.releaseDigest(PAYER, ID));
        bytes32 wrongBody =
            keccak256(abi.encode(escrow.RELEASE_TYPEHASH(), ID, PAYER, 100 ether, bytes32(0), expiry, uint256(0)));
        bytes memory wrong = sign(COMMITTEE_KEY, keccak256(abi.encodePacked(hex"1901", domain, wrongBody)));
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, ID, wrong);
        escrow.release(PAYER, ID, sign(COMMITTEE_KEY, digest));
    }

    function testWrongSignerMalformedAndMalleableSignaturesRefused() public {
        deposit100(ID);
        bytes32 digest = escrow.releaseDigest(PAYER, ID);
        bytes memory wrong = sign(NEXT_KEY, digest);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, ID, wrong);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        escrow.release(PAYER, ID, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(COMMITTEE_KEY, digest);
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        escrow.release(PAYER, ID, abi.encodePacked(r, highS, uint8(v == 27 ? 28 : 27)));
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        escrow.release(PAYER, ID, abi.encodePacked(r, s, uint8(0)));
        assertOpen(ID, 100 ether);
    }

    function testDonationIsInaccessibleSurplus() public {
        deposit100(ID);
        vm.prank(PAYER);
        require(token.transfer(address(escrow), 7 ether));
        escrow.release(PAYER, ID, signature(ID));
        require(escrow.totalOpen() == 0 && token.balanceOf(address(escrow)) == 7 ether);
    }

    function testAllBurnAndZeroBurnSplits() public {
        DmwEscrow.Split memory allBurn = DmwEscrow.Split(address(0), 0, address(0), 0, address(0), 0, address(0), 0, 100 ether);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, allBurn, block.timestamp + 1 days);
        escrow.release(PAYER, ID, signature(ID));
        require(token.totalSupply() == 999_900 ether && token.balanceOf(address(escrow)) == 0);
        bytes32 second = keccak256("treasury-only");
        DmwEscrow.Split memory noBurn = DmwEscrow.Split(TREASURY, 100 ether, address(0), 0, address(0), 0, address(0), 0, 0);
        vm.prank(PAYER);
        escrow.deposit(second, 100 ether, noBurn, block.timestamp + 1 days);
        escrow.release(PAYER, second, signature(second));
        require(token.balanceOf(TREASURY) == 100 ether && token.totalSupply() == 999_900 ether);
        require(escrow.totalOpen() == 0 && token.balanceOf(address(escrow)) == 0);
    }

    function testSharedRecipientsAndPayerAsRecipientRemainConserved() public {
        DmwEscrow.Split memory split =
            DmwEscrow.Split(PAYER, 35 ether, TREASURY, 30 ether, TREASURY, 15 ether, address(0), 0, 20 ether);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split, block.timestamp + 1 days);
        escrow.release(PAYER, ID, signature(ID));
        require(token.balanceOf(PAYER) == 999_935 ether && token.balanceOf(TREASURY) == 45 ether);
        require(token.totalSupply() == 999_980 ether && escrow.totalOpen() == 0);
    }

    function testFuzzConservationAndExactlyOneExit(
        uint96 treasury,
        uint96 finder,
        uint96 landowner,
        uint96 burn,
        bool releaseIt
    ) public {
        uint256 amount = uint256(treasury) + finder + landowner + burn + 1;
        token.mint(PAYER, amount);
        DmwEscrow.Split memory split = DmwEscrow.Split(
            treasury == 0 ? address(0) : TREASURY,
            treasury,
            finder == 0 ? address(0) : FINDER,
            finder,
            landowner == 0 ? address(0) : LANDOWNER,
            landowner, address(0), 0,
            uint256(burn) + 1
        );
        uint256 initialPayer = token.balanceOf(PAYER);
        uint256 initialSupply = token.totalSupply();
        uint256 expiry = block.timestamp + 1 days;
        vm.prank(PAYER);
        escrow.deposit(ID, amount, split, expiry);
        assertOpen(ID, amount);
        bytes memory sig = signature(ID);
        if (releaseIt) {
            escrow.release(PAYER, ID, sig);
            require(token.balanceOf(TREASURY) == treasury && token.balanceOf(FINDER) == finder);
            require(token.balanceOf(LANDOWNER) == landowner);
            require(token.totalSupply() == initialSupply - uint256(burn) - 1);
            require(token.balanceOf(PAYER) == initialPayer - amount);
        } else {
            vm.warp(expiry);
            escrow.refund(PAYER, ID);
            require(token.balanceOf(PAYER) == initialPayer && token.totalSupply() == initialSupply);
        }
        require(escrow.totalOpen() == 0 && token.balanceOf(address(escrow)) == 0);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.release(PAYER, ID, sig);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.refund(PAYER, ID);
    }

    function testFuzzExpiryBoundary(uint32 lifetimeSeed, uint32 advanceSeed) public {
        uint256 lifetime = escrow.MIN_EXPIRY() + uint256(lifetimeSeed) % (escrow.MAX_EXPIRY() - escrow.MIN_EXPIRY() + 1);
        uint256 expiry = block.timestamp + lifetime;
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), expiry);
        bytes memory sig = signature(ID);
        vm.warp(block.timestamp + uint256(advanceSeed) % (2 * escrow.MAX_EXPIRY()));
        if (block.timestamp < expiry) {
            vm.expectRevert(DmwEscrow.RefundTooEarly.selector);
            escrow.refund(PAYER, ID);
            escrow.release(PAYER, ID, sig);
        } else {
            vm.expectRevert(DmwEscrow.ReleaseExpired.selector);
            escrow.release(PAYER, ID, sig);
            escrow.refund(PAYER, ID);
        }
    }
}
