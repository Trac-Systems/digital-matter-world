// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LocalTap} from "../src/LocalTap.sol";

interface BroadcastVm {
    function startBroadcast(address) external;
    function stopBroadcast() external;
}

contract Deploy {
    BroadcastVm constant vm = BroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run(address admin, address recipient) external returns (LocalTap token) {
        require(block.chainid == 31337, "Local chain only");
        vm.startBroadcast(admin);
        token = new LocalTap(admin);
        token.mint(admin, 1_000_000 ether);
        token.mint(recipient, 1_000_000 ether);
        vm.stopBroadcast();
    }
}
