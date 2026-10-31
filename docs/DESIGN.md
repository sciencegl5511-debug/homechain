# HomeChain: Design

A platform that splits single-family homes, duplexes, townhomes and condos into regulated digital
shares. It sells those shares in a primary offering, pays rent to holders in a stablecoin, and runs a
compliant secondary market where holders can trade with each other.

---

## 1. Goals and non-goals

**Goals**
- Fractional ownership of individual residential properties, with prices starting around $50–$100 per share.
- Compliance enforced on-chain, so a token can only end up in an eligible wallet no matter which venue moves it.
- Rent distribution that costs the same whether a property has 5 holders or 5,000.
- A transparent secondary market that settles atomically (delivery-versus-payment) in a stablecoin.
- Operational controls a regulator or court expects: freeze, forced transfer, lost-wallet recovery, pause.

**Non-goals (v1)**
- Permissionless DeFi composability. Tokens are securities and cannot sit in arbitrary AMMs.
- Owning a share of the house itself. Investors own equity in a legal entity that owns the house (see §2).
- Mortgage financing, tokenized debt, or multi-property funds. The architecture leaves room for these later.

---

## 2. Legal wrapper (the part code cannot fix)

```
 Investors ──own──▶ PropertyToken (= membership units of SPV)
                          │
                          ▼
             Property SPV (one LLC per house) ──holds title──▶ Deed / Property
                          │
                   managed by Issuer / Asset Manager ──contracts──▶ Property manager, insurer, lender
```

- **One SPV per property.** Each property is held by its own LLC or Series LLC. A problem with one
  property (litigation, a casualty loss) cannot spread to the others. The token *is* the SPV's
  membership interest, and the operating agreement names the token ledger as the register of members.
- **Securities status.** The tokens are securities. In the US, typical exemptions are Reg D 506(c)
  (accredited investors only, 12-month resale restriction), Reg A+ Tier 2 (open to retail, up to
  $75M per year), or Reg CF. The token's `ComplianceConfig` maps onto these: `accreditedOnly`,
  `lockupUntil`, `maxHolders` (to stay under the 12(g) 2,000-holder threshold) and `maxHoldingBps`.
- **Secondary trading** of these securities requires a registered venue: an ATS run by a broker-dealer,
  or a transfer agent arrangement. The on-chain `PropertyExchange` is the matching and settlement engine
  that the ATS operates. The platform operator holds the `OPERATOR_ROLE` and `LISTER_ROLE`.
- **Transfer agent.** The `AGENT_ROLE` on each token belongs to a registered transfer agent, who
  carries out court orders, estate transfers and wallet recoveries.

> This document describes a technical design. Before going live it needs securities, tax and
> real-estate counsel in each target jurisdiction.

---

## 3. System architecture

```
┌────────────────────────── Off-chain ──────────────────────────┐   ┌──────────────── On-chain (EVM L2) ────────────────┐
│                                                               │   │                                                    │
│  Web / mobile app ──▶ API gateway ──▶ Onboarding & KYC svc ───┼──▶│ IdentityRegistry   (allow-list, no PII)            │
│        │                   │            (Persona/Sumsub/...)  │   │                                                    │
│        │                   ├──▶ Origination svc ──────────────┼──▶│ PropertyFactory ─┬─▶ PropertyToken  (per property) │
│        │                   │     (diligence, title, appraisal)│   │                  └─▶ PrimaryOffering (per property)│
│        │                   ├──▶ Asset mgmt / rent svc ────────┼──▶│ PropertyToken.distribute()                         │
│        │                   │     (PM software, bank, USDC)    │   │                                                    │
│        │                   ├──▶ Valuation svc (AVM + BPO) ────┼──▶│ PropertyToken.updateValuation()                    │
│        │                   └──▶ Indexer (events → Postgres) ◀─┼───│ PropertyExchange (CLOB, DvP settlement)            │
│        │                                                      │   │                                                    │
│  Wallet: embedded MPC wallet or user's own wallet (signs txs) ┼──▶│ USDC (quote + payout asset)                        │
└───────────────────────────────────────────────────────────────┘   └────────────────────────────────────────────────────┘
```

