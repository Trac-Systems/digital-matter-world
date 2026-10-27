// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EscrowTestBase, EscrowVm, DmwEscrow} from "./EscrowTestBase.sol";

contract DmwEscrowGovernanceTest is EscrowTestBase {
    function testCommitteeInterferenceCannotDelayAdminRecoveryAtOrAfterMaturity() public {
        deposit100(ID);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        (address successor, uint256 at, uint256 nonce, bool adminOrigin) = escrow.pendingCommittee();
        uint256 delay = escrow.ROTATION_DELAY();
        require(successor == nextCommittee && at == block.timestamp + delay && adminOrigin);
        uint256 nextNonce = escrow.rotationNonce();
        uint256 start = block.timestamp;
        uint256[5] memory offsets = [uint256(0), delay / 2, delay - 1, delay, delay + 1];
        for (uint256 i; i < offsets.length; i++) {
            vm.warp(start + offsets[i]);
            uint256 deadline = block.timestamp + 1 days;
            address replacement = vm.addr(0xBAD0 + i);
            bytes memory sig = sign(COMMITTEE_KEY, escrow.rotationDigest(replacement, deadline));
            vm.recordLogs();
            vm.expectRevert(DmwEscrow.AdminRecoveryPending.selector);
            vm.prank(RELAYER);
            escrow.proposeCommittee(replacement, deadline, sig);
            require(vm.getRecordedLogs().length == 0);
            (address stillSuccessor, uint256 stillAt, uint256 stillNonce, bool stillAdmin) = escrow.pendingCommittee();
            require(stillSuccessor == successor && stillAt == at && stillNonce == nonce && stillAdmin);
            require(escrow.rotationNonce() == nextNonce && escrow.committee() == committee);
            if (block.timestamp < at) {
                vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
                escrow.applyCommittee();
            }
        }
        vm.prank(RELAYER);
        escrow.applyCommittee();
        require(escrow.committee() == nextCommittee && escrow.committeeEpoch() == 1);
        (address pending,,, bool stillAdminOrigin) = escrow.pendingCommittee();
        require(pending == address(0) && !stillAdminOrigin);
        assertOpen(ID, 100 ether);
    }

    function testAdminRecoveryAppliesAtMaturityDespiteSameTimestampInterference() public {
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        (, uint256 at,,) = escrow.pendingCommittee();
        vm.warp(at);
        bytes memory sig = sign(COMMITTEE_KEY, escrow.rotationDigest(RELAYER, at));
        vm.expectRevert(DmwEscrow.AdminRecoveryPending.selector);
        escrow.proposeCommittee(RELAYER, at, sig);
        escrow.applyCommittee();
        require(escrow.committee() == nextCommittee);
    }

    function testAdminPreemptsCommitteeProposalAndEveryAdminReplacementWaitsFullDelay() public {
        uint256 deadline = block.timestamp + 1 days;
        escrow.proposeCommittee(
            nextCommittee, deadline, sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline))
        );
        (, uint256 committeeAt,, bool origin) = escrow.pendingCommittee();
        require(!origin);
        vm.warp(committeeAt);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(RELAYER);
        (, uint256 adminAt,, bool adminOrigin) = escrow.pendingCommittee();
        require(adminOrigin && adminAt == block.timestamp + escrow.ROTATION_DELAY());
        vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
        escrow.applyCommittee();
        vm.warp(adminAt);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        (, uint256 replacementAt,, bool replacementOrigin) = escrow.pendingCommittee();
        require(replacementOrigin && replacementAt == block.timestamp + escrow.ROTATION_DELAY());
        vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
        escrow.applyCommittee();
        vm.warp(replacementAt);
        escrow.applyCommittee();
        require(escrow.committee() == nextCommittee);
    }

    function testCommitteeCanReplaceItsOwnProposalAndResumeAfterAdminRecovery() public {
        uint256 deadline = block.timestamp + 1 days;
        escrow.proposeCommittee(
            nextCommittee, deadline, sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline))
        );
        vm.warp(block.timestamp + 1);
        escrow.proposeCommittee(RELAYER, deadline, sign(COMMITTEE_KEY, escrow.rotationDigest(RELAYER, deadline)));
        (address successor, uint256 at, uint256 nonce, bool origin) = escrow.pendingCommittee();
        require(successor == RELAYER && at == block.timestamp + escrow.ROTATION_DELAY() && nonce == 1 && !origin);
        rotate(nextCommittee);
        deadline = block.timestamp + 1 days;
        escrow.proposeCommittee(committee, deadline, sign(NEXT_KEY, escrow.rotationDigest(committee, deadline)));
        (successor, at,, origin) = escrow.pendingCommittee();
        require(successor == committee && at == block.timestamp + escrow.ROTATION_DELAY() && !origin);
    }

    function testOriginTracksEntryPointEvenWhenAdminAndCommitteeAreSameAddress() public {
        escrow = new DmwEscrow(address(token), committee, committee);
        uint256 deadline = block.timestamp + 1 days;
        escrow.proposeCommittee(
            nextCommittee, deadline, sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline))
        );
        (,,, bool committeeOrigin) = escrow.pendingCommittee();
        require(!committeeOrigin);
        vm.recordLogs();
        vm.prank(committee);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        EscrowVm.Log[] memory logs = vm.getRecordedLogs();
        EscrowVm.Log memory scheduled = logs[logs.length - 1];
        require(
            scheduled.topics[0]
                == keccak256("CommitteeRotationScheduled(address,address,address,uint256,uint256,uint256,bool)")
        );
        (uint256 at, uint256 nonce, uint256 epoch, bool adminOrigin) =
            abi.decode(scheduled.data, (uint256, uint256, uint256, bool));
        require(adminOrigin && at == block.timestamp + escrow.ROTATION_DELAY() && nonce == 1 && epoch == 0);
        bytes memory sig = sign(COMMITTEE_KEY, escrow.rotationDigest(RELAYER, deadline));
        vm.expectRevert(DmwEscrow.AdminRecoveryPending.selector);
        escrow.proposeCommittee(RELAYER, deadline, sig);
    }

    function testCommitteeSignedRotationDelayedAndSingleUse() public {
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline));
        vm.prank(RELAYER);
        escrow.proposeCommittee(nextCommittee, deadline, sig);
        (address successor, uint256 at, uint256 nonce,) = escrow.pendingCommittee();
        require(successor == nextCommittee && at == block.timestamp + escrow.ROTATION_DELAY() && nonce == 0);
        require(escrow.rotationNonce() == 1 && escrow.committee() == committee);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(nextCommittee, deadline, sig);
        vm.warp(at - 1);
        vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
        escrow.applyCommittee();
        vm.warp(at);
        vm.prank(RELAYER);
        escrow.applyCommittee();
        require(escrow.committee() == nextCommittee && escrow.committeeEpoch() == 1);
        vm.expectRevert(DmwEscrow.NoProposal.selector);
        escrow.applyCommittee();
    }

    function testAdminRotationUsesSameDelayAndReplacementRestartsIt() public {
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        (, uint256 originalAt,,) = escrow.pendingCommittee();
        vm.warp(originalAt - 1);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(address(0xC033));
        (, uint256 replacementAt, uint256 nonce,) = escrow.pendingCommittee();
        require(replacementAt == block.timestamp + escrow.ROTATION_DELAY() && nonce == 1);
        vm.warp(originalAt);
        vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
        escrow.applyCommittee();
        vm.warp(replacementAt);
        escrow.applyCommittee();
        require(escrow.committee() == address(0xC033));
    }

    function testOnlyCurrentCommitteeAtExecutionAndNoRevivalOnReturn() public {
        deposit100(ID);
        bytes memory oldSig = signature(ID);
        rotate(nextCommittee);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, ID, oldSig);
        bytes memory newSig = sign(NEXT_KEY, escrow.releaseDigest(PAYER, ID));
        rotate(committee);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, ID, oldSig);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.release(PAYER, ID, newSig);
        escrow.release(PAYER, ID, signature(ID));
    }

    function testExistingDepositReleasedByNewCommittee() public {
        deposit100(ID);
        rotate(nextCommittee);
        escrow.release(PAYER, ID, sign(NEXT_KEY, escrow.releaseDigest(PAYER, ID)));
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Released);
    }

    function testCurrentKeyStillValidWhileRotationIsPending() public {
        deposit100(ID);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        escrow.release(PAYER, ID, signature(ID));
    }

    function testRotationSignatureBindsSuccessorDeadlineNonceEpochAndDomain() public {
        uint256 deadline = block.timestamp + 20 days;
        bytes memory sig = sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline));
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(address(0xC033), deadline, sig);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(nextCommittee, deadline + 1, sig);
        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(nextCommittee, deadline, sig);
        vm.chainId(originalChain);
        DmwEscrow second = new DmwEscrow(address(token), committee, ADMIN);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        second.proposeCommittee(nextCommittee, deadline, sig);
        rotate(nextCommittee);
        rotate(committee);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(nextCommittee, deadline, sig);
    }

    function testExpiredOrWrongCommitteeRotationRefused() public {
        uint256 deadline = block.timestamp;
        bytes memory sig = sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(DmwEscrow.SignatureExpired.selector);
        escrow.proposeCommittee(nextCommittee, deadline, sig);
        deadline = block.timestamp + 1 days;
        sig = sign(NEXT_KEY, escrow.rotationDigest(nextCommittee, deadline));
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(nextCommittee, deadline, sig);
    }

    function testTwoStepAdminHandoverClearsPendingKeyAndInvalidatesUnsubmittedSignature() public {
        address successor = address(0xAD02);
        uint256 deadline = block.timestamp + 10 days;
        bytes memory unsubmitted = sign(COMMITTEE_KEY, escrow.rotationDigest(nextCommittee, deadline));
        vm.prank(ADMIN);
        escrow.proposeAdmin(successor);
        (, uint256 at) = escrow.pendingAdmin();
        vm.expectRevert(DmwEscrow.Unauthorized.selector);
        escrow.acceptAdmin();
        vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
        vm.prank(successor);
        escrow.acceptAdmin();
        require(escrow.admin() == ADMIN);
        vm.warp(at);
        vm.prank(successor);
        escrow.acceptAdmin();
        require(escrow.admin() == successor);
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        escrow.proposeCommittee(nextCommittee, deadline, unsubmitted);
        vm.expectRevert(DmwEscrow.Unauthorized.selector);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        vm.prank(successor);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        vm.prank(successor);
        escrow.proposeAdmin(ADMIN);
        (, at) = escrow.pendingAdmin();
        vm.warp(at);
        vm.prank(ADMIN);
        escrow.acceptAdmin();
        (address pending,,,) = escrow.pendingCommittee();
        require(pending == address(0));
        vm.expectRevert(DmwEscrow.NoProposal.selector);
        escrow.applyCommittee();
    }

    function testAdminProposalReplacementRestartsDelay() public {
        vm.prank(ADMIN);
        escrow.proposeAdmin(RELAYER);
        (, uint256 at) = escrow.pendingAdmin();
        vm.warp(at);
        vm.prank(ADMIN);
        escrow.proposeAdmin(PAYER);
        vm.expectRevert(DmwEscrow.Unauthorized.selector);
        vm.prank(RELAYER);
        escrow.acceptAdmin();
        vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
        vm.prank(PAYER);
        escrow.acceptAdmin();
    }

    function testInvalidAuthoritiesAndUnauthorizedAdministrationRefused() public {
        vm.expectRevert(DmwEscrow.InvalidAddress.selector);
        new DmwEscrow(address(0), committee, ADMIN);
        vm.expectRevert(DmwEscrow.InvalidAddress.selector);
        new DmwEscrow(address(token), address(0), ADMIN);
        vm.expectRevert(DmwEscrow.InvalidAddress.selector);
        new DmwEscrow(address(token), committee, address(0));
        vm.expectRevert(DmwEscrow.Unauthorized.selector);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        vm.expectRevert(DmwEscrow.Unauthorized.selector);
        escrow.proposeAdmin(RELAYER);
        vm.expectRevert(DmwEscrow.NoProposal.selector);
        escrow.acceptAdmin();
        address[3] memory invalidKeys = [address(0), address(escrow), committee];
        for (uint256 i; i < invalidKeys.length; i++) {
            vm.expectRevert(DmwEscrow.InvalidAddress.selector);
            vm.prank(ADMIN);
            escrow.proposeCommitteeByAdmin(invalidKeys[i]);
        }
        address[3] memory invalidAdmins = [address(0), address(escrow), ADMIN];
        for (uint256 i; i < invalidAdmins.length; i++) {
            vm.expectRevert(DmwEscrow.InvalidAddress.selector);
            vm.prank(ADMIN);
            escrow.proposeAdmin(invalidAdmins[i]);
        }
    }

    function testAdminCannotMoveFundsOrStopRefundDuringGovernance() public {
        uint256 expiry = deposit100(ID);
        bytes memory adminSig = sign(0xAD01, escrow.releaseDigest(PAYER, ID));
        vm.expectRevert(DmwEscrow.InvalidSigner.selector);
        vm.prank(ADMIN);
        escrow.release(PAYER, ID, adminSig);
        vm.expectRevert(DmwEscrow.RefundTooEarly.selector);
        vm.prank(ADMIN);
        escrow.refund(PAYER, ID);
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(nextCommittee);
        vm.prank(ADMIN);
        escrow.proposeAdmin(RELAYER);
        assertOpen(ID, 100 ether);
        vm.warp(expiry);
        escrow.refund(PAYER, ID);
        require(token.balanceOf(ADMIN) == 0 && token.balanceOf(PAYER) == 1_000_000 ether);
        require(escrow.totalOpen() == 0);
    }
}
