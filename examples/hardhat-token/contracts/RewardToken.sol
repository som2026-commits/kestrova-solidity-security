// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// INTENTIONALLY VULNERABLE example for trying Kestrova. Do not deploy.
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RewardToken is ERC20 {
    address public owner;

    constructor() ERC20("Reward", "RWD") {
        owner = msg.sender;
    }

    // Bug: anyone can mint (missing access control), and tx.origin is used for auth below.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function sweep(address payable to) external {
        require(tx.origin == owner, "not owner");
        to.transfer(address(this).balance);
    }
}
