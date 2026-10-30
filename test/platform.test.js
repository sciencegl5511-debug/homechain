const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const US = 840;
const R = {
  OK: 0, CLOSED: 1, PAUSED: 2, SENDER_FROZEN: 3, SENDER_NOT_VERIFIED: 4, INSUFFICIENT_UNLOCKED: 5,
  INSUFFICIENT_LOCKED: 6, LOCKUP: 7, RECIPIENT_FROZEN: 8, RECIPIENT_NOT_VERIFIED: 9, NOT_ACCREDITED: 10,
  COUNTRY_BLOCKED: 11, HOLDER_LIMIT: 12, HOLDING_CAP: 13, SUPPLY_CAP: 14,
};

async function deployPlatform() {
  const [admin, issuer, treasury, alice, bob, carol, dave] = await ethers.getSigners();

  const usdc = await ethers.deployContract("MockUSDC");
  const registry = await ethers.deployContract("IdentityRegistry", [admin.address]);
  const exchange = await ethers.deployContract("PropertyExchange", [usdc, treasury.address, 50, admin.address]);
  const tokenDeployer = await ethers.deployContract("TokenDeployer");
  const offeringDeployer = await ethers.deployContract("OfferingDeployer");
  const factory = await ethers.deployContract("PropertyFactory", [
    registry, usdc, exchange, tokenDeployer, offeringDeployer, admin.address,
  ]);
  await exchange.grantRole(await exchange.LISTER_ROLE(), factory);

  const expiry = (await time.latest()) + 365 * 86400;
  for (const s of [alice, bob, carol]) {
    await registry.register(s.address, US, true, expiry, ethers.id(`kyc:${s.address}`));
  }
  for (const s of [alice, bob, carol, dave, issuer]) {
    await usdc.mint(s.address, USDC(1_000_000));
  }

  return { admin, issuer, treasury, alice, bob, carol, dave, usdc, registry, exchange, factory };
}

async function newProperty(ctx, overrides = {}) {
  const now = await time.latest();
  const params = {
    name: "12 Oak Lane SPV",
    symbol: "OAK12",
    maxSupply: 1000n,
    info: {
      spvName: "Oak Lane 12 LLC",
      jurisdiction: "US-TX",
      location: "12 Oak Lane, Austin, TX",
      metadataURI: "ipfs://bafy-oak12",
    },
    compliance: { maxHolders: 0, maxHoldingBps: 5000, accreditedOnly: false, lockupUntil: 0 },
    terms: {
      price: USDC(100),
      softCap: 500,
      hardCap: 1000,
      minPurchase: 1,
      startTime: now,
      endTime: now + 7 * 86400,
    },
    issuer: ctx.issuer.address,
    initialNavPerToken: USDC(100),
    ...overrides,
  };
  const tx = await ctx.factory.createProperty(params);
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return ctx.factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "PropertyCreated");
  const token = await ethers.getContractAt("PropertyToken", ev.args.token);
  const offering = await ethers.getContractAt("PrimaryOffering", ev.args.offering);
  return { token, offering, params };
}

/// Platform + one property whose offering already closed: alice 400, bob 300, carol 300.
async function fundedProperty() {
  const ctx = await deployPlatform();
  const { token, offering } = await newProperty(ctx);
  for (const [s, n] of [[ctx.alice, 400], [ctx.bob, 300], [ctx.carol, 300]]) {
    await ctx.usdc.connect(s).approve(offering, USDC(100 * n));
    await offering.connect(s).subscribe(n);
  }
  await offering.finalize(); // hard cap reached, no need to wait
  for (const s of [ctx.alice, ctx.bob, ctx.carol]) await offering.claimFor(s.address);
  return { ...ctx, token, offering };
}

