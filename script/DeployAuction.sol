// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CommitRevealAuction} from "../src/CommitRevealAuction.sol";

/// @notice Manual deployment helper:
///         forge script script/DeployAuction.sol --rpc-url http://127.0.0.1:8545 \
///             --unlocked --from <ANVIL_ACCOUNT_0> --broadcast --sig "run(uint256,uint256)" 120 180
///         scripts/dev.sh deploys via `forge create` directly and does not use this script.
contract DeployAuction is Script {
    function run(uint256 commitDuration, uint256 revealDuration) external returns (CommitRevealAuction) {
        vm.startBroadcast();
        CommitRevealAuction auction = new CommitRevealAuction(commitDuration, revealDuration);
        vm.stopBroadcast();
        console2.log("Deployed CommitRevealAuction at:", address(auction));
        return auction;
    }
}
