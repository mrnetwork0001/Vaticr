// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title  VaticrForecastRegistry
/// @author Ifeanyichukwu Onwo (mrnetwork)
/// @notice An append-only, permissionless log of probability forecasts on
///         DreamDEX event contracts, committed *before* the window settles.
///
/// @dev    Why this exists.
///
///         DreamDEX event contracts resolve themselves: the OracleHub answers
///         at expiry and `BinaryMarketsModule` is the only address a market
///         trusts as its settler. Nothing here touches that, and nothing here
///         can. This contract does the one thing the protocol deliberately
///         leaves to the outside - it makes a *forecaster* accountable.
///
///         A prediction is only evidence of skill if it was published before
///         the outcome was known. An off-chain log proves nothing: whoever
///         holds the file can rewrite it. So Vaticr writes each forecast here,
///         timestamped by the chain and refused after the window closes.
///         Afterwards anyone can read the market's own on-chain outcome, score
///         these commitments with a Brier score, and check the claimed track
///         record without trusting the agent that produced it.
///
///         There is no owner, no upgrade path, and no way to amend or delete a
///         commitment. That is the entire security model: an agent that could
///         edit its own history would prove nothing by having one.
contract VaticrForecastRegistry {
    /// @notice One published forecast.
    struct Forecast {
        /// @dev P(Up) in basis points, 1..9999. 0 marks an empty slot.
        uint16 probabilityBps;
        /// @dev The price-process prior before news, in basis points.
        uint16 priorBps;
        /// @dev Window expiry (unix seconds) this forecast was made against.
        uint64 expiry;
        /// @dev Block timestamp the commitment landed at.
        uint64 committedAt;
        /// @dev keccak256 over the headline ids that moved the posterior.
        ///      Lets the agent later reveal exactly which evidence it used.
        bytes32 evidenceHash;
    }

    /// @dev agent => dreamDEX bytes32 marketId => forecast
    mapping(address => mapping(bytes32 => Forecast)) private _forecasts;

    /// @notice How many forecasts an agent has ever committed.
    mapping(address => uint256) public forecastCount;

    /// @notice Every market an agent has committed to, in order.
    mapping(address => bytes32[]) private _markets;

    event ForecastCommitted(
        address indexed agent,
        bytes32 indexed marketId,
        uint16 probabilityBps,
        uint16 priorBps,
        uint64 expiry,
        bytes32 evidenceHash
    );

    error ProbabilityOutOfRange(uint16 probabilityBps);
    error WindowAlreadyClosed(uint64 expiry, uint256 nowTs);
    error AlreadyCommitted(address agent, bytes32 marketId);

    /// @notice Publish a forecast for `marketId` before its window closes.
    /// @param  marketId       dreamDEX `bytes32` market id.
    /// @param  probabilityBps Posterior P(Up) in basis points, 1..9999.
    /// @param  priorBps       Prior P(Up) in basis points, before news.
    /// @param  expiry         The window's expiry, unix seconds.
    /// @param  evidenceHash   keccak256 of the evidence set (0 if none).
    ///
    /// @dev    Reverts once `expiry` has passed: a forecast made after the
    ///         window closed is not a forecast. One commitment per agent per
    ///         market - an agent that could revise would prove nothing.
    function commit(
        bytes32 marketId,
        uint16 probabilityBps,
        uint16 priorBps,
        uint64 expiry,
        bytes32 evidenceHash
    ) external {
        if (probabilityBps == 0 || probabilityBps >= 10_000) {
            revert ProbabilityOutOfRange(probabilityBps);
        }
        if (expiry <= block.timestamp) {
            revert WindowAlreadyClosed(expiry, block.timestamp);
        }
        if (_forecasts[msg.sender][marketId].probabilityBps != 0) {
            revert AlreadyCommitted(msg.sender, marketId);
        }

        _forecasts[msg.sender][marketId] = Forecast({
            probabilityBps: probabilityBps,
            priorBps: priorBps,
            expiry: expiry,
            committedAt: uint64(block.timestamp),
            evidenceHash: evidenceHash
        });
        _markets[msg.sender].push(marketId);
        unchecked {
            forecastCount[msg.sender] += 1;
        }

        emit ForecastCommitted(
            msg.sender, marketId, probabilityBps, priorBps, expiry, evidenceHash
        );
    }

    /// @notice Read one agent's forecast for one market.
    /// @return The forecast; `probabilityBps == 0` means none was committed.
    function getForecast(address agent, bytes32 marketId)
        external
        view
        returns (Forecast memory)
    {
        return _forecasts[agent][marketId];
    }

    /// @notice True if `agent` committed to `marketId` before it closed.
    function hasForecast(address agent, bytes32 marketId) external view returns (bool) {
        return _forecasts[agent][marketId].probabilityBps != 0;
    }

    /// @notice A page of the markets `agent` has forecast, oldest first.
    /// @dev    Paginated because the list is unbounded; `offset` past the end
    ///         returns empty rather than reverting.
    function marketsOf(address agent, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page)
    {
        bytes32[] storage all = _markets[agent];
        if (offset >= all.length) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = all[i];
        }
    }
}
