// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PropertyToken} from "./PropertyToken.sol";
import {Restrictions} from "./Restrictions.sol";

/// @title PropertyExchange
/// @notice Fully on-chain central limit order book for property tokens, quoted in a stablecoin.
///  - Price-time priority; each side is a sorted doubly linked list of orders.
///  - Buy orders escrow stablecoin (notional + fee at the limit price) in this contract.
///  - Sell orders lock tokens in the seller's wallet (they keep earning rent while listed).
///  - Trades execute at the maker's price; the taker gets any price improvement.
///  - Every fill is re-checked against the token's compliance rules. If a resting order
///    has gone stale (maker frozen, KYC expired, cap exceeded...) it is cancelled and matching continues.
///  Residential tokens are thinly traded, so an O(n) insertion walk is an acceptable trade-off for
///  simplicity and full on-chain transparency. See docs/DESIGN.md for the hybrid alternative.
contract PropertyExchange is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant LISTER_ROLE = keccak256("LISTER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint16 public constant MAX_FEE_BPS = 200;

    struct Order {
        address trader;
        address token;
        bool isBuy;
        uint128 price; // quote units per token
        uint128 remaining; // tokens
        uint256 escrow; // quote units held for buy orders
        uint64 prev;
        uint64 next;
    }

    struct OrderView {
        uint64 id;
        address trader;
        bool isBuy;
        uint128 price;
        uint128 remaining;
    }

    struct Market {
        bool listed;
        uint64 bestBid;
        uint64 bestAsk;
        uint128 lastPrice;
        uint256 volume; // cumulative quote volume
        uint256 trades;
    }

    enum CancelReason {
        User,
        ImmediateOrCancel,
        SelfTrade,
        Ineligible,
        Operator
    }

    IERC20 public immutable quoteToken;
    address public treasury;
    uint16 public feeBps;

    mapping(address => Market) public markets;
    address[] public listedTokens;
    mapping(address => bool) private _everListed;
    mapping(uint64 => Order) public orders;
    uint64 public nextOrderId = 1;

    event MarketListed(address indexed token, bool listed);
    event OrderPlaced(uint64 indexed id, address indexed token, address indexed trader, bool isBuy, uint128 price, uint128 amount);
    event OrderCancelled(uint64 indexed id, address indexed token, uint128 remaining, CancelReason reason);
    event Trade(
        address indexed token,
        uint64 indexed makerOrderId,
        uint64 indexed takerOrderId,
        address buyer,
        address seller,
        uint128 price,
        uint128 amount,
        uint256 buyerFee,
        uint256 sellerFee
    );
    event FeeUpdated(uint16 feeBps, address treasury);

    error MarketNotListed();
    error InvalidOrder();
    error NotAuthorized();
    error UnknownOrder();
    error FeeTooHigh();
    error TransferRestricted(uint8 code);

    constructor(IERC20 quoteToken_, address treasury_, uint16 feeBps_, address admin) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        quoteToken = quoteToken_;
        treasury = treasury_;
        feeBps = feeBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setMarketListed(address token, bool listed) external onlyRole(LISTER_ROLE) {
        Market storage m = markets[token];
        if (listed && !_everListed[token]) {
            _everListed[token] = true;
            listedTokens.push(token);
        }
        m.listed = listed;
        emit MarketListed(token, listed);
    }

    function setFee(uint16 feeBps_, address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        treasury = treasury_;
        emit FeeUpdated(feeBps_, treasury_);
    }

    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Trading
    // ------------------------------------------------------------------

    /// @param ioc Immediate-or-cancel: any unfilled remainder is cancelled instead of resting.
    /// @param maxMatches Upper bound on fills in this transaction (gas guard).
    function placeOrder(address token, bool isBuy, uint128 price, uint128 amount, bool ioc, uint256 maxMatches)
        external
        nonReentrant
        whenNotPaused
        returns (uint64 id)
    {
        Market storage m = markets[token];
        if (!m.listed) revert MarketNotListed();
        if (price == 0 || amount == 0) revert InvalidOrder();
        PropertyToken t = PropertyToken(token);

        id = nextOrderId++;
        Order storage o = orders[id];
        o.trader = msg.sender;
        o.token = token;
        o.isBuy = isBuy;
        o.price = price;
        o.remaining = amount;

        if (isBuy) {
            uint8 code = t.detectReceiveRestriction(msg.sender, amount);
            if (code != Restrictions.OK) revert TransferRestricted(code);
            uint256 notional = uint256(price) * amount;
            uint256 escrow = notional + _fee(notional);
            o.escrow = escrow;
            quoteToken.safeTransferFrom(msg.sender, address(this), escrow);
        } else {
            t.lock(msg.sender, amount); // reverts with the token's restriction code
        }
        emit OrderPlaced(id, token, msg.sender, isBuy, price, amount);

        _match(m, t, id, maxMatches);

        if (o.remaining == 0) {
            _close(id);
        } else if (ioc) {
            _cancel(id, CancelReason.ImmediateOrCancel);
        } else {
            _insert(m, id);
        }
    }

    function cancelOrder(uint64 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.trader == address(0)) revert UnknownOrder();
        bool operator = hasRole(OPERATOR_ROLE, msg.sender);
        if (o.trader != msg.sender && !operator) revert NotAuthorized();
        _unlink(markets[o.token], id);
        _cancel(id, o.trader == msg.sender ? CancelReason.User : CancelReason.Operator);
    }

    function _match(Market storage m, PropertyToken t, uint64 takerId, uint256 maxMatches) private {
        Order storage taker = orders[takerId];
        bool takerBuys = taker.isBuy;
        uint64 makerId = takerBuys ? m.bestAsk : m.bestBid;
        uint256 fills;

        while (makerId != 0 && taker.remaining > 0 && fills < maxMatches) {
            Order storage maker = orders[makerId];
            if (takerBuys ? maker.price > taker.price : maker.price < taker.price) break;
            uint64 nextId = maker.next;

            // Self-trade prevention: cancel the resting order.
            if (maker.trader == taker.trader) {
                _unlink(m, makerId);
                _cancel(makerId, CancelReason.SelfTrade);
                makerId = nextId;
                continue;
            }

            uint128 qty = taker.remaining < maker.remaining ? taker.remaining : maker.remaining;
            (address buyer, address seller) = takerBuys ? (taker.trader, maker.trader) : (maker.trader, taker.trader);

            uint8 code = t.detectSettlementRestriction(seller, buyer, qty);
            if (code != Restrictions.OK) {
                bool makerAtFault = takerBuys ? Restrictions.isSenderSide(code) : Restrictions.isRecipientSide(code);
                if (!makerAtFault) revert TransferRestricted(code);
                _unlink(m, makerId);
                _cancel(makerId, CancelReason.Ineligible);
                makerId = nextId;
                continue;
            }

            uint256 fee = _execute(m, t, takerBuys ? taker : maker, buyer, seller, maker.price, qty);
            emit Trade(address(t), makerId, takerId, buyer, seller, maker.price, qty, fee, fee);
            taker.remaining -= qty;
            maker.remaining -= qty;
            fills++;

            if (maker.remaining == 0) {
                _unlink(m, makerId);
                _close(makerId);
                makerId = nextId;
            }
        }
    }

    function _execute(
        Market storage m,
        PropertyToken t,
        Order storage buyOrder,
        address buyer,
        address seller,
        uint128 price,
        uint128 qty
    ) private returns (uint256 fee) {
        uint256 notional = uint256(price) * qty;
        fee = _fee(notional);
        // The buy order escrowed at its limit price >= trade price, so this cannot underflow.
        buyOrder.escrow -= notional + fee;

        t.settle(seller, buyer, qty);
        quoteToken.safeTransfer(seller, notional - fee);
        if (fee > 0) quoteToken.safeTransfer(treasury, fee * 2);

        m.lastPrice = price;
        m.volume += notional;
        m.trades++;
    }

    function _fee(uint256 notional) private view returns (uint256) {
        return (notional * feeBps) / 10_000;
    }

    // ------------------------------------------------------------------
    // Book maintenance
    // ------------------------------------------------------------------

    /// @dev Bids sorted by price descending, asks ascending; FIFO within a price level.
    function _insert(Market storage m, uint64 id) private {
        Order storage o = orders[id];
        uint64 cur = o.isBuy ? m.bestBid : m.bestAsk;
        uint64 prev;
        while (cur != 0) {
            uint128 p = orders[cur].price;
            if (o.isBuy ? p < o.price : p > o.price) break;
            prev = cur;
            cur = orders[cur].next;
        }
        o.prev = prev;
        o.next = cur;
        if (cur != 0) orders[cur].prev = id;
        if (prev != 0) {
            orders[prev].next = id;
        } else if (o.isBuy) {
            m.bestBid = id;
        } else {
            m.bestAsk = id;
        }
    }

    function _unlink(Market storage m, uint64 id) private {
        Order storage o = orders[id];
        uint64 prev = o.prev;
        uint64 next = o.next;
        if (prev != 0) {
            orders[prev].next = next;
        } else if (o.isBuy) {
            if (m.bestBid == id) m.bestBid = next;
        } else if (m.bestAsk == id) {
            m.bestAsk = next;
        }
        if (next != 0) orders[next].prev = prev;
        o.prev = 0;
        o.next = 0;
    }

    /// @dev Releases whatever the order still holds (escrow / token lock) and deletes it.
    function _cancel(uint64 id, CancelReason reason) private {
        Order storage o = orders[id];
        emit OrderCancelled(id, o.token, o.remaining, reason);
        if (!o.isBuy && o.remaining > 0) PropertyToken(o.token).unlock(o.trader, o.remaining);
        _close(id);
    }

    function _close(uint64 id) private {
        Order storage o = orders[id];
        uint256 refund = o.escrow;
        address trader = o.trader;
        delete orders[id];
        if (refund > 0) quoteToken.safeTransfer(trader, refund);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getListedTokens() external view returns (address[] memory) {
        return listedTokens;
    }

    function getBook(address token, bool bids, uint256 maxOrders) external view returns (OrderView[] memory out) {
        Market storage m = markets[token];
        uint64 cur = bids ? m.bestBid : m.bestAsk;
        uint256 n;
        for (uint64 c = cur; c != 0 && n < maxOrders; c = orders[c].next) n++;
        out = new OrderView[](n);
        for (uint256 i; i < n; i++) {
            Order storage o = orders[cur];
            out[i] = OrderView(cur, o.trader, o.isBuy, o.price, o.remaining);
            cur = o.next;
        }
    }
}
