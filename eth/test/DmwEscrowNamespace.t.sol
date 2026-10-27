// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EscrowTestBase, EscrowVm, DmwEscrow} from "./EscrowTestBase.sol";

contract DmwEscrowNamespaceTest is EscrowTestBase {
    function testOneUnitFrontRunCannotReserveAnotherPayersRequest() public {
        uint256 otherExpiry = block.timestamp + escrow.MIN_EXPIRY();
        token.mint(RELAYER, 1);
        vm.prank(RELAYER);
        token.approve(address(escrow), 1);
        DmwEscrow.Split memory allBurn = DmwEscrow.Split(address(0), 0, address(0), 0, address(0), 0, address(0), 0, 1);
        vm.prank(RELAYER);
        escrow.deposit(ID, 1, allBurn, otherExpiry);

        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Unused);
        uint256 payerExpiry = deposit100(ID);
        require(escrow.totalOpen() == 100 ether + 1 && token.balanceOf(address(escrow)) == 100 ether + 1);
        vm.warp(otherExpiry);
        escrow.refund(RELAYER, ID);
        require(token.balanceOf(RELAYER) == 1);
        require(escrow.getDeposit(RELAYER, ID).status == DmwEscrow.Status.Refunded);
        require(escrow.getDeposit(PAYER, ID).expiry == payerExpiry);
        assertOpen(ID, 100 ether);

        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        vm.prank(RELAYER);
        escrow.deposit(ID, 1, allBurn, block.timestamp + 1 days);
        escrow.release(PAYER, ID, signature(ID));
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Released);
        require(escrow.totalOpen() == 0 && token.balanceOf(address(escrow)) == 0);
    }

    function testRefundedOtherPayerIdDoesNotPreventLaterPayerDeposit() public {
        uint256 expiry = block.timestamp + escrow.MIN_EXPIRY();
        token.mint(RELAYER, 1);
        vm.prank(RELAYER);
        token.approve(address(escrow), 1);
        DmwEscrow.Split memory allBurn = DmwEscrow.Split(address(0), 0, address(0), 0, address(0), 0, address(0), 0, 1);
        vm.prank(RELAYER);
        escrow.deposit(ID, 1, allBurn, expiry);
        vm.warp(expiry);
        escrow.refund(RELAYER, ID);
        deposit100(ID);
        assertOpen(ID, 100 ether);
        require(escrow.getDeposit(RELAYER, ID).status == DmwEscrow.Status.Refunded);
    }

    function testLookupsAndExitEventsIdentifyPayer() public {
        uint256 expiry = deposit100(ID);
        token.mint(RELAYER, 100 ether);
        vm.prank(RELAYER);
        token.approve(address(escrow), 100 ether);
        vm.prank(RELAYER);
        escrow.deposit(ID, 100 ether, split100(), expiry);
        require(escrow.getDeposit(address(0), ID).status == DmwEscrow.Status.Unused);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.refund(address(0), ID);

        bytes memory sig = signature(ID);
        vm.recordLogs();
        vm.prank(RELAYER);
        escrow.release(PAYER, ID, sig);
        EscrowVm.Log[] memory logs = vm.getRecordedLogs();
        EscrowVm.Log memory released = logs[logs.length - 1];
        require(released.emitter == address(escrow));
        require(released.topics[0] == keccak256("Released(bytes32,address,address,bytes32,uint256,address,uint256)"));
        require(released.topics[1] == ID && released.topics[2] == bytes32(uint256(uint160(PAYER))));
        require(released.topics[3] == bytes32(uint256(uint160(RELAYER))));
        require(escrow.getDeposit(RELAYER, ID).status == DmwEscrow.Status.Open);

        vm.warp(expiry);
        vm.recordLogs();
        vm.prank(PAYER);
        escrow.refund(RELAYER, ID);
        logs = vm.getRecordedLogs();
        EscrowVm.Log memory refunded = logs[logs.length - 1];
        require(refunded.emitter == address(escrow));
        require(refunded.topics[0] == keccak256("Refunded(bytes32,address,address,uint256)"));
        require(refunded.topics[1] == ID && refunded.topics[2] == bytes32(uint256(uint160(RELAYER))));
        require(refunded.topics[3] == bytes32(uint256(uint160(PAYER))));
        require(token.balanceOf(RELAYER) == 100 ether);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Released);
        require(escrow.getDeposit(RELAYER, ID).status == DmwEscrow.Status.Refunded);
    }

    function testFuzzSameRequestSignaturesAndExitsArePayerBound(uint96 seed, bool releasePayer) public {
        uint256 amount = uint256(seed) + 1;
        token.mint(PAYER, amount);
        token.mint(RELAYER, amount);
        vm.prank(RELAYER);
        token.approve(address(escrow), amount);
        uint256 expiry = block.timestamp + 1 days;
        DmwEscrow.Split memory allBurn = DmwEscrow.Split(address(0), 0, address(0), 0, address(0), 0, address(0), 0, amount);
        vm.prank(PAYER);
        escrow.deposit(ID, amount, allBurn, expiry);
        vm.prank(RELAYER);
        escrow.deposit(ID, amount, allBurn, expiry);
        require(escrow.releaseDigest(PAYER, ID) != escrow.releaseDigest(RELAYER, ID));
        address releasedPayer = releasePayer ? PAYER : RELAYER;
        address refundedPayer = releasePayer ? RELAYER : PAYER;
        bytes memory sig = sign(COMMITTEE_KEY, escrow.releaseDigest(releasedPayer, ID));
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(refundedPayer, ID, sig);
        escrow.release(releasedPayer, ID, sig);
        require(escrow.getDeposit(refundedPayer, ID).status == DmwEscrow.Status.Open);
        require(escrow.totalOpen() == amount && token.balanceOf(address(escrow)) == amount);
        uint256 balanceBefore = token.balanceOf(refundedPayer);
        vm.warp(expiry);
        escrow.refund(refundedPayer, ID);
        require(token.balanceOf(refundedPayer) == balanceBefore + amount);
        require(escrow.getDeposit(releasedPayer, ID).status == DmwEscrow.Status.Released);
        require(escrow.getDeposit(refundedPayer, ID).status == DmwEscrow.Status.Refunded);
        require(escrow.totalOpen() == 0 && token.balanceOf(address(escrow)) == 0);
        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        vm.prank(releasedPayer);
        escrow.deposit(ID, amount, allBurn, block.timestamp + 1 days);
        vm.expectRevert(DmwEscrow.InvalidRequest.selector);
        vm.prank(refundedPayer);
        escrow.deposit(ID, amount, allBurn, block.timestamp + 1 days);
    }
}
