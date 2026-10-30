// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {PropertyToken} from "./PropertyToken.sol";
import {PrimaryOffering} from "./PrimaryOffering.sol";

/// @dev Deployment helpers split out of PropertyFactory to keep each contract under the 24 KB limit.
/// They are stateless; the factory registry is the source of truth for which tokens are genuine.
contract TokenDeployer {
    function deploy(
        string calldata name,
        string calldata symbol,
        uint256 maxSupply,
        PropertyToken.PropertyInfo calldata info,
        PropertyToken.ComplianceConfig calldata compliance,
        IdentityRegistry registry,
        IERC20 payoutToken
    ) external returns (PropertyToken) {
        return new PropertyToken(name, symbol, maxSupply, info, compliance, registry, payoutToken, msg.sender);
    }
}

contract OfferingDeployer {
    function deploy(PropertyToken token, IERC20 quoteToken, address issuer, PrimaryOffering.Terms calldata terms)
        external
        returns (PrimaryOffering)
    {
        return new PrimaryOffering(token, quoteToken, issuer, terms);
    }
}
