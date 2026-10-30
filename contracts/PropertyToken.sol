// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {Restrictions} from "./Restrictions.sol";

/// @title PropertyToken
/// @notice A permissioned security token representing equity in one property-holding SPV.
///  - 0 decimals: one token is one indivisible share of the SPV.
///  - Every transfer is checked against the identity registry and per-property compliance rules
///    (ERC-1404 style `detectTransferRestriction`).
///  - Rent and sale proceeds are distributed pro-rata in a stablecoin using a
///    "magnified dividend per share" accumulator, so distribution cost is O(1) regardless of holder count.
///  - The exchange can lock tokens in the holder's wallet while a sell order rests. Locked tokens
///    keep earning distributions; they just cannot be moved except by exchange settlement.
contract PropertyToken is ERC20, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant EXCHANGE_ROLE = keccak256("EXCHANGE_ROLE");
    bytes32 public constant APPRAISER_ROLE = keccak256("APPRAISER_ROLE");

    uint256 private constant MAGNITUDE = 2 ** 128;

    struct PropertyInfo {
        string spvName; // legal entity that holds title
        string jurisdiction; // e.g. "US-TX"
        string location; // human readable address / neighbourhood
        string metadataURI; // IPFS URI: deed, operating agreement, inspection, photos
    }

    struct ComplianceConfig {
        uint32 maxHolders; // 0 = unlimited (e.g. 2,000 for Reg D 12(g))
        uint16 maxHoldingBps; // 0 = unlimited; per-investor cap as share of maxSupply
        bool accreditedOnly;
        uint64 lockupUntil; // no secondary transfers before this time
    }

    IdentityRegistry public immutable identityRegistry;
    IERC20 public immutable payoutToken;
    uint256 public immutable maxSupply;

    PropertyInfo private _info;
    ComplianceConfig public compliance;
    mapping(uint16 => bool) public blockedCountry;

    uint256 public holderCount;
    bool public closed;
    mapping(address => bool) public frozen;
    mapping(address => uint256) public lockedOf;

    // valuation (stablecoin units per token)
    uint256 public navPerToken;
    uint64 public navUpdatedAt;
    string public navReportURI;

    // distributions
    uint256 private _magnifiedPerShare;
    mapping(address => int256) private _corrections;
    mapping(address => uint256) public withdrawnOf;
    uint256 public totalDistributed;

    event Distributed(address indexed by, uint256 amount, string memo);
    event Claimed(address indexed holder, uint256 amount);
    event Frozen(address indexed account, bool frozen);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, string reason);
    event WalletRecovered(address indexed lostWallet, address indexed newWallet, uint256 amount);
    event Locked(address indexed holder, uint256 amount);
    event Unlocked(address indexed holder, uint256 amount);
    event ValuationUpdated(uint256 navPerToken, string reportURI);
    event ComplianceUpdated(ComplianceConfig config);
    event CountryBlocked(uint16 country, bool blocked);
    event InfoUpdated(string metadataURI);
    event PropertyClosed();

    error TransferRestricted(uint8 code);
    error NothingToDistribute();
    error AlreadyClosed();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        PropertyInfo memory info_,
        ComplianceConfig memory compliance_,
        IdentityRegistry registry_,
        IERC20 payoutToken_,
        address admin
    ) ERC20(name_, symbol_) {
        maxSupply = maxSupply_;
        _info = info_;
        compliance = compliance_;
        identityRegistry = registry_;
        payoutToken = payoutToken_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function info() external view returns (PropertyInfo memory) {
        return _info;
    }

    // ------------------------------------------------------------------
    // Compliance checks
    // ------------------------------------------------------------------

    /// @notice ERC-1404: returns 0 if `from` may transfer `value` to `to`, else a restriction code.
    function detectTransferRestriction(address from, address to, uint256 value) public view returns (uint8) {
        uint8 code = _senderRestriction(from, value, false);
        if (code != Restrictions.OK) return code;
        return _recipientRestriction(from, to, value);
    }

    /// @notice Same as above but the tokens come out of `from`'s exchange-locked balance.
    function detectSettlementRestriction(address from, address to, uint256 value) public view returns (uint8) {
        uint8 code = _senderRestriction(from, value, true);
        if (code != Restrictions.OK) return code;
        return _recipientRestriction(from, to, value);
    }

    /// @notice Checks whether `to` may receive `value` newly minted or bought tokens.
    function detectReceiveRestriction(address to, uint256 value) public view returns (uint8) {
        if (closed) return Restrictions.CLOSED;
        if (paused()) return Restrictions.PAUSED;
        return _recipientRestriction(address(0), to, value);
    }

    function detectMintRestriction(address to, uint256 value) public view returns (uint8) {
        if (totalSupply() + value > maxSupply) return Restrictions.SUPPLY_CAP;
        return detectReceiveRestriction(to, value);
    }

    function messageForTransferRestriction(uint8 code) external pure returns (string memory) {
        return Restrictions.message(code);
    }

    function _senderRestriction(address from, uint256 value, bool fromLocked) internal view returns (uint8) {
        if (closed) return Restrictions.CLOSED;
        if (paused()) return Restrictions.PAUSED;
        if (frozen[from]) return Restrictions.SENDER_FROZEN;
        if (!identityRegistry.isVerified(from)) return Restrictions.SENDER_NOT_VERIFIED;
        if (fromLocked) {
            if (lockedOf[from] < value) return Restrictions.INSUFFICIENT_LOCKED;
        } else if (balanceOf(from) - lockedOf[from] < value) {
            return Restrictions.INSUFFICIENT_UNLOCKED;
        }
        if (block.timestamp < compliance.lockupUntil) return Restrictions.LOCKUP;
        return Restrictions.OK;
    }

    function _recipientRestriction(address from, address to, uint256 value) internal view returns (uint8) {
        if (frozen[to]) return Restrictions.RECIPIENT_FROZEN;
        if (!identityRegistry.isVerified(to)) return Restrictions.RECIPIENT_NOT_VERIFIED;
        if (compliance.accreditedOnly && !identityRegistry.isAccredited(to)) return Restrictions.NOT_ACCREDITED;
        if (blockedCountry[identityRegistry.countryOf(to)]) return Restrictions.COUNTRY_BLOCKED;
        if (from == to) return Restrictions.OK;

        uint256 toBalance = balanceOf(to);
        if (compliance.maxHolders != 0 && toBalance == 0 && value > 0 && holderCount >= compliance.maxHolders) {
            // A transfer of the sender's entire balance does not change the holder count.
            bool senderExits = from != address(0) && balanceOf(from) == value;
            if (!senderExits) return Restrictions.HOLDER_LIMIT;
        }
        if (compliance.maxHoldingBps != 0 && toBalance + value > (maxSupply * compliance.maxHoldingBps) / 10_000) {
            return Restrictions.HOLDING_CAP;
        }
        return Restrictions.OK;
    }

    function _require(uint8 code) private pure {
        if (code != Restrictions.OK) revert TransferRestricted(code);
    }

    // ------------------------------------------------------------------
    // ERC20 transfers (restricted)
    // ------------------------------------------------------------------

    function transfer(address to, uint256 value) public override returns (bool) {
        _require(detectTransferRestriction(msg.sender, to, value));
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _require(detectTransferRestriction(from, to, value));
        return super.transferFrom(from, to, value);
    }

    /// @dev Keeps holder count and distribution corrections in sync for every balance change.
    function _update(address from, address to, uint256 value) internal override {
        bool newHolder = to != address(0) && value > 0 && balanceOf(to) == 0 && from != to;
        super._update(from, to, value);
        if (newHolder) holderCount++;
        if (from != address(0) && from != to && value > 0 && balanceOf(from) == 0) holderCount--;

        int256 magCorrection = int256(_magnifiedPerShare * value);
        if (from != address(0)) _corrections[from] += magCorrection;
        if (to != address(0)) _corrections[to] -= magCorrection;
    }

    // ------------------------------------------------------------------
    // Issuance
    // ------------------------------------------------------------------

    function mint(address to, uint256 value) external onlyRole(MINTER_ROLE) {
        _require(detectMintRestriction(to, value));
        _mint(to, value);
    }

    // ------------------------------------------------------------------
    // Exchange integration
    // ------------------------------------------------------------------

    function lock(address holder, uint256 value) external onlyRole(EXCHANGE_ROLE) {
        _require(_senderRestriction(holder, value, false));
        lockedOf[holder] += value;
        emit Locked(holder, value);
    }

    /// @dev Clamped: an agent action may already have consumed part of the lock.
    function unlock(address holder, uint256 value) external onlyRole(EXCHANGE_ROLE) {
        uint256 l = lockedOf[holder];
        if (value > l) value = l;
        lockedOf[holder] = l - value;
        emit Unlocked(holder, value);
    }

    function settle(address from, address to, uint256 value) external onlyRole(EXCHANGE_ROLE) {
        _require(detectSettlementRestriction(from, to, value));
        lockedOf[from] -= value;
        _transfer(from, to, value);
    }

    // ------------------------------------------------------------------
    // Distributions (rent, refinancing, sale proceeds)
    // ------------------------------------------------------------------

    function distribute(uint256 amount, string calldata memo) external onlyRole(ISSUER_ROLE) {
        uint256 supply = totalSupply();
        if (amount == 0 || supply == 0) revert NothingToDistribute();
        payoutToken.safeTransferFrom(msg.sender, address(this), amount);
        _magnifiedPerShare += (amount * MAGNITUDE) / supply;
        totalDistributed += amount;
        emit Distributed(msg.sender, amount, memo);
    }

    function accumulativeOf(address holder) public view returns (uint256) {
        int256 magnified = int256(_magnifiedPerShare * balanceOf(holder)) + _corrections[holder];
        return uint256(magnified) / MAGNITUDE;
    }

    function withdrawableOf(address holder) public view returns (uint256) {
        return accumulativeOf(holder) - withdrawnOf[holder];
    }

    function claim() external returns (uint256 amount) {
        amount = withdrawableOf(msg.sender);
        if (amount > 0) {
            withdrawnOf[msg.sender] += amount;
            payoutToken.safeTransfer(msg.sender, amount);
            emit Claimed(msg.sender, amount);
        }
    }

    // ------------------------------------------------------------------
    // Transfer agent controls
    // ------------------------------------------------------------------

    function setFrozen(address account, bool isFrozen) external onlyRole(AGENT_ROLE) {
        frozen[account] = isFrozen;
        emit Frozen(account, isFrozen);
    }

    /// @notice Court orders, estate transfers, regulatory seizure. Recipient must still be eligible.
    function forcedTransfer(address from, address to, uint256 value, string calldata reason)
        external
        onlyRole(AGENT_ROLE)
    {
        _forcedTransfer(from, to, value);
        emit ForcedTransfer(from, to, value, reason);
    }

    /// @notice Moves balance and unclaimed distributions from a lost wallet to a re-verified one.
    function recoverWallet(address lostWallet, address newWallet) external onlyRole(AGENT_ROLE) {
        uint256 balance = balanceOf(lostWallet);
        uint256 unclaimed = withdrawableOf(lostWallet);
        _forcedTransfer(lostWallet, newWallet, balance);
        int256 shift = int256(unclaimed * MAGNITUDE);
        _corrections[lostWallet] -= shift;
        _corrections[newWallet] += shift;
        frozen[lostWallet] = true;
        emit WalletRecovered(lostWallet, newWallet, balance);
    }

    function _forcedTransfer(address from, address to, uint256 value) private {
        _require(_recipientRestriction(from, to, value));
        uint256 free = balanceOf(from) - lockedOf[from];
        if (value > free) lockedOf[from] -= value - free; // reverts if value > balance
        _transfer(from, to, value);
    }

    function pause() external onlyRole(AGENT_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(AGENT_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Administration
    // ------------------------------------------------------------------

    function setCompliance(ComplianceConfig calldata config) external onlyRole(DEFAULT_ADMIN_ROLE) {
        compliance = config;
        emit ComplianceUpdated(config);
    }

    function setCountryBlocked(uint16 country, bool blocked) external onlyRole(DEFAULT_ADMIN_ROLE) {
        blockedCountry[country] = blocked;
        emit CountryBlocked(country, blocked);
    }

    function setMetadataURI(string calldata uri) external onlyRole(ISSUER_ROLE) {
        _info.metadataURI = uri;
        emit InfoUpdated(uri);
    }

    function updateValuation(uint256 navPerToken_, string calldata reportURI) external onlyRole(APPRAISER_ROLE) {
        navPerToken = navPerToken_;
        navUpdatedAt = uint64(block.timestamp);
        navReportURI = reportURI;
        emit ValuationUpdated(navPerToken_, reportURI);
    }

    /// @notice Called after the property is sold and the final distribution is made.
    /// Transfers and trading stop permanently; holders can still claim.
    function closeProperty() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (closed) revert AlreadyClosed();
        closed = true;
        emit PropertyClosed();
    }
}
