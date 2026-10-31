const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDC, fundedProperty } = require("./fixtures");
const path = require("path");
const { createDb, migrate } = require("../server/db");
const { Indexer } = require("../server/indexer");

// Runs on in-memory SQLite by default. Set TEST_DATABASE_URL=mysql://... to run against MySQL.
const TEST_DB = process.env.TEST_DATABASE_URL || "sqlite::memory:";

describe(`Indexer (${TEST_DB.startsWith("mysql") ? "MySQL" : "SQLite"})`, () => {
  let db;

  beforeEach(async () => {
    db = createDb(TEST_DB);
    await db.migrate.rollback({ directory: path.join(__dirname, "..", "server", "migrations") }, true);
    await migrate(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function setup() {
    const ctx = await loadFixture(fundedProperty);
    for (const s of [ctx.alice, ctx.bob, ctx.carol]) await ctx.usdc.connect(s).approve(ctx.exchange, ethers.MaxUint256);
    const indexer = new Indexer({
      db, provider: ethers.provider, exchange: await ctx.exchange.getAddress(), factory: await ctx.factory.getAddress(), log: () => {},
    });
    await indexer.checkChain();
    return { ...ctx, indexer };
  }

  it("indexes orders, partial fills, cancels and trades", async () => {
    const { exchange, token, alice, bob, carol, indexer } = await setup();
    const t = await token.getAddress();

    await exchange.connect(alice).placeOrder(t, false, USDC(101), 30, false, 10); // 1
    await exchange.connect(carol).placeOrder(t, false, USDC(102), 30, false, 10); // 2
    await exchange.connect(bob).placeOrder(t, true, USDC(102), 40, false, 10); // 3: fills 1 fully, 2 partly
    await exchange.connect(bob).placeOrder(t, true, USDC(95), 10, false, 10); // 4: rests
    await exchange.connect(bob).cancelOrder(4);
    await indexer.sync();

    const orders = Object.fromEntries((await db("orders").orderBy("id")).map((o) => [o.id, o]));
    expect(orders[1]).to.include({ status: "filled", remaining: 0, side: "sell", trader: alice.address });
    expect(orders[2]).to.include({ status: "open", remaining: 20 });
    expect(orders[3]).to.include({ status: "filled", remaining: 0, side: "buy" });
    expect(orders[4]).to.include({ status: "cancelled", cancel_reason: "user", remaining: 10 });

    const trades = await db("trades").orderBy(["block_number", "log_index"]);
    expect(trades.map((x) => [x.maker_order_id, x.price, x.amount])).to.deep.equal([[1, 101, 30], [2, 102, 10]]);
    expect(trades[0]).to.include({ buyer: bob.address, seller: alice.address, buyer_fee: 15.15 });
  });

  it("indexes distributions and valuations, and is incremental", async () => {
    const { token, usdc, issuer, admin, indexer } = await setup();
    await usdc.connect(issuer).approve(token, USDC(10_000));
    await token.connect(issuer).distribute(USDC(2_500), "Rent Nov 2026");
    await indexer.sync();
    await token.connect(admin).updateValuation(USDC(104), "ipfs://report");
    await indexer.sync();
    await indexer.sync(); // nothing new: no duplicates

    const d = await db("distributions");
    expect(d).to.have.length(1);
    expect(d[0]).to.include({ amount: 2500, per_token: 2.5, memo: "Rent Nov 2026" });
    const v = await db("valuations").orderBy("block_number");
    expect(v.map((x) => x.nav_per_token)).to.deep.equal([100, 104]); // initial NAV from the factory + update
    expect(Number(await indexer.lastBlock)).to.equal(await ethers.provider.getBlockNumber());
  });

  it("rebuilds from scratch when pointed at a different deployment", async () => {
    const { exchange, token, alice, indexer } = await setup();
    await exchange.connect(alice).placeOrder(await token.getAddress(), false, USDC(110), 5, false, 10);
    await indexer.sync();
    expect(await db("orders")).to.have.length(1);

    await db("sync_state").where({ key: "chain_fingerprint" }).update({ value: "some-other-chain" });
    await indexer.checkChain();
    expect(await db("orders")).to.have.length(0);
    await indexer.sync();
    expect(await db("orders")).to.have.length(1);
  });
});
