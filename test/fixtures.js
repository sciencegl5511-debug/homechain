const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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

module.exports = { USDC, US, R, deployPlatform, newProperty, fundedProperty };
