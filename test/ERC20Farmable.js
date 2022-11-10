const { expect, constants, time, ether } = require('@1inch/solidity-utils');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { ethers } = require('hardhat');
const { startFarming, joinNewFarms } = require('./utils');
const { shouldBehaveLikeFarmable } = require('./behaviors/ERC20Farmable.behavior.js');

describe('ERC20Farmable', function () {
    let wallet1, wallet2, wallet3;
    const INITIAL_SUPPLY = ether('1');
    const MAX_USER_FARMS = 10;

    before(async function () {
        [wallet1, wallet2, wallet3] = await ethers.getSigners();
    });

    async function initContracts () {
        const ERC20FarmableMock = await ethers.getContractFactory('ERC20FarmableMock');
        const token = await ERC20FarmableMock.deploy('1INCH', '1INCH', MAX_USER_FARMS);
        await token.deployed();
        await token.mint(wallet1.address, INITIAL_SUPPLY);

        const TokenMock = await ethers.getContractFactory('TokenMock');
        const gift = await TokenMock.deploy('UDSC', 'USDC');
        await gift.deployed();
        const FarmingPod = await ethers.getContractFactory('FarmingPod');
        const farm = await FarmingPod.deploy(token.address, gift.address);
        await farm.deployed();

        for (const wallet of [wallet1, wallet2, wallet3]) {
            await gift.mint(wallet.address, '1000000000');
            await gift.connect(wallet).approve(farm.address, '1000000000');
        }
        await farm.setDistributor(wallet1.address);
        const initialSupply = INITIAL_SUPPLY;
        return { initialSupply, token, gift, farm };
    };

    shouldBehaveLikeFarmable(initContracts);

    // Generic farming scenarios
    describe('farming', function () {
        // Farm initialization scenarios
        describe('startFarming', function () {
            /*
                ***Test Scenario**
                Checks that only distributors may launch farming. "Distributor" is the only account that offers a farming reward.
                ***Initial setup**
                - `wallet1` - distributor account
                - `wallet2` - non-distributor account

                ***Test Steps**
                Start farming using `wallet2`
                ***Expected results**
                Revert with error `'AccessDenied()'`.
            */
            it('should thrown with rewards distribution access denied ', async function () {
                const { farm } = await loadFixture(initContracts);
                await expect(
                    farm.connect(wallet2).startFarming(1000, 60 * 60 * 24),
                ).to.be.revertedWithCustomError(farm, 'AccessDenied');
            });

            /*
                ***Test Scenario**
                Checks that the farming period is of `uint40` size.

                ***Test Steps**
                Start farming using 2^40^ as the farming period.

                ***Expected results**
                Revert with error `'DurationTooLarge()'`.
            */
            it('Thrown with Period too large', async function () {
                const { farm } = await loadFixture(initContracts);
                await expect(
                    farm.startFarming('10000', 2n ** 40n),
                ).to.be.revertedWithCustomError(farm, 'DurationTooLarge');
            });

            /*
                ***Test Scenario**
                Checks that the farming amount is under _MAX_REWARD_AMOUNT

                ***Test Steps**
                Start farming using _MAX_REWARD_AMOUNT+1 as a farming reward.

                ***Expected results**
                Revert with error `'AmountTooLarge()'`.
            */
            it('Thrown with Amount equals _MAX_REWARD_AMOUNT + 1', async function () {
                const { gift, farm } = await loadFixture(initContracts);
                const _MAX_REWARD_AMOUNT = 10n ** 42n;
                await gift.mint(wallet1.address, _MAX_REWARD_AMOUNT + 1n);
                await gift.approve(farm.address, _MAX_REWARD_AMOUNT + 1n);
                await expect(
                    farm.startFarming(_MAX_REWARD_AMOUNT + 1n, time.duration.weeks(1)),
                ).to.be.revertedWithCustomError(farm, 'AmountTooLarge');
            });
        });

        // Token's claim scenarios
        describe('claim', function () {
            /*
                ***Test Scenario**
                Checks that farming reward can be claimed with the regular scenario 'join - farm - claim'.
                ***Initial setup**
                - `farm` started farming for 1 day with 1000 units reward
                - `wallet1` has 1000 farmable tokens and has joined the farm

                ***Test Steps**
                1. Fast-forward time to 1 day and 1 hour
                2. Claim reward for `wallet1`

                ***Expected results**
                `wallet1` reward token balance equals 1000
            */
            it('should claim tokens', async function () {
                const { token, gift, farm } = await loadFixture(initContracts);
                await token.addPod(farm.address);
                await gift.connect(wallet2).transfer(farm.address, '1000');

                const started = await startFarming(farm, 1000, 60 * 60 * 24, wallet1);
                await time.increaseTo(started + 60 * 60 * 25);

                const balanceBefore = await gift.balanceOf(wallet1.address);
                await farm.claim();
                expect(await gift.balanceOf(wallet1.address)).to.equal(balanceBefore.add(1000));
            });

            /*
                ***Test Scenario**
                Checks that non-farming wallet doesn't get a reward
                ***Initial setup**
                - `farm` started farming for 1 day with 1000 units reward
                - `wallet1` has 1000 farmable tokens and joined the farm
                - `wallet2` hasn't joined the farm

                ***Test Steps**
                1. Fast-forward time to 1 day and 1 hour
                2. Claim reward for `wallet2`

                ***Expected results**
                `wallet2` gift token balance doesn't change after the claim
            */
            it('should claim tokens for non-user farms wallet', async function () {
                const { token, gift, farm } = await loadFixture(initContracts);
                await token.addPod(farm.address);
                await gift.connect(wallet2).transfer(farm.address, '1000');

                const started = await startFarming(farm, 1000, 60 * 60 * 24, wallet1);
                await time.increaseTo(started + 60 * 60 * 25);

                const balanceBefore = await gift.balanceOf(wallet2.address);
                await farm.claim();
                expect(await gift.balanceOf(wallet2.address)).to.equal(balanceBefore);
            });
        });

        // Farm's claim scenarios
        describe('claim', function () {
            /*
                ***Test Scenario**
                Checks that farming rewards can be claimed from all user's farms with the regular scenario 'join - farm - claim'.

                ***Initial setup**
                - 10 farms have been created and set up
                - All `farms` have started farming for 1 day with 100 units reward for each
                - `wallet1` has 1000 farmable tokens and has joined 10 farms
                - `wallet1` has no reward tokens

                ***Test Steps**
                1. Fast-forward time to finish all farmings (1 day)
                2. `wallet1` claims rewards from all farms using the `claimAll` function

                ***Expected results**
                `wallet1` reward token balance equals 1000
            */
            it('should claim tokens from all farms', async function () {
                const { token, gift } = await loadFixture(initContracts);
                // Create and set additional farms
                const farmsCount = 10;
                const farms = [];
                let lastFarmStarted;
                const FarmingPod = await ethers.getContractFactory('FarmingPod');
                for (let i = 0; i < farmsCount; i++) {
                    farms[i] = await FarmingPod.deploy(token.address, gift.address);
                    await farms[i].deployed();
                    await farms[i].setDistributor(wallet1.address);
                    await gift.connect(wallet2).transfer(farms[i].address, '100');
                }

                // Join and start farming, then delay
                for (let i = 0; i < farmsCount; i++) {
                    await token.addPod(farms[i].address);
                    await gift.approve(farms[i].address, '100');
                    lastFarmStarted = await startFarming(farms[i], 100, time.duration.days(1), wallet1);
                }
                await time.increaseTo(lastFarmStarted + time.duration.days(1));

                // Check reward
                const balanceBefore = await gift.balanceOf(wallet1.address);
                await Promise.all(farms.map(farm => farm.claim()));
                expect(await gift.balanceOf(wallet1.address)).to.equal(balanceBefore.add(1000));
            });
        });

        // Farm's rescueFunds scenarios
        describe('rescueFunds', function () {
            /*
                ***Test Scenario**
                Ensures that a non-distributor account cannot call the `rescueFunds` function to get all remaining funds from the farm.

                ***Initial setup**
                - `wallet2` is not a distributor

                ***Test Steps**
                - `wallet2` calls `rescueFunds` function

                ***Expected results**
                - Call is reverted with an error `'AccessDenied()'`
            */
            it('should thrown with access denied', async function () {
                const { gift, farm } = await loadFixture(initContracts);
                const distributor = await farm.distributor();
                expect(wallet2.address).to.not.equal(distributor);
                await expect(
                    farm.connect(wallet2).rescueFunds(gift.address, '1000'),
                ).to.be.revertedWithCustomError(farm, 'AccessDenied');
            });

            /*
                ***Test Scenario**
                Ensures that a distributor account can get remaining funds from the farm using the `rescueFunds` function.

                ***Initial setup**
                - A farm has started farming

                ***Test Steps**
                - Distributor calls the `rescueFunds` function to transfer 1000 reward tokens from the farm to its account
                - Check the balances of the distributor's account and the farm's accounts

                ***Expected results**
                - 1000 reward tokens are transferred from the farm to the distributor
            */
            it('should transfer tokens from farm to wallet', async function () {
                const { gift, farm } = await loadFixture(initContracts);
                await farm.startFarming(1000, 60 * 60 * 24);

                const balanceWalletBefore = await gift.balanceOf(wallet1.address);
                const balanceFarmBefore = await gift.balanceOf(farm.address);

                const distributor = await farm.distributor();
                expect(wallet1.address).to.equal(distributor);
                await farm.rescueFunds(gift.address, '1000');

                expect(await gift.balanceOf(wallet1.address)).to.equal(balanceWalletBefore.add(1000));
                expect(await gift.balanceOf(farm.address)).to.equal(balanceFarmBefore.sub(1000));
            });

            /*
                ***Test Scenario**
                Ensure that `rescueFunds` can transfer ether to a distributor

                ***Initial setup**
                - A farm has been set up and ether has been transferred to the farm

                ***Test Steps**
                - Call `rescueFunds` function to get 1000 ethers
                - Calculate rescueFunds blockchain fee

                ***Expected results**
                - `wallet1` balance has increased by 1000 ethers minus the blockchain fee
            */
            it('should transfer ethers from farm to wallet', async function () {
                const { farm } = await loadFixture(initContracts);
                // Transfer ethers to farm
                const EthTransferMock = await ethers.getContractFactory('EthTransferMock');
                const ethMock = await EthTransferMock.deploy(farm.address, { value: '1000' });
                await ethMock.deployed();

                // Check rescueFunds
                const balanceWalletBefore = await ethers.provider.getBalance(wallet1.address);
                const balanceFarmBefore = await ethers.provider.getBalance(farm.address);

                const distributor = await farm.distributor();
                expect(wallet1.address).to.equal(distributor);
                const tx = await farm.rescueFunds(constants.ZERO_ADDRESS, '1000');
                const receipt = await tx.wait();
                const txCost = receipt.gasUsed * receipt.effectiveGasPrice;

                expect(await ethers.provider.getBalance(wallet1.address)).to.equal(balanceWalletBefore.sub(txCost).add(1000));
                expect(await ethers.provider.getBalance(farm.address)).to.equal(balanceFarmBefore.sub(1000));
            });
        });

        // Farm's pods scenarios
        describe('hasPod', function () {
            /*
                ***Test Scenario**
                Ensures that the `hasPod` view returns the correct farming status

                ***Initial setup**
                - `wallet1` has not joined a farm
                - `wallet2` has joined a farm

                ***Test Steps**
                - Check if `wallet1` and `wallet2` are farming

                ***Expected results**
                - `wallet1` status: is not farming (false)
                - `wallet2` status: is farming (true)
            */
            it('should return false when user does not farm and true when user farms', async function () {
                const { token, farm } = await loadFixture(initContracts);
                await token.connect(wallet2).addPod(farm.address);
                expect(await token.hasPod(wallet1.address, farm.address)).to.equal(false);
                expect(await token.hasPod(wallet2.address, farm.address)).to.equal(true);
            });

            /*
                ***Test Scenario**
                Ensures that `hasPod` returns the correct farming status after `quit` is called

                ***Test Steps**
                - `wallet2` joins to farm
                - `wallet2` quits from farm

                ***Expected results**
                - `wallet2` status: is not farming (false)
            */
            it('should return false when user quits from farm', async function () {
                const { token, farm } = await loadFixture(initContracts);
                await token.connect(wallet2).addPod(farm.address);
                await token.connect(wallet2).removePod(farm.address);
                expect(await token.hasPod(wallet1.address, farm.address)).to.equal(false);
            });
        });

        describe('podsCount', function () {
            /*
                ***Test Scenario**
                Ensures that the `podsCount` view returns the correct amount of user's farms

                ***Test Steps**
                1. Account joins to N farms
                2. Account quits from N farms

                ***Expected results**
                - Each time the account joins a farm `podsCount` should increase by 1
                - Each time the account quits from a farm `podsCount` should decrease by 1
            */
            it('should return amount of user\'s farms', async function () {
                const { token } = await loadFixture(initContracts);
                const farmsCount = 10;
                await joinNewFarms(token, farmsCount, wallet1);
                expect(await token.podsCount(wallet1.address)).to.equal(farmsCount);

                const farms = await token.pods(wallet1.address);
                expect(farms.length).to.equal(farmsCount);
                for (let i = 0; i < farmsCount; i++) {
                    await token.removePod(farms[i]);
                    expect(await token.podsCount(wallet1.address)).to.equal(farmsCount - i - 1);
                }
            });
        });

        describe('podAt', function () {
            /*
                ***Test Scenario**
                Ensure that the `podAt` view returns the correct farm by index

                ***Initial setup**
                - Account joins an array of farms

                ***Test Steps**
                1. Call `pods` view to get an array of joined farms for the account
                2. Request each farm's address with `podAt` view and compare it with the farm's address in the array

                ***Expected results**
                - Each pair of addresses should be equal
            */
            it('should return correct addresses', async function () {
                const { token } = await loadFixture(initContracts);
                const farmsCount = 10;
                await joinNewFarms(token, farmsCount, wallet1);
                const farms = await token.pods(wallet1.address);
                for (let i = 0; i < farmsCount; i++) {
                    const farmAddress = await token.podAt(wallet1.address, i);
                    expect(farmAddress).to.equal(farms[i]);
                }
            });
        });
    });
});
