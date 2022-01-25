// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/IFarm.sol";
import "./interfaces/IERC20Farmable.sol";
import "./accounting/FarmAccounting.sol";

contract Farm is IFarm, Ownable {
    using SafeERC20 for IERC20;
    using FarmAccounting for FarmAccounting.Info;

    event RewardAdded(uint256 reward, uint256 duration);

    IERC20Farmable public immutable farmableToken;
    IERC20 public immutable rewardsToken;

    address public distributor;
    FarmAccounting.Info public farmInfo;

    constructor(IERC20Farmable farmableToken_, IERC20 rewardsToken_) {
        farmableToken = farmableToken_;
        rewardsToken = rewardsToken_;
    }

    function setDistributor(address distributor_) external onlyOwner {
        distributor = distributor_;
    }

    function startFarming(uint256 amount, uint256 period) external {
        require(msg.sender == distributor, "F: Access denied");
        rewardsToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 reward = farmInfo.startFarming(amount, period, _updateCheckpoint);
        emit RewardAdded(reward, period);
    }

    /// @dev Requires extra 18 decimals for precision, result should not exceed 10**54
    function farmedSinceCheckpointScaled(uint256 checkpoint) public view override returns(uint256 amount) {
        return farmInfo.farmedSinceCheckpointScaled(checkpoint);
    }

    function claimFor(address account, uint256 amount) external override {
        require(msg.sender == address(farmableToken), "ERC20: Access denied");
        rewardsToken.safeTransfer(account, amount);
    }

    // FarmAccounting bindings

    function _updateCheckpoint() private {
        farmableToken.updateCheckpoint();
    }
}
