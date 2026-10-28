// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../src/CommitRevealAuction.sol";

function run(uint256 _commitDuration, uint256 _revealDuration) {
    CommitRevealAuction auction = new CommitRevealAuction(_commitDuration, _revealDuration);
}
