// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {PropertyToken} from "./PropertyToken.sol";
import {PrimaryOffering} from "./PrimaryOffering.sol";
import {PropertyExchange} from "./PropertyExchange.sol";
import {TokenDeployer, OfferingDeployer} from "./Deployers.sol";

/// @title PropertyFactory
/// @notice One-transaction onboarding of a property: deploys its token and primary offering,
/// wires up roles, lists it on the exchange and records it in the registry.
contract PropertyFactory is AccessControl {
    bytes32 public constant ORIGINATOR_ROLE = keccak256("ORIGINATOR_ROLE");

    struct Property {
        PropertyToken token;
        PrimaryOffering offering;
        address issuer;
        uint64 createdAt;
    }

    struct NewProperty {
        string name;
        string symbol;
        uint256 maxSupply;
        PropertyToken.PropertyInfo info;
        PropertyToken.ComplianceConfig compliance;
        PrimaryOffering.Terms terms;
        address issuer; // SPV treasury / manager wallet
        uint256 initialNavPerToken;
    }

    IdentityRegistry public immutable identityRegistry;
    IERC20 public immutable quoteToken;
    PropertyExchange public immutable exchange;
    address public immutable platformAdmin;
    TokenDeployer public immutable tokenDeployer;
    OfferingDeployer public immutable offeringDeployer;

    Property[] private _properties;
    mapping(address => uint256) public indexOfToken; // 1-based

    event PropertyCreated(uint256 indexed index, address indexed token, address offering, address issuer, string symbol);

    constructor(
        IdentityRegistry registry_,
        IERC20 quoteToken_,
        PropertyExchange exchange_,
        TokenDeployer tokenDeployer_,
        OfferingDeployer offeringDeployer_,
        address admin
    ) {
        tokenDeployer = tokenDeployer_;
        offeringDeployer = offeringDeployer_;
        identityRegistry = registry_;
        quoteToken = quoteToken_;
        exchange = exchange_;
        platformAdmin = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORIGINATOR_ROLE, admin);
    }

    function createProperty(NewProperty calldata p)
        external
        onlyRole(ORIGINATOR_ROLE)
        returns (PropertyToken token, PrimaryOffering offering)
    {
        token = tokenDeployer.deploy(p.name, p.symbol, p.maxSupply, p.info, p.compliance, identityRegistry, quoteToken);
        offering = offeringDeployer.deploy(token, quoteToken, p.issuer, p.terms);

        token.grantRole(token.MINTER_ROLE(), address(offering));
        token.grantRole(token.EXCHANGE_ROLE(), address(exchange));
        token.grantRole(token.ISSUER_ROLE(), p.issuer);
        token.grantRole(token.AGENT_ROLE(), platformAdmin);
        token.grantRole(token.APPRAISER_ROLE(), platformAdmin);
        if (p.initialNavPerToken > 0) {
            token.grantRole(token.APPRAISER_ROLE(), address(this));
            token.updateValuation(p.initialNavPerToken, "initial: offering price");
            token.renounceRole(token.APPRAISER_ROLE(), address(this));
        }
        token.grantRole(token.DEFAULT_ADMIN_ROLE(), platformAdmin);
        token.renounceRole(token.DEFAULT_ADMIN_ROLE(), address(this));

        exchange.setMarketListed(address(token), true);

        _properties.push(Property(token, offering, p.issuer, uint64(block.timestamp)));
        indexOfToken[address(token)] = _properties.length;
        emit PropertyCreated(_properties.length - 1, address(token), address(offering), p.issuer, p.symbol);
    }

    function propertyCount() external view returns (uint256) {
        return _properties.length;
    }

    function propertyAt(uint256 index) external view returns (Property memory) {
        return _properties[index];
    }

    function allProperties() external view returns (Property[] memory) {
        return _properties;
    }
}
