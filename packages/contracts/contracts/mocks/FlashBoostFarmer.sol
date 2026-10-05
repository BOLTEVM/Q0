// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFarm {
    function deposit(uint256 pid, uint256 amount) external;
    function harvest(uint256 pid) external;
}

/// @dev Test-only attacker. Stakes normally, then in ONE transaction borrows the boost token from a
///      willing holder (who has approved it), harvests, and hands the token straight back. If the boost is
///      a bare balance check, this earns the boost without ever holding the token.
contract FlashBoostFarmer {
    IFarm public immutable farm;
    IERC20 public immutable qrb;
    IERC20 public immutable lp;

    constructor(IFarm farm_, IERC20 qrb_, IERC20 lp_) {
        farm = farm_;
        qrb = qrb_;
        lp = lp_;
        lp_.approve(address(farm_), type(uint256).max);
    }

    function stake(uint256 pid, uint256 amount) external {
        farm.deposit(pid, amount);
    }

    /// @param lender holder that has approved this contract for `borrow` QRB.
    function harvestBoosted(uint256 pid, address lender, uint256 borrow) external {
        qrb.transferFrom(lender, address(this), borrow);
        farm.harvest(pid);
        qrb.transfer(lender, borrow);
    }

    function harvestPlain(uint256 pid) external {
        farm.harvest(pid);
    }
}
