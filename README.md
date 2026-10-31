# HomeChain

A residential real-estate tokenization platform with compliant on-chain trading.

Each house is held by its own LLC (an SPV), and that LLC's shares are issued as a permissioned
ERC-20 token. Investors buy in through a primary offering, receive rent in USDC, and trade with each
other on an on-chain order book. KYC, accreditation, jurisdiction, lock-up and holding-cap rules are
checked on every transfer.

See **[docs/DESIGN.md](docs/DESIGN.md)** for the full design: legal structure, architecture,
compliance model, exchange design, security, and what changes between the demo and production.

## What's in here

```
contracts/
  IdentityRegistry.sol   KYC allow-list (no PII on-chain)
  PropertyToken.sol      ERC-1404 security token: compliance, rent distribution, exchange locks, agent controls
  PrimaryOffering.sol    all-or-nothing initial sale with soft and hard caps, refunds on failure
  PropertyExchange.sol   on-chain limit order book with atomic DvP settlement in USDC
  PropertyFactory.sol    one-call property onboarding (token + offering + roles + listing)
  Deployers.sol          size-split deploy helpers
  Restrictions.sol       transfer restriction codes
  mocks/MockUSDC.sol
test/platform.test.js    24 tests: offering, compliance, distributions, recovery, matching, fees, stale orders
scripts/deploy.js        deploys to a local node and seeds 3 properties, KYC'd users, orders, trades, rent
server/
  index.js               demo API (Express + ethers)
  db.js                  database connection: SQLite by default, MySQL via DATABASE_URL
  migrations/            schema (Knex migrations, same for both databases)
  indexer.js             copies chain events (orders, trades, rent, valuations) into the database
  store.js               investor/KYC records and property details
  public/                web app (vanilla JS)
test/indexer.test.js     indexer tests (SQLite by default, MySQL with TEST_DATABASE_URL)
docker-compose.yml       optional local MySQL
```

## Run it

Requires Node 18+.

```bash
npm install --legacy-peer-deps
```

```bash
npm test
```

To run the demo app, use three terminals:

```bash
npm run node
```

```bash
npm run deploy
```

```bash
npm run app
```

Open http://localhost:3000. Use the account switcher to act as different users:

- **Alice / Bob / Carol / Eve:** KYC'd investors. They can browse properties, subscribe to the Harbor
  View offering, trade MAPLE and CEDAR (click a price level in the book to fill the price), and
  claim rent from the Portfolio tab.
- **Dan (no KYC):** every buy, subscription or transfer is rejected on-chain with a readable reason.
  To fix that, register him under Operations → KYC.
- **Issuer:** distributes rent (Operations).
- **Platform Admin:** publishes valuations and registers KYC. To close the Harbor offering, use
  "Advance chain time" and then "Finalize".

## Storage

The app keeps its data in a database. By default that's a SQLite file at
`data/homechain.sqlite`, created automatically on first start with nothing to install. To use MySQL
instead, set `DATABASE_URL`:

```bash
docker compose up -d
```

```bash
DATABASE_URL=mysql://homechain:homechain@127.0.0.1:3306/homechain npm run app
```

What lives where:

| Data | Where | Notes |
|---|---|---|
| Token balances, locks, claimable rent, live order book | Chain | Always read live; the chain is the source of truth |
| Investor profiles and KYC decisions | `investors` table | System of record. On startup, anyone verified here but not on-chain is re-registered |
| Property details (beds, rent, sqft, ...) | `properties` table | Seeded from the deploy script on first run, then edited in the DB |
| Orders, trades, distributions, valuations | `orders`, `trades`, `distributions`, `valuations` | Indexed from chain events. Rebuilt automatically when the chain is reset or redeployed |
| Every action taken through the API | `activity_log` | Shown under Operations → Activity log |

`npx hardhat node` keeps its chain in memory, so restarting it wipes balances and trades. The
database survives: after you restart the node and run `npm run deploy` again, KYC approvals and the
activity log are still there, and the indexed tables are rebuilt from the new chain.

## Key design points

- **Compliance lives in the token**, so it holds on every path: transfers, exchange settlement and minting.
- **Sell orders lock tokens in place** instead of escrowing them, so sellers keep earning rent until the trade fills.
- **Distributions cost O(1)** regardless of holder count (magnified-dividend accumulator, pull-based claims).
- **Every fill is re-checked**. A resting order that went stale (frozen, KYC expired, cap exceeded,
  forced transfer) is cancelled and matching carries on, so one bad maker cannot block the book.
- **Transfer-agent controls** (freeze, forced transfer, lost-wallet recovery including unclaimed rent,
  pause, close) cover court orders and lost keys.

> Demo only. The contracts are unaudited, and the server signs as demo users with Hardhat's unlocked
> accounts. Real deployment needs securities counsel, a registered ATS/transfer agent, an audit, and
> multisig admin keys (see DESIGN.md §2, §6, §8).