describe("IdentityRegistry", () => {
  it("verifies, expires and revokes identities", async () => {
    const { registry, alice, dave } = await loadFixture(deployPlatform);
    expect(await registry.isVerified(alice.address)).to.equal(true);
    expect(await registry.isVerified(dave.address)).to.equal(false);
    await time.increase(366 * 86400);
    expect(await registry.isVerified(alice.address)).to.equal(false);
    await registry.revoke(alice.address);
    expect((await registry.identityOf(alice.address)).verified).to.equal(false);
  });

  it("only KYC agents can register", async () => {
    const { registry, alice, dave } = await loadFixture(deployPlatform);
    await expect(registry.connect(alice).register(dave.address, US, false, 9999999999, ethers.ZeroHash))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
  });
});

describe("PrimaryOffering", () => {
  it("closes successfully, pays the SPV and delivers tokens", async () => {
    const ctx = await loadFixture(deployPlatform);
    const { token, offering } = await newProperty(ctx);
    await ctx.usdc.connect(ctx.alice).approve(offering, USDC(40_000));
    await offering.connect(ctx.alice).subscribe(400);
    await ctx.usdc.connect(ctx.bob).approve(offering, USDC(30_000));
    await offering.connect(ctx.bob).subscribe(300);

    await expect(offering.finalize()).to.be.revertedWithCustomError(offering, "CannotFinalizeYet");
    await time.increase(7 * 86400);
    const before = await ctx.usdc.balanceOf(ctx.issuer.address);
    await offering.finalize();
    expect(await offering.state()).to.equal(1);
    expect((await ctx.usdc.balanceOf(ctx.issuer.address)) - before).to.equal(USDC(70_000));

    await offering.connect(ctx.alice).claim();
    await offering.claimFor(ctx.bob.address);
    expect(await token.balanceOf(ctx.alice.address)).to.equal(400n);
    expect(await token.balanceOf(ctx.bob.address)).to.equal(300n);
    expect(await token.totalSupply()).to.equal(700n);
    expect(await token.holderCount()).to.equal(2n);
  });

  it("refunds everyone when the soft cap is missed", async () => {
    const ctx = await loadFixture(deployPlatform);
    const { token, offering } = await newProperty(ctx);
    await ctx.usdc.connect(ctx.alice).approve(offering, USDC(10_000));
    await offering.connect(ctx.alice).subscribe(100);
    await time.increase(7 * 86400);
    await offering.finalize();
    expect(await offering.state()).to.equal(2);
    const before = await ctx.usdc.balanceOf(ctx.alice.address);
    await offering.connect(ctx.alice).claim();
    expect((await ctx.usdc.balanceOf(ctx.alice.address)) - before).to.equal(USDC(10_000));
    expect(await token.totalSupply()).to.equal(0n);
  });

  it("rejects unverified investors and enforces the per-investor cap", async () => {
    const ctx = await loadFixture(deployPlatform);
    const { offering } = await newProperty(ctx);
    await ctx.usdc.connect(ctx.dave).approve(offering, USDC(100_000));
    await expect(offering.connect(ctx.dave).subscribe(10))
      .to.be.revertedWithCustomError(offering, "TransferRestricted").withArgs(R.RECIPIENT_NOT_VERIFIED);
    await ctx.usdc.connect(ctx.alice).approve(offering, USDC(100_000));
    await expect(offering.connect(ctx.alice).subscribe(501))
      .to.be.revertedWithCustomError(offering, "TransferRestricted").withArgs(R.HOLDING_CAP);
  });

  it("lets the issuer cancel a deal", async () => {
    const ctx = await loadFixture(deployPlatform);
    const { offering } = await newProperty(ctx);
    await expect(offering.connect(ctx.alice).cancel()).to.be.revertedWithCustomError(offering, "NotIssuer");
    await offering.connect(ctx.issuer).cancel();
    expect(await offering.state()).to.equal(2);
  });
});

