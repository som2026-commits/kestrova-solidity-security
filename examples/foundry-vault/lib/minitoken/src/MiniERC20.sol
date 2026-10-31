// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal token used as a stand-in library dependency in the example (not a real library).
contract MiniERC20 {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
