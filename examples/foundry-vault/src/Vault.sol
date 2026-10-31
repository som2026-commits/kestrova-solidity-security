// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// INTENTIONALLY VULNERABLE example for trying Kestrova. Do not deploy.
import {IVault} from "./interfaces/IVault.sol";
import {MiniERC20} from "minitoken/MiniERC20.sol";

contract Vault is IVault {
    MiniERC20 public immutable receipt;
    mapping(address => uint256) public balanceOf;

    constructor(MiniERC20 receipt_) {
        receipt = receipt_;
    }

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    // Bug: external call before the balance is cleared (reentrancy).
    function withdraw() external {
        uint256 amount = balanceOf[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balanceOf[msg.sender] = 0;
    }
}