describe("PropertyToken compliance", () => {
  it("allows transfers between verified investors only", async () => {
    const { token, alice, bob, dave } = await loadFixture(fundedProperty);
    await token.connect(alice).transfer(bob.address, 10);
    expect(await token.balanceOf(bob.address)).to.equal(310n);
    expect(await token.detectTransferRestriction(alice.address, dave.address, 1)).to.equal(R.RECIPIENT_NOT_VERIFIED);
    await expect(token.connect(alice).transfer(dave.address, 1))
      .to.be.revertedWithCustomError(token, "TransferRestricted").withArgs(R.RECIPIENT_NOT_VERIFIED);
    expect(await token.messageForTransferRestriction(R.RECIPIENT_NOT_VERIFIED)).to.equal("Recipient is not KYC verified");
  });

  it("enforces holding cap, frozen accounts, blocked countries, accreditation and pause", async () => {
    const { token, admin, alice, bob, carol, registry } = await loadFixture(fundedProperty);
    // cap is 50% of 1000 = 500; alice holds 400
    await expect(token.connect(bob).transfer(alice.address, 101))
      .to.be.revertedWithCustomError(token, "TransferRestricted").withArgs(R.HOLDING_CAP);

    await token.connect(admin).setFrozen(bob.address, true);
    await expect(token.connect(bob).transfer(alice.address, 1))
      .to.be.revertedWithCustomError(token, "TransferRestricted").withArgs(R.SENDER_FROZEN);
    await token.connect(admin).setFrozen(bob.address, false);

    await token.connect(admin).setCountryBlocked(US, true);
    expect(await token.detectTransferRestriction(bob.address, alice.address, 1)).to.equal(R.COUNTRY_BLOCKED);
    await token.connect(admin).setCountryBlocked(US, false);

    const expiry = (await time.latest()) + 86400;
    await registry.register(carol.address, US, false, expiry, ethers.ZeroHash);
    await token.connect(admin).setCompliance({ maxHolders: 0, maxHoldingBps: 5000, accreditedOnly: true, lockupUntil: 0 });
    expect(await token.detectTransferRestriction(bob.address, carol.address, 1)).to.equal(R.NOT_ACCREDITED);

    await token.connect(admin).pause();
    expect(await token.detectTransferRestriction(alice.address, bob.address, 1)).to.equal(R.PAUSED);
  });

  it("enforces lock-up and max-holder limits", async () => {
    const { token, admin, alice, bob, carol, registry, dave } = await loadFixture(fundedProperty);
    const until = (await time.latest()) + 1000;
    await token.connect(admin).setCompliance({ maxHolders: 3, maxHoldingBps: 0, accreditedOnly: false, lockupUntil: until });
    expect(await token.detectTransferRestriction(alice.address, bob.address, 1)).to.equal(R.LOCKUP);
    await time.increaseTo(until);

    await registry.register(dave.address, US, false, until + 86400 * 30, ethers.ZeroHash);
    expect(await token.detectTransferRestriction(alice.address, dave.address, 1)).to.equal(R.HOLDER_LIMIT);
    // Moving an entire balance does not increase the holder count, so it is allowed.
    await token.connect(carol).transfer(dave.address, 300);
    expect(await token.holderCount()).to.equal(3n);
  });

  it("only the minter can mint and supply is capped", async () => {
    const { token, offering, alice } = await loadFixture(fundedProperty);
    await expect(token.connect(alice).mint(alice.address, 1))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    expect(await token.detectMintRestriction(alice.address, 1)).to.equal(R.SUPPLY_CAP);
    expect(await offering.state()).to.equal(1);
  });
});

