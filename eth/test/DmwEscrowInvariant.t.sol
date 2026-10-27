// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EscrowVm, DmwEscrow, LocalTap} from "./EscrowTestBase.sol";

contract EscrowHandler {
    EscrowVm private constant vm = EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LocalTap public token;
    DmwEscrow public escrow;
    bytes32[] public ids;
    address[] public payers;
    mapping(address => uint256) private nextIds;
    mapping(address => mapping(bytes32 => DmwEscrow.Status)) public terminal;
    uint256 public deposited;
    uint256 public released;
    uint256 public refunded;
    uint256 public burned;
    uint256 public treasuryPaid;
    uint256 public finderPaid;
    uint256 public landownerPaid;
    address private firstKey;
    address private secondKey;

    constructor() {
        firstKey = vm.addr(0xC011);
        secondKey = vm.addr(0xC022);
        token = new LocalTap(address(this));
        escrow = new DmwEscrow(address(token), firstKey, address(this));
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function deposit(uint96 seed, uint32 lifetime, uint8 payerSeed) external {
        uint256 amount = uint256(seed) % 1_000_000 ether + 100;
        address payer = address(uint160(0x1000 + uint256(payerSeed) % 3));
        token.mint(payer, amount);
        vm.prank(payer);
        token.approve(address(escrow), amount);
        bytes32 id = bytes32(++nextIds[payer]);
        uint256 expiry =
            block.timestamp + escrow.MIN_EXPIRY() + uint256(lifetime) % (escrow.MAX_EXPIRY() - escrow.MIN_EXPIRY() + 1);
        DmwEscrow.Split memory split = DmwEscrow.Split(
            address(0x2001),
            amount / 3,
            address(0x2002),
            amount / 4,
            address(0x2003),
            amount / 5, address(0), 0,
            amount - amount / 3 - amount / 4 - amount / 5
        );
        vm.prank(payer);
        escrow.deposit(id, amount, split, expiry);
        ids.push(id);
        payers.push(payer);
        deposited += amount;
    }

    function release(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        address payer = payers[seed % ids.length];
        DmwEscrow.Deposit memory record = escrow.getDeposit(payer, id);
        bytes memory sig = _sign(escrow.releaseDigest(payer, id));
        if (record.status != DmwEscrow.Status.Open) {
            vm.expectRevert(DmwEscrow.NotOpen.selector);
            escrow.release(payer, id, sig);
        } else if (block.timestamp >= record.expiry) {
            vm.expectRevert(DmwEscrow.ReleaseExpired.selector);
            escrow.release(payer, id, sig);
        } else {
            escrow.release(payer, id, sig);
            require(terminal[payer][id] == DmwEscrow.Status.Unused);
            terminal[payer][id] = DmwEscrow.Status.Released;
            released += record.amount;
            burned += record.split.burnAmount;
            treasuryPaid += record.split.treasuryAmount;
            finderPaid += record.split.finderAmount;
            landownerPaid += record.split.landownerAmount;
        }
    }

    function refund(uint256 seed) public {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        address payer = payers[seed % ids.length];
        DmwEscrow.Deposit memory record = escrow.getDeposit(payer, id);
        if (record.status != DmwEscrow.Status.Open) {
            vm.expectRevert(DmwEscrow.NotOpen.selector);
            escrow.refund(payer, id);
        } else if (block.timestamp < record.expiry) {
            vm.expectRevert(DmwEscrow.RefundTooEarly.selector);
            escrow.refund(payer, id);
        } else {
            escrow.refund(payer, id);
            require(terminal[payer][id] == DmwEscrow.Status.Unused);
            terminal[payer][id] = DmwEscrow.Status.Refunded;
            refunded += record.amount;
        }
    }

    function advance(uint32 seed) external {
        vm.warp(block.timestamp + uint256(seed) % 4 days);
    }

    function rotate(bool byAdmin) external {
        (address successor, uint256 at,,) = escrow.pendingCommittee();
        if (successor == address(0)) {
            successor = escrow.committee() == firstKey ? secondKey : firstKey;
            if (byAdmin) {
                vm.prank(escrow.admin());
                escrow.proposeCommitteeByAdmin(successor);
            } else {
                uint256 deadline = block.timestamp + 1 days;
                escrow.proposeCommittee(successor, deadline, _sign(escrow.rotationDigest(successor, deadline)));
            }
        } else if (block.timestamp < at) {
            vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
            escrow.applyCommittee();
        } else {
            escrow.applyCommittee();
        }
    }

    function handover() external {
        (address successor, uint256 at) = escrow.pendingAdmin();
        if (successor == address(0)) {
            address current = escrow.admin();
            vm.prank(current);
            escrow.proposeAdmin(current == address(this) ? address(0xAD02) : address(this));
        } else {
            if (block.timestamp < at) vm.expectRevert(DmwEscrow.DelayNotElapsed.selector);
            vm.prank(successor);
            escrow.acceptAdmin();
        }
    }

    function interfere() external {
        (address successor, uint256 at, uint256 nonce, bool adminOrigin) = escrow.pendingCommittee();
        if (!adminOrigin) return;
        uint256 nextNonce = escrow.rotationNonce();
        uint256 deadline = block.timestamp + 1 days;
        address otherParty = address(0xBAD);
        bytes memory sig = _sign(escrow.rotationDigest(otherParty, deadline));
        vm.expectRevert(DmwEscrow.AdminRecoveryPending.selector);
        escrow.proposeCommittee(otherParty, deadline, sig);
        (address stillSuccessor, uint256 stillAt, uint256 stillNonce, bool stillAdmin) = escrow.pendingCommittee();
        require(stillSuccessor == successor && stillAt == at && stillNonce == nonce && stillAdmin);
        require(escrow.rotationNonce() == nextNonce);
    }

    function _sign(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(escrow.committee() == firstKey ? 0xC011 : 0xC022, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract DmwEscrowInvariantTest {
    EscrowVm private constant vm = EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EscrowHandler private handler;
    DmwEscrow private escrow;
    LocalTap private token;

    function setUp() public {
        vm.warp(1_800_000_000);
        handler = new EscrowHandler();
        escrow = handler.escrow();
        token = handler.token();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantConservationAndImmutableTerminalStates() public view {
        uint256 openSum;
        uint256 releasedSum;
        uint256 refundedSum;
        for (uint256 i; i < handler.count(); i++) {
            bytes32 id = handler.ids(i);
            address payer = handler.payers(i);
            DmwEscrow.Deposit memory record = escrow.getDeposit(payer, id);
            require(record.payer == payer);
            DmwEscrow.Status terminal = handler.terminal(payer, id);
            if (terminal == DmwEscrow.Status.Unused) {
                require(record.status == DmwEscrow.Status.Open);
                openSum += record.amount;
            } else {
                require(record.status == terminal);
                if (terminal == DmwEscrow.Status.Released) {
                    releasedSum += record.amount;
                } else {
                    require(terminal == DmwEscrow.Status.Refunded);
                    refundedSum += record.amount;
                }
            }
        }
        require(escrow.totalOpen() == openSum && token.balanceOf(address(escrow)) == openSum);
        require(releasedSum == handler.released() && refundedSum == handler.refunded());
        require(handler.deposited() == openSum + releasedSum + refundedSum);
        require(token.totalSupply() == handler.deposited() - handler.burned());
        require(token.balanceOf(address(0x2001)) == handler.treasuryPaid());
        require(token.balanceOf(address(0x2002)) == handler.finderPaid());
        require(token.balanceOf(address(0x2003)) == handler.landownerPaid());
        require(
            token.balanceOf(address(0x1000)) + token.balanceOf(address(0x1001)) + token.balanceOf(address(0x1002))
                == refundedSum
        );
        require(token.balanceOf(address(handler)) == 0 && token.balanceOf(address(0xAD02)) == 0);
    }

    /// @dev Every remaining request must have an executable, committee-independent exit.
    function afterInvariant() public {
        vm.warp(block.timestamp + escrow.MAX_EXPIRY() + 1);
        for (uint256 i; i < handler.count(); i++) {
            if (escrow.getDeposit(handler.payers(i), handler.ids(i)).status == DmwEscrow.Status.Open) {
                handler.refund(i);
            }
        }
        invariantConservationAndImmutableTerminalStates();
        require(escrow.totalOpen() == 0 && handler.deposited() == handler.released() + handler.refunded());
    }
}