**Chain choice.** Use an EVM L2 (Base, Arbitrum, or a permissioned rollup) for cheap gas and native
USDC. The contracts work on any EVM chain.

**Custody.** Most retail users get an embedded MPC wallet (e.g. Privy, Fireblocks, Turnkey) linked to
their KYC'd account, and can connect a self-custodied wallet once it is verified. Because recovery runs
through `recoverWallet`, losing a key never means losing the asset.

---

## 4. Smart contracts

| Contract | Responsibility |
|---|---|
| `IdentityRegistry` | KYC allow-list: verified flag, accreditation, country, expiry, hash of the KYC case. No PII on-chain. Shared by all properties. |
| `PropertyToken` | ERC-20 with 0 decimals and ERC-1404 transfer restrictions. Holds the compliance rules, distribution accumulator, exchange locks, agent controls, NAV and property metadata. |
| `PrimaryOffering` | Fixed-price, all-or-nothing raise with soft and hard caps. Holds investor funds in escrow, pays the SPV on success and refunds everyone on failure. |
| `PropertyExchange` | On-chain central limit order book (one per platform, one market per token) with price-time priority, DvP settlement, fees and stale-order handling. |
| `PropertyFactory` | Onboards a property in one transaction: deploys the token and offering, wires roles, lists the market and records the property in the registry. |
| `TokenDeployer` / `OfferingDeployer` | Stateless helpers that keep the factory under the 24 KB contract-size limit. |
| `Restrictions` | Shared restriction codes and messages, grouped so the exchange can tell which side caused a failure. |

### 4.1 Roles

| Role | Holder | Powers |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` (token) | Platform admin multisig | Compliance config, blocked countries, close the property, grant roles |
| `ISSUER_ROLE` | SPV manager | Distributions, metadata URI |
| `MINTER_ROLE` | That property's `PrimaryOffering` only | Mint, capped at `maxSupply` |
| `AGENT_ROLE` | Transfer agent | Freeze, forced transfer, wallet recovery, pause |
| `EXCHANGE_ROLE` | `PropertyExchange` | Lock, unlock and settle |
| `APPRAISER_ROLE` | Valuation oracle / appraiser | Publish NAV per token and the report URI |
| `KYC_AGENT_ROLE` | Onboarding service | Register and revoke identities |
| `LISTER_ROLE` / `OPERATOR_ROLE` (exchange) | Factory / ATS operator | List markets; pause; cancel orders |

In production every admin role is a multisig behind a timelock, except the emergency `pause`
functions, which need to act immediately.

### 4.2 Compliance model

All transfer paths check `detectTransferRestriction(from, to, value)`: plain `transfer`,
`transferFrom`, exchange `settle`, and `mint`. A non-zero code reverts with `TransferRestricted(code)`.
The checks are:

| Side | Checks |
|---|---|
| Global | property closed, paused, lock-up period |
| Sender | frozen, KYC valid, enough **unlocked** balance (or enough **locked** balance for exchange settlement) |
| Recipient | frozen, KYC valid, accredited if required, country not blocked, holder count limit, per-investor holding cap, supply cap (mint) |

The rules are enforced **in the token**, not in the exchange. A peer-to-peer transfer, another venue,
or a future bridge therefore cannot route around them.

### 4.3 Distributions (rent, refinance, sale proceeds)

The token uses the "magnified dividend per share" accumulator:

```
distribute(amount):  magnifiedPerShare += amount * 2^128 / totalSupply
on every balance change of `value` from A to B:
    corrections[A] += magnifiedPerShare * value
    corrections[B] -= magnifiedPerShare * value
withdrawable(h) = (magnifiedPerShare * balance(h) + corrections[h]) / 2^128 − withdrawn[h]
```

- Distributing costs O(1) gas at any holder count. Each holder pulls their share with `claim()`, or a
  relayer can batch claims for them.
- Tokens listed on the exchange stay in the seller's wallet (they are *locked*, not escrowed), so a
  seller keeps earning rent until the trade settles. This matches real-estate practice, where rent is
  prorated to the closing date.
- `recoverWallet` moves the balance **and** any unclaimed rent to the new wallet.
- Rounding dust (at most 1 base unit per holder per distribution) stays in the contract.

**Cash waterfall (off-chain, per month):** gross rent → property manager fee (8–10%) → taxes and
insurance escrow → CapEx reserve → platform asset-management fee → net rent → `distribute()`. The
demo uses 72% of gross rent as the net amount.

### 4.4 Primary offering lifecycle

```
 Active ──(sold out or end time, ≥ soft cap)──▶ Succeeded ──▶ claimFor(investor) mints tokens
   │                                                          SPV receives proceeds → closes on house
   └──(end time, < soft cap) or issuer cancel)───▶ Failed ──▶ claimFor(investor) refunds USDC