describe("Distributions", () => {
  it("pays rent pro-rata and tracks transfers between distributions", async () => {
    const { token, usdc, issuer, alice, bob, carol } = await loadFixture(fundedProperty);
    await usdc.connect(issuer).approve(token, USDC(100_000));
    await token.connect(issuer).distribute(USDC(10_000), "Rent Jan 2026");
    expect(await token.withdrawableOf(alice.address)).to.equal(USDC(4_000));

    await token.connect(alice).transfer(bob.address, 100); // alice 300, bob 400
    await token.connect(issuer).distribute(USDC(10_000), "Rent Feb 2026");
    expect(await token.withdrawableOf(alice.address)).to.equal(USDC(7_000));
    expect(await token.withdrawableOf(bob.address)).to.equal(USDC(7_000));
    expect(await token.withdrawableOf(carol.address)).to.equal(USDC(6_000));

    const before = await usdc.balanceOf(alice.address);
    await token.connect(alice).claim();
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(USDC(7_000));
    expect(await token.withdrawableOf(alice.address)).to.equal(0n);
    expect(await token.totalDistributed()).to.equal(USDC(20_000));
  });

  it("recovers a lost wallet with its balance and unclaimed rent", async () => {
    const { token, usdc, admin, issuer, alice, registry, dave } = await loadFixture(fundedProperty);
    await usdc.connect(issuer).approve(token, USDC(1_000));
    await token.connect(issuer).distribute(USDC(1_000), "Rent");
    await registry.register(dave.address, US, true, (await time.latest()) + 86400, ethers.ZeroHash);
    await token.connect(admin).recoverWallet(alice.address, dave.address);
    expect(await token.balanceOf(dave.address)).to.equal(400n);
    expect(await token.withdrawableOf(dave.address)).to.equal(USDC(400));
    expect(await token.withdrawableOf(alice.address)).to.equal(0n);
    expect(await token.frozen(alice.address)).to.equal(true);
  });

  it("closing a property stops transfers but not claims", async () => {
    const { token, usdc, admin, issuer, alice, bob } = await loadFixture(fundedProperty);
    await usdc.connect(issuer).approve(token, USDC(500_000));
    await token.connect(issuer).distribute(USDC(500_000), "Sale proceeds");
    await token.connect(admin).closeProperty();
    await expect(token.connect(alice).transfer(bob.address, 1))
      .to.be.revertedWithCustomError(token, "TransferRestricted").withArgs(R.CLOSED);
    await token.connect(alice).claim();
    expect(await token.withdrawableOf(alice.address)).to.equal(0n);
  });
});

