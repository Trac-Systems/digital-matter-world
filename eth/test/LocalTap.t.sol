// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LocalTap} from "../src/LocalTap.sol";

interface TestVm {
    function prank(address) external;
    function expectRevert() external;
}

contract LocalTapTest {
    TestVm constant vm = TestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LocalTap token;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function setUp() public { token = new LocalTap(address(this)); token.mint(ALICE, 100 ether); }
    function testMetadata() public view {
        require(keccak256(bytes(token.name())) == keccak256("Tap Protocol"));
        require(keccak256(bytes(token.symbol())) == keccak256("TAP"));
        require(token.decimals() == 18);
    }
    function testOnlyMinterCanMint() public {
        vm.expectRevert(); vm.prank(ALICE); token.mint(ALICE, 1);
        token.grantRole(token.MINTER_ROLE(), ALICE);
        vm.prank(ALICE); token.mint(BOB, 7 ether);
        require(token.balanceOf(BOB) == 7 ether);
        token.revokeRole(token.MINTER_ROLE(), ALICE);
        vm.expectRevert(); vm.prank(ALICE); token.mint(BOB, 1);
    }
    function testOnlyAdminManagesRoles() public {
        bytes32 role = token.MINTER_ROLE();
        vm.expectRevert(); vm.prank(ALICE); token.grantRole(role, BOB);
    }
    function testTransferHasNoFee() public {
        vm.prank(ALICE); token.transfer(BOB, 30 ether);
        require(token.balanceOf(ALICE) == 70 ether && token.balanceOf(BOB) == 30 ether);
        require(token.totalSupply() == 100 ether);
    }
    function testBurn() public {
        vm.prank(ALICE); token.burn(11 ether);
        require(token.balanceOf(ALICE) == 89 ether && token.totalSupply() == 89 ether);
    }
    function testBurnFromSpendsAllowance() public {
        vm.prank(ALICE); token.approve(BOB, 20 ether);
        vm.prank(BOB); token.burnFrom(ALICE, 12 ether);
        require(token.allowance(ALICE, BOB) == 8 ether && token.totalSupply() == 88 ether);
        vm.expectRevert(); vm.prank(BOB); token.burnFrom(ALICE, 9 ether);
    }
    function testCannotTransferBeyondBalance() public {
        vm.expectRevert(); vm.prank(ALICE); token.transfer(BOB, 101 ether);
    }
}
