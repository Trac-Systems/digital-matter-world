// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {EscrowTestBase} from "./EscrowTestBase.sol";
import {DmwEscrow} from "../src/DmwEscrow.sol";

contract DmwEscrowPayFirstTest is EscrowTestBase {
    function testSplitTypeHashAndAbiHaveExactlyFourRecipientsAndBurn() public view {
        require(escrow.SPLIT_TYPEHASH() == keccak256(
            "Split(address treasury,uint256 treasuryAmount,address finder,uint256 finderAmount,address landowner,uint256 landownerAmount,address discoverer,uint256 discovererAmount,uint256 burnAmount)"
        ));
        require(abi.encode(split100()).length == 9 * 32);
    }

    function testEveryRecipientCanSubmitAndAllFiveSharesArePaidOnce() public {
        address discoverer = address(0xD15C);
        DmwEscrow.Split memory split = DmwEscrow.Split(
            TREASURY, 30 ether, FINDER, 30 ether, LANDOWNER, 15 ether,
            discoverer, 5 ether, 20 ether
        );
        uint256 expiry = block.timestamp + 10 days;
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split, expiry);
        bytes memory sig = signature(ID);
        uint256 supply = token.totalSupply();
        vm.prank(discoverer);
        escrow.release(PAYER, ID, sig);
        require(token.balanceOf(TREASURY) == 30 ether);
        require(token.balanceOf(FINDER) == 30 ether);
        require(token.balanceOf(LANDOWNER) == 15 ether);
        require(token.balanceOf(discoverer) == 5 ether);
        require(token.totalSupply() == supply - 20 ether);
        require(escrow.totalOpen() == 0);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        vm.prank(TREASURY);
        escrow.release(PAYER, ID, sig);
        vm.warp(expiry);
        vm.expectRevert(DmwEscrow.NotOpen.selector);
        escrow.refund(PAYER, ID);
    }

    function testNewDestinationsAndAmountsAreInTheSignatureCommitment() public {
        DmwEscrow.Split memory split = split100();
        bytes32 original = escrow.hashSplit(split);
        split.treasuryAmount -= 5 ether;
        split.discoverer = address(0xD15C);
        split.discovererAmount = 5 ether;
        require(escrow.hashSplit(split) != original);
        bytes32 withDiscoverer = escrow.hashSplit(split);
        split.discoverer = address(0xD15D);
        require(escrow.hashSplit(split) != withDiscoverer);
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split, block.timestamp + 10 days);
        vm.prank(address(0x123456));
        escrow.release(PAYER, ID, signature(ID));
        require(token.balanceOf(split.discoverer) == 5 ether);
    }
}