describe("PropertyExchange", () => {
  async function approveAll(ctx) {
    for (const s of [ctx.alice, ctx.bob, ctx.carol, ctx.dave]) {
      await ctx.usdc.connect(s).approve(ctx.exchange, ethers.MaxUint256);
    }
  }

  it("lists properties created by the factory", async () => {
    const { exchange, token } = await loadFixture(fundedProperty);
    expect(await exchange.getListedTokens()).to.deep.equal([await token.getAddress()]);
    expect((await exchange.markets(token)).listed).to.equal(true);
  });

  it("locks tokens for resting sell orders and keeps them earning rent", async () => {
    const ctx = await loadFixture(fundedProperty);
    const { exchange, token, alice, bob, usdc, issuer } = ctx;
    await exchange.connect(alice).placeOrder(token, false, USDC(110), 100, false, 10);
    expect(await token.lockedOf(alice.address)).to.equal(100n);
    await expect(token.connect(alice).transfer(bob.address, 301))
      .to.be.revertedWithCustomError(token, "TransferRestricted").withArgs(R.INSUFFICIENT_UNLOCKED);

    await usdc.connect(issuer).approve(token, USDC(1000));
    await token.connect(issuer).distribute(USDC(1000), "Rent");
    expect(await token.withdrawableOf(alice.address)).to.equal(USDC(400));
  });

  it("matches at the maker price, charges fees and refunds price improvement", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, usdc, alice, bob, treasury } = ctx;

    await exchange.connect(alice).placeOrder(token, false, USDC(105), 50, false, 10);
    const bobUsdc = await usdc.balanceOf(bob.address);
    const aliceUsdc = await usdc.balanceOf(alice.address);

    await expect(exchange.connect(bob).placeOrder(token, true, USDC(110), 50, false, 10))
      .to.emit(exchange, "Trade");

    const notional = USDC(105) * 50n;
    const fee = (notional * 50n) / 10_000n;
    expect(bobUsdc - (await usdc.balanceOf(bob.address))).to.equal(notional + fee);
    expect((await usdc.balanceOf(alice.address)) - aliceUsdc).to.equal(notional - fee);
    expect(await usdc.balanceOf(treasury.address)).to.equal(fee * 2n);
    expect(await usdc.balanceOf(exchange)).to.equal(0n);
    expect(await token.balanceOf(bob.address)).to.equal(350n);
    expect(await token.lockedOf(alice.address)).to.equal(0n);

    const m = await exchange.markets(token);
    expect(m.lastPrice).to.equal(USDC(105));
    expect(m.bestAsk).to.equal(0n);
    expect(m.bestBid).to.equal(0n);
  });

  it("keeps price-time priority and supports partial fills", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, alice, bob, carol } = ctx;

    await exchange.connect(alice).placeOrder(token, false, USDC(103), 20, false, 10); // id1
    await exchange.connect(bob).placeOrder(token, false, USDC(101), 20, false, 10); // id2
    await exchange.connect(alice).placeOrder(token, false, USDC(101), 20, false, 10); // id3 (behind id2)
    await exchange.connect(bob).placeOrder(token, false, USDC(102), 20, false, 10); // id4

    const asks = await exchange.getBook(token, false, 10);
    expect(asks.map((o) => Number(o.id))).to.deep.equal([2, 3, 4, 1]);

    // carol buys 50 up to 102: fills id2 (20), id3 (20), 10 of id4
    await exchange.connect(carol).placeOrder(token, true, USDC(102), 50, false, 10);
    const after = await exchange.getBook(token, false, 10);
    expect(after.map((o) => [Number(o.id), Number(o.remaining)])).to.deep.equal([[4, 10], [1, 20]]);
    expect(await token.balanceOf(carol.address)).to.equal(350n);
    expect((await exchange.markets(token)).trades).to.equal(3n);
  });

  it("rests unfilled buy orders and refunds escrow on cancel", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, usdc, bob } = ctx;
    const start = await usdc.balanceOf(bob.address);
    await exchange.connect(bob).placeOrder(token, true, USDC(95), 10, false, 10);
    await exchange.connect(bob).placeOrder(token, true, USDC(97), 10, false, 10);
    const bids = await exchange.getBook(token, true, 10);
    expect(bids.map((o) => o.price)).to.deep.equal([USDC(97), USDC(95)]);

    await expect(exchange.connect(ctx.alice).cancelOrder(bids[0].id))
      .to.be.revertedWithCustomError(exchange, "NotAuthorized");
    await exchange.connect(bob).cancelOrder(bids[0].id);
    await exchange.connect(bob).cancelOrder(bids[1].id);
    expect(await usdc.balanceOf(bob.address)).to.equal(start);
    expect((await exchange.markets(token)).bestBid).to.equal(0n);
  });

  it("cancels the remainder of IOC orders and unlocks tokens", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, alice, bob } = ctx;
    await exchange.connect(bob).placeOrder(token, true, USDC(100), 10, false, 10);
    await exchange.connect(alice).placeOrder(token, false, USDC(100), 30, true, 10);
    expect(await token.balanceOf(alice.address)).to.equal(390n);
    expect(await token.lockedOf(alice.address)).to.equal(0n);
    expect((await exchange.markets(token)).bestAsk).to.equal(0n);
  });

  it("prevents self-trades by cancelling the resting order", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, alice } = ctx;
    await exchange.connect(alice).placeOrder(token, false, USDC(100), 10, false, 10);
    await expect(exchange.connect(alice).placeOrder(token, true, USDC(100), 10, false, 10))
      .to.emit(exchange, "OrderCancelled");
    expect(await token.lockedOf(alice.address)).to.equal(0n);
    expect((await exchange.markets(token)).bestAsk).to.equal(0n);
    expect((await exchange.getBook(token, true, 10)).length).to.equal(1);
  });

  it("skips and cancels stale maker orders, rejects ineligible takers", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, admin, alice, bob, carol, dave } = ctx;
    await exchange.connect(alice).placeOrder(token, false, USDC(100), 10, false, 10); // id1
    await exchange.connect(carol).placeOrder(token, false, USDC(101), 10, false, 10); // id2
    await token.connect(admin).setFrozen(alice.address, true);

    await exchange.connect(bob).placeOrder(token, true, USDC(101), 10, false, 10);
    expect(await token.balanceOf(bob.address)).to.equal(310n); // filled from carol
    expect(await token.balanceOf(alice.address)).to.equal(400n);
    expect(await token.lockedOf(alice.address)).to.equal(0n); // alice's order was cancelled

    await expect(exchange.connect(dave).placeOrder(token, true, USDC(101), 1, false, 10))
      .to.be.revertedWithCustomError(exchange, "TransferRestricted").withArgs(R.RECIPIENT_NOT_VERIFIED);
  });

  it("cancels resting bids whose owner became ineligible", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, usdc, registry, alice, bob } = ctx;
    await exchange.connect(bob).placeOrder(token, true, USDC(100), 10, false, 10);
    const bobBefore = await usdc.balanceOf(bob.address);
    await registry.revoke(bob.address);
    await exchange.connect(alice).placeOrder(token, false, USDC(100), 10, false, 10);
    expect(await token.balanceOf(bob.address)).to.equal(300n);
    expect(await usdc.balanceOf(bob.address)).to.be.gt(bobBefore); // escrow refunded
    expect((await exchange.getBook(token, false, 10)).length).to.equal(1); // alice's ask rests
  });

  it("operators can pause trading and cancel orders; fee is capped", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, admin, alice, treasury } = ctx;
    await exchange.connect(alice).placeOrder(token, false, USDC(100), 10, false, 10);
    await exchange.connect(admin).cancelOrder(1);
    expect(await token.lockedOf(alice.address)).to.equal(0n);
    await exchange.connect(admin).pause();
    await expect(exchange.connect(alice).placeOrder(token, false, USDC(100), 10, false, 10))
      .to.be.revertedWithCustomError(exchange, "EnforcedPause");
    await expect(exchange.setFee(201, treasury.address)).to.be.revertedWithCustomError(exchange, "FeeTooHigh");
  });

  it("forced transfer of locked tokens leaves the exchange consistent", async () => {
    const ctx = await loadFixture(fundedProperty);
    await approveAll(ctx);
    const { exchange, token, admin, alice, bob, carol } = ctx;
    await token.connect(admin).setCompliance({ maxHolders: 0, maxHoldingBps: 0, accreditedOnly: false, lockupUntil: 0 });
    await exchange.connect(alice).placeOrder(token, false, USDC(100), 400, false, 10);
    await token.connect(admin).forcedTransfer(alice.address, carol.address, 200, "court order");
    expect(await token.lockedOf(alice.address)).to.equal(200n);

    // The order still says 400 but only 200 are locked. A fill within the lock settles...
    await exchange.connect(bob).placeOrder(token, true, USDC(100), 150, false, 10);
    expect(await token.balanceOf(bob.address)).to.equal(450n);
    expect(await token.lockedOf(alice.address)).to.equal(50n);
    // ...a fill beyond it cancels alice's stale order and the bid rests instead.
    await exchange.connect(bob).placeOrder(token, true, USDC(100), 100, false, 10);
    expect(await token.balanceOf(bob.address)).to.equal(450n);
    expect(await token.lockedOf(alice.address)).to.equal(0n);
    expect((await exchange.getBook(token, false, 10)).length).to.equal(0);
    expect((await exchange.getBook(token, true, 10)).length).to.equal(1);
  });
});
