// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title IdentityRegistry
/// @notice On-chain allow-list of investors who passed off-chain KYC/AML.
/// No personal data is stored on-chain: only a country code, accreditation flag,
/// an expiry and a hash reference to the KYC provider's record.
contract IdentityRegistry is AccessControl {
    bytes32 public constant KYC_AGENT_ROLE = keccak256("KYC_AGENT_ROLE");

    struct Identity {
        bool verified;
        bool accredited;
        uint16 country; // ISO 3166-1 numeric
        uint64 expiresAt;
        bytes32 kycRef; // hash of the provider record / case id
    }

    mapping(address => Identity) private _identities;

    event IdentityRegistered(address indexed investor, uint16 country, bool accredited, uint64 expiresAt, bytes32 kycRef);
    event IdentityRevoked(address indexed investor);

    error InvalidInvestor();
    error InvalidExpiry();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KYC_AGENT_ROLE, admin);
    }

    function register(address investor, uint16 country, bool accredited, uint64 expiresAt, bytes32 kycRef)
        external
        onlyRole(KYC_AGENT_ROLE)
    {
        if (investor == address(0)) revert InvalidInvestor();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        _identities[investor] = Identity(true, accredited, country, expiresAt, kycRef);
        emit IdentityRegistered(investor, country, accredited, expiresAt, kycRef);
    }

    function revoke(address investor) external onlyRole(KYC_AGENT_ROLE) {
        delete _identities[investor];
        emit IdentityRevoked(investor);
    }

    function isVerified(address investor) public view returns (bool) {
        Identity storage id = _identities[investor];
        return id.verified && id.expiresAt > block.timestamp;
    }

    function isAccredited(address investor) external view returns (bool) {
        return isVerified(investor) && _identities[investor].accredited;
    }

    function countryOf(address investor) external view returns (uint16) {
        return _identities[investor].country;
    }

    function identityOf(address investor) external view returns (Identity memory) {
        return _identities[investor];
    }
}
