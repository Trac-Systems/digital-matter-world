// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EscrowTestBase, DmwEscrow} from "./EscrowTestBase.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Deliberately nonstandard token behaviors used to exercise custody rollback.
contract ConfigurableTap is ERC20 {
    enum Mode {
        Normal,
        NoReturn,
        FalseReturn,
        Tax,
        Bonus
    }
    Mode public mode;
    address public blockedRecipient;
    bool public rejectBurn;
    address public callbackTarget;
    bytes public callbackData;
    uint256 public callbacks;
    bytes4 public callbackError;

    constructor() ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configure(Mode next, address blocked, bool burnFailure) external {
        mode = next;
        blockedRecipient = blocked;
        rejectBurn = burnFailure;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.FalseReturn) return false;
        super.transferFrom(from, to, amount);
        if (mode == Mode.Tax) _burn(to, 1);
        if (mode == Mode.Bonus) _mint(to, 1);
        _callback();
        if (mode == Mode.NoReturn) assembly ("memory-safe") { return(0, 0) }
        return true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(to != blockedRecipient, "recipient rejected");
        if (mode == Mode.FalseReturn) return false;
        super.transfer(to, amount);
        _callback();
        if (mode == Mode.NoReturn) assembly ("memory-safe") { return(0, 0) }
        return true;
    }

    function burn(uint256 amount) external {
        require(!rejectBurn, "burn rejected");
        _burn(msg.sender, amount);
        _callback();
    }

    function _callback() private {
        if (callbackTarget == address(0)) return;
        (bool ok, bytes memory reason) = callbackTarget.call(callbackData);
        require(!ok && reason.length >= 4, "callback must be refused");
        callbacks++;
        callbackError = bytes4(reason);
    }
}

contract DmwEscrowTokensTest is EscrowTestBase {
    ConfigurableTap internal unusual;

    function setUp() public override {
        super.setUp();
        unusual = new ConfigurableTap();
        escrow = new DmwEscrow(address(unusual), committee, ADMIN);
        unusual.mint(PAYER, 1000 ether);
        vm.prank(PAYER);
        unusual.approve(address(escrow), type(uint256).max);
    }

    function assertUnchanged() internal view {
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Open && escrow.totalOpen() == 100 ether);
        require(unusual.balanceOf(address(escrow)) == 100 ether && unusual.balanceOf(PAYER) == 900 ether);
        require(unusual.balanceOf(TREASURY) == 0 && unusual.balanceOf(FINDER) == 0);
        require(unusual.balanceOf(LANDOWNER) == 0 && unusual.totalSupply() == 1000 ether);
    }

    function testNoBooleanReturnSupportsDepositReleaseAndRefund() public {
        unusual.configure(ConfigurableTap.Mode.NoReturn, address(0), false);
        deposit100(ID);
        escrow.release(PAYER, ID, signature(ID));
        require(unusual.balanceOf(TREASURY) == 35 ether && unusual.totalSupply() == 980 ether);
        bytes32 next = keccak256("refund");
        uint256 expiry = deposit100(next);
        vm.warp(expiry);
        escrow.refund(PAYER, next);
        require(unusual.balanceOf(PAYER) == 900 ether && escrow.totalOpen() == 0);
    }

    function testTaxAndBonusDepositsRollbackExactly() public {
        for (uint256 i; i < 2; i++) {
            unusual.configure(i == 0 ? ConfigurableTap.Mode.Tax : ConfigurableTap.Mode.Bonus, address(0), false);
            vm.expectRevert(DmwEscrow.InexactTransfer.selector);
            vm.prank(PAYER);
            escrow.deposit(ID, 100 ether, split100(), block.timestamp + 1 days);
            require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Unused && escrow.totalOpen() == 0);
            require(unusual.balanceOf(PAYER) == 1000 ether && unusual.balanceOf(address(escrow)) == 0);
            require(unusual.totalSupply() == 1000 ether);
        }
    }

    function testFalseReturnsRollbackDepositAndRelease() public {
        unusual.configure(ConfigurableTap.Mode.FalseReturn, address(0), false);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(unusual)));
        vm.prank(PAYER);
        escrow.deposit(ID, 100 ether, split100(), block.timestamp + 1 days);
        require(escrow.getDeposit(PAYER, ID).status == DmwEscrow.Status.Unused);
        unusual.configure(ConfigurableTap.Mode.Normal, address(0), false);
        deposit100(ID);
        unusual.configure(ConfigurableTap.Mode.FalseReturn, address(0), false);
        bytes memory sig = signature(ID);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(unusual)));
        escrow.release(PAYER, ID, sig);
        assertUnchanged();
    }

    function testThirdTransferAndBurnFailureRollbackAllEarlierTransfers() public {
        deposit100(ID);
        bytes memory sig = signature(ID);
        unusual.configure(ConfigurableTap.Mode.Normal, LANDOWNER, false);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "recipient rejected"));
        escrow.release(PAYER, ID, sig);
        assertUnchanged();
        unusual.configure(ConfigurableTap.Mode.Normal, address(0), true);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "burn rejected"));
        escrow.release(PAYER, ID, sig);
        assertUnchanged();
        unusual.configure(ConfigurableTap.Mode.Normal, address(0), false);
        escrow.release(PAYER, ID, sig);
        require(escrow.totalOpen() == 0 && unusual.balanceOf(address(escrow)) == 0);
    }

    function testRefundFailureRemainsRetryable() public {
        uint256 expiry = deposit100(ID);
        vm.warp(expiry);
        unusual.configure(ConfigurableTap.Mode.FalseReturn, address(0), false);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(unusual)));
        escrow.refund(PAYER, ID);
        assertUnchanged();
        unusual.configure(ConfigurableTap.Mode.Normal, address(0), false);
        escrow.refund(PAYER, ID);
        require(unusual.balanceOf(PAYER) == 1000 ether && escrow.totalOpen() == 0);
    }

    function testDepositReentrancyGuard() public {
        unusual.setCallback(
            address(escrow), abi.encodeCall(escrow.deposit, (ID, 100 ether, split100(), block.timestamp + 1 days))
        );
        deposit100(ID);
        require(
            unusual.callbacks() == 1 && unusual.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertUnchanged();
    }

    function testReleaseTransferAndBurnReentrancyGuard() public {
        deposit100(ID);
        bytes memory sig = signature(ID);
        unusual.setCallback(address(escrow), abi.encodeCall(escrow.release, (PAYER, ID, sig)));
        escrow.release(PAYER, ID, sig);
        require(
            unusual.callbacks() == 4 && unusual.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        require(escrow.totalOpen() == 0 && unusual.totalSupply() == 980 ether);
    }

    function testRefundReentrancyGuard() public {
        uint256 expiry = deposit100(ID);
        unusual.setCallback(address(escrow), abi.encodeCall(escrow.refund, (PAYER, ID)));
        vm.warp(expiry);
        escrow.refund(PAYER, ID);
        require(
            unusual.callbacks() == 1 && unusual.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        require(unusual.balanceOf(PAYER) == 1000 ether && escrow.totalOpen() == 0);
    }

    function testTokenCallbackCannotChangeGovernance() public {
        escrow = new DmwEscrow(address(unusual), committee, address(unusual));
        vm.prank(PAYER);
        unusual.approve(address(escrow), type(uint256).max);
        unusual.setCallback(address(escrow), abi.encodeCall(escrow.proposeCommitteeByAdmin, (nextCommittee)));
        deposit100(ID);
        require(unusual.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        (address pending,,,) = escrow.pendingCommittee();
        require(pending == address(0));
    }
}
