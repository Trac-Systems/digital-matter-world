// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LocalTap} from "../src/LocalTap.sol";
import {DmwEscrow} from "../src/DmwEscrow.sol";
import {BroadcastVm} from "./Deploy.s.sol";

/// @notice Deploy a disposable token and escrow using an unlocked local Anvil account.
contract DeployEscrow {
    BroadcastVm private constant vm = BroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run(address admin, address committee, address payer) external returns (LocalTap token, DmwEscrow escrow) {
        require(block.chainid == 31337, "Local chain only");
        require(payer != address(0), "Payer required");
        vm.startBroadcast(admin);
        token = new LocalTap(admin);
        token.mint(payer, 1000 ether);
        escrow = new DmwEscrow(address(token), committee, admin);
        vm.stopBroadcast();
    }
}