```

Eligibility is checked when an investor subscribes and again when tokens are minted, because KYC can
expire in between. `claimFor` can be called by anyone, so the back office can push allocations in bulk.

**Funding sequence:** the issuer signs a purchase contract with a financing contingency and runs the
offering during the contingency period. When the offering succeeds, the proceeds plus any
mortgage or bridge loan fund the closing. If it fails, the earnest money is the only cost at risk.
An alternative is for the platform to buy the house first with a warehouse line and sell it down
through the offering.

### 4.5 Exchange design

**Model:** a fully on-chain central limit order book with price-time priority.

- Each side of each market is a sorted doubly linked list. Insertion walks the list (O(n)), and
  matching pops orders from the head. The `maxMatches` argument caps gas use per transaction.
- **Buy orders** escrow `limit × qty + fee` in USDC. Trades execute at the maker's price, so the
  taker keeps any price improvement, and the leftover escrow is refunded when the order closes.
- **Sell orders** call `token.lock()`. The tokens stay in the seller's wallet and keep earning rent,
  but cannot be moved until the order is cancelled or filled.
- **Settlement:** `token.settle()` and the USDC transfers happen in the same transaction (DvP).
  There is no settlement risk and no T+2.
- **Fees:** `feeBps` is charged to both buyer and seller on notional and sent to the treasury. It is
  capped at 2% in the contract.
- **Self-trade prevention:** when an incoming order would match the same trader's resting order,
  the resting order is cancelled.
- **Stale orders:** every fill is re-checked with `detectSettlementRestriction`. If the *maker* is at
  fault (frozen, KYC expired, holding cap, a transfer agent removed locked tokens), their order is
  cancelled with its escrow or lock released, and matching continues. If the *taker* is at fault,
  the transaction reverts with the restriction code.
- **Order types:** limit (GTC) and immediate-or-cancel. A market order is an IOC at a wide limit.

**Why a fully on-chain CLOB?** Residential tokens trade thinly: a few dozen orders per market and a
handful of trades per day. At that volume full transparency and simplicity outweigh the gas cost of
O(n) insertion on an L2.

**Scaling path (hybrid CLOB).** If volume grows, move matching off-chain and keep settlement on-chain:
1. Users sign EIP-712 orders. An off-chain matcher (the ATS) pairs them.
2. A `settleMatch(buyOrder, sellOrder, sigs, qty, price)` function checks the signatures, nonces,
   limits and compliance, then runs the same `settle()` DvP.
3. Users keep custody until the match. Cancels work by bumping the nonce or are handled off-chain.
The token-side interface (`lock`, `unlock`, `settle`, `detect*Restriction`) does not change.

**Market integrity features worth adding next:** circuit breakers (pause the market if a trade
prints more than X% from NAV), periodic call auctions for illiquid markets (for example a daily
uncross), tick sizes, and an order-to-trade ratio limit.

### 4.6 Valuation

`navPerToken` comes from an appraiser or oracle role. Sources, in order of strength: a full
appraisal at offering and annually; quarterly broker price opinions; a monthly AVM. Each update links
to the report (`navReportURI`). The UI shows NAV next to the last traded price so investors can see
any premium or discount, and a circuit breaker can use the same NAV.

### 4.7 Exit

When the property is sold, the issuer distributes the net sale proceeds through `distribute()`, then
the admin calls `closeProperty()`. Transfers and trading stop permanently and holders claim their
final distribution. A future governance module could put a sale to a token-holder vote, with a
quorum and a supermajority.

---

## 5. Off-chain services

| Service | Responsibilities |
|---|---|
| **Onboarding / KYC** | Document and liveness checks, sanctions/PEP screening, accreditation (income/net-worth letters or verification services), tax forms (W-9/W-8BEN). Writes `register` / `revoke`. Re-screens on a schedule; revokes on sanctions hits. |
| **Origination** | Sourcing, underwriting (rent comps, cap rate, inspection), title and insurance, SPV formation, offering memorandum. Calls `createProperty`. |
| **Asset management** | Integrates with property-management software and bank accounts. Runs the monthly waterfall, converts fiat to USDC, calls `distribute`, and produces K-1s / 1099s. |
| **Indexer** | Subscribes to `Trade`, `OrderPlaced`, `OrderCancelled`, `Distributed`, `Transfer`, and so on. Builds read models (order book depth, OHLC candles, portfolios, cost basis) in Postgres for the API. |
| **Fiat ramps** | ACH/wire to USDC through a regulated on-ramp, and back again for withdrawals. |
| **Surveillance / reporting** | Wash-trade and spoofing detection, large-trader reports, the ATS's Form ATS-N obligations, and the transfer agent's register of members. |

The demo `server/` folder implements a small slice of this. Investor/KYC records, property details
and an activity log are stored in a database (SQLite by default, MySQL via `DATABASE_URL`). An indexer
copies chain events into `orders`, `trades`, `distributions` and `valuations` tables. Balances and the
live order book are still read from the chain. Write endpoints sign as demo users.

---

## 6. Security considerations

- **Reentrancy:** state-changing exchange and offering functions are `nonReentrant`. The token
  only calls the trusted USDC.
- **Escrow math:** fees are floored per fill, and the sum of floors is never more than the floor of
  the sum, so buy escrow cannot underflow. A test asserts the exchange holds 0 USDC after a full fill.
- **Lock consistency:** `unlock` clamps to the current lock. When a forced transfer reduces a lock,
  the exchange sees `INSUFFICIENT_LOCKED` at fill time and cancels the stale order instead of reverting.
- **Upgradeability:** the contracts are deliberately not upgradeable, because a security token whose
  logic can change underneath holders is a governance risk. Instead, migrate by deploying a new token,
  pausing the old one, and snapshotting and airdropping balances through the transfer agent.
- **Admin keys:** multisig plus timelock, with separate keys per role. Pausing is the only fast path.
- **Oracle risk:** NAV is informational and never used for settlement, so a bad appraisal cannot
  drain funds.
- **Gas griefing:** a large number of tiny resting orders makes insertion more expensive. Mitigations
  are a minimum order size, a per-trader open-order cap, and the hybrid CLOB.
- **Before mainnet:** an external audit, invariant/fuzz tests (escrow conservation, holder count
  equal to the number of non-zero balances, distribution conservation), and a formal review of
  `_match`.

---

## 7. Data model (indexer / API)

```
users(id, wallet, kyc_status, accredited, country, kyc_ref, created_at)
properties(token, offering, spv, address, type, beds, baths, sqft, purchase_price, status)
orders(id, token, trader, side, price, qty, remaining, status, placed_tx, updated_at)
trades(id, token, maker_order, taker_order, buyer, seller, price, qty, fees, tx, ts)
distributions(id, token, amount, per_token, memo, tx, ts)
valuations(id, token, nav_per_token, report_uri, ts)
holdings(token, wallet, balance, locked, cost_basis, rent_received)   -- derived
```

---

## 8. Demo vs. production

| Area | Demo (this repo) | Production |
|---|---|---|
| Signing | Server signs with Hardhat's unlocked accounts | User wallet / MPC; server never holds keys |
| Stablecoin | `MockUSDC` with an open faucet | Native USDC on the L2 |
| KYC | Button in "Operations" | Provider webhook → KYC service → `register` |
| Read path | Polling indexer into SQLite/MySQL, plus live RPC for balances | Indexer with reorg handling (confirmations, block-hash checks) into Postgres/MySQL |
| Off-chain records | `investors`, `properties`, `activity_log` tables | Same, plus encrypted PII store and document vault |
| Admin | Single EOA | Multisig + timelock per role |
| Property data | Hard-coded in the deploy script | Origination service and IPFS document bundle |
