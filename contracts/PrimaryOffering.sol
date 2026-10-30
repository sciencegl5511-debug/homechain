// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PropertyToken} from "./PropertyToken.sol";
import {Restrictions} from "./Restrictions.sol";

/// @title PrimaryOffering
/// @notice Fixed-price, all-or-nothing initial sale of a property's tokens.
/// Investors commit stablecoin during the window. If the soft cap is met the proceeds go to the SPV
/// (which uses them to close on the property) and investors claim tokens; otherwise everyone is refunded.
contract PrimaryOffering is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        Active,
        Succeeded,
        Failed
    }

    struct Terms {
        uint128 price; // quote units per token
        uint64 softCap; // tokens that must sell for the deal to close
        uint64 hardCap; // tokens offered
        uint64 minPurchase; // tokens
        uint64 startTime;
        uint64 endTime;
    }

    PropertyToken public immutable token;
    IERC20 public immutable quoteToken;
    address public immutable issuer; // SPV treasury that receives proceeds
    Terms public terms;
    State public state;
    uint256 public totalSubscribed;
    mapping(address => uint256) public subscribedOf;
    address[] private _investors;

    event Subscribed(address indexed investor, uint256 amount, uint256 cost);
    event Finalized(State state, uint256 totalSubscribed, uint256 proceeds);
    event TokensClaimed(address indexed investor, uint256 amount);
    event Refunded(address indexed investor, uint256 amount);

    error NotActive();
    error OutsideWindow();
    error InvalidAmount();
    error SoldOut();
    error NotIssuer();
    error CannotFinalizeYet();
    error NothingToClaim();
    error TransferRestricted(uint8 code);

    constructor(PropertyToken token_, IERC20 quoteToken_, address issuer_, Terms memory terms_) {
        require(terms_.softCap <= terms_.hardCap && terms_.hardCap <= token_.maxSupply(), "bad caps");
        require(terms_.startTime < terms_.endTime && terms_.price > 0, "bad terms");
        token = token_;
        quoteToken = quoteToken_;
        issuer = issuer_;
        terms = terms_;
    }

    function subscribe(uint256 amount) external nonReentrant {
        if (state != State.Active) revert NotActive();
        if (block.timestamp < terms.startTime || block.timestamp >= terms.endTime) revert OutsideWindow();
        if (amount == 0 || subscribedOf[msg.sender] + amount < terms.minPurchase) revert InvalidAmount();
        if (totalSubscribed + amount > terms.hardCap) revert SoldOut();

        // Eligibility is checked now and again at claim time (KYC can expire in between).
        uint8 code = token.detectReceiveRestriction(msg.sender, subscribedOf[msg.sender] + amount);
        if (code != Restrictions.OK) revert TransferRestricted(code);

        if (subscribedOf[msg.sender] == 0) _investors.push(msg.sender);
        subscribedOf[msg.sender] += amount;
        totalSubscribed += amount;
        uint256 cost = amount * terms.price;
        quoteToken.safeTransferFrom(msg.sender, address(this), cost);
        emit Subscribed(msg.sender, amount, cost);
    }

    /// @notice Anyone may finalize after the window closes or once sold out.
    function finalize() external nonReentrant {
        if (state != State.Active) revert NotActive();
        if (block.timestamp < terms.endTime && totalSubscribed < terms.hardCap) revert CannotFinalizeYet();
        _finalize(totalSubscribed >= terms.softCap ? State.Succeeded : State.Failed);
    }

    /// @notice Issuer can abort (e.g. failed inspection / title issue) before finalization.
    function cancel() external nonReentrant {
        if (msg.sender != issuer) revert NotIssuer();
        if (state != State.Active) revert NotActive();
        _finalize(State.Failed);
    }

    function _finalize(State outcome) private {
        state = outcome;
        uint256 proceeds;
        if (outcome == State.Succeeded) {
            proceeds = totalSubscribed * terms.price;
            quoteToken.safeTransfer(issuer, proceeds);
        }
        emit Finalized(outcome, totalSubscribed, proceeds);
    }

    /// @notice Delivers tokens (success) or refunds (failure). Callable by anyone for any investor
    /// so the issuer can push allocations in bulk.
    function claimFor(address investor) public nonReentrant {
        uint256 amount = subscribedOf[investor];
        if (amount == 0) revert NothingToClaim();
        if (state == State.Active) revert NotActive();
        subscribedOf[investor] = 0;
        if (state == State.Succeeded) {
            token.mint(investor, amount);
            emit TokensClaimed(investor, amount);
        } else {
            uint256 refund = amount * terms.price;
            quoteToken.safeTransfer(investor, refund);
            emit Refunded(investor, refund);
        }
    }

    function claim() external {
        claimFor(msg.sender);
    }

    function investors() external view returns (address[] memory) {
        return _investors;
    }
}
