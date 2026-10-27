// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DmwEscrow} from "../src/DmwEscrow.sol";
import {LocalTap} from "../src/LocalTap.sol";

interface EscrowVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

abstract contract EscrowTestBase {
    EscrowVm internal constant vm = EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant COMMITTEE_KEY = 0xC011;
    uint256 internal constant NEXT_KEY = 0xC022;
    address internal constant PAYER = address(0xA11CE);
    address internal ADMIN;
    address internal constant TREASURY = address(0x7001);
    address internal constant FINDER = address(0xF001);
    address internal constant LANDOWNER = address(0x1001);
    address internal constant RELAYER = address(0xB0B);
    bytes32 internal constant ID = keccak256("request");
    LocalTap internal token;
    DmwEscrow internal escrow;
    address internal committee;
    address internal nextCommittee;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        committee = vm.addr(COMMITTEE_KEY);
        nextCommittee = vm.addr(NEXT_KEY);
        ADMIN = vm.addr(0xAD01);
        token = new LocalTap(address(this));
        escrow = new DmwEscrow(address(token), committee, ADMIN);
        token.mint(PAYER, 1_000_000 ether);
        vm.prank(PAYER);
        token.approve(address(escrow), type(uint256).max);
    }

    function split100() internal pure returns (DmwEscrow.Split memory) {
        return DmwEscrow.Split(TREASURY, 35 ether, FINDER, 30 ether, LANDOWNER, 15 ether, address(0), 0, 20 ether);
    }

    function deposit100(bytes32 id) internal returns (uint256 expiry) {
        expiry = block.timestamp + 10 days;
        vm.prank(PAYER);
        escrow.deposit(id, 100 ether, split100(), expiry);
    }

    function sign(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function signature(bytes32 id) internal returns (bytes memory) {
        return sign(COMMITTEE_KEY, escrow.releaseDigest(PAYER, id));
    }

    function rotate(address successor) internal {
        vm.prank(ADMIN);
        escrow.proposeCommitteeByAdmin(successor);
        (, uint256 at,,) = escrow.pendingCommittee();
        vm.warp(at);
        escrow.applyCommittee();
    }

    function assertOpen(bytes32 id, uint256 amount) internal view {
        require(escrow.getDeposit(PAYER, id).status == DmwEscrow.Status.Open, "not open");
        require(escrow.totalOpen() == amount, "open accounting");
        require(token.balanceOf(address(escrow)) == amount, "escrow balance");
    }
}
