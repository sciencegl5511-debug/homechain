// Deploys the platform to a local Hardhat node and seeds demo data.
//   npx hardhat node                                  (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const US = 840;

async function main() {
  const signers = await ethers.getSigners();
  const [admin, issuer, treasury, alice, bob, carol, dan, eve] = signers;
  const users = [
    { name: "Platform Admin", role: "admin", signer: admin },
    { name: "Issuer (SPV Manager)", role: "issuer", signer: issuer },
    { name: "Alice", role: "investor", signer: alice, kyc: { accredited: true } },
    { name: "Bob", role: "investor", signer: bob, kyc: { accredited: false } },
    { name: "Carol", role: "investor", signer: carol, kyc: { accredited: true } },
    { name: "Eve", role: "investor", signer: eve, kyc: { accredited: false } },
    { name: "Dan (no KYC)", role: "investor", signer: dan },
  ];

  const usdc = await ethers.deployContract("MockUSDC");
  const registry = await ethers.deployContract("IdentityRegistry", [admin.address]);
  const exchange = await ethers.deployContract("PropertyExchange", [usdc, treasury.address, 25, admin.address]);
  const tokenDeployer = await ethers.deployContract("TokenDeployer");
  const offeringDeployer = await ethers.deployContract("OfferingDeployer");
  const factory = await ethers.deployContract("PropertyFactory", [
    registry, usdc, exchange, tokenDeployer, offeringDeployer, admin.address,
  ]);
  await (await exchange.grantRole(await exchange.LISTER_ROLE(), factory)).wait();

  const block = await ethers.provider.getBlock("latest");
  const now = block.timestamp;
  for (const u of users) {
    await (await usdc.mint(u.signer.address, USDC(u.role === "issuer" ? 2_000_000 : 500_000))).wait();
    if (u.kyc) {
      await (await registry.register(u.signer.address, US, u.kyc.accredited, now + 365 * 86400, ethers.id(`kyc-case:${u.name}`))).wait();
    }
  }

  const properties = [
    {
      name: "Maple Court Duplex", symbol: "MAPLE", maxSupply: 4000n,
      info: { spvName: "Maple Court Holdings LLC", jurisdiction: "US-TX", location: "418 Maple Ct, Austin, TX 78704", metadataURI: "ipfs://demo-maple" },
      price: 100, fill: { [alice.address]: 1200, [bob.address]: 900, [carol.address]: 1100, [eve.address]: 800 },
      details: { type: "Duplex", beds: 4, baths: 3, sqft: 2380, yearBuilt: 2004, purchasePrice: 400000, monthlyRent: 3600, occupancy: "100%" },
    },
    {
      name: "Cedar Ridge Townhome", symbol: "CEDAR", maxSupply: 6000n,
      info: { spvName: "Cedar Ridge 7 LLC", jurisdiction: "US-NC", location: "7 Cedar Ridge Ln, Raleigh, NC 27603", metadataURI: "ipfs://demo-cedar" },
      price: 50, fill: { [alice.address]: 1500, [bob.address]: 1500, [carol.address]: 1500, [eve.address]: 1500 },
      details: { type: "Townhome", beds: 3, baths: 2.5, sqft: 1850, yearBuilt: 2015, purchasePrice: 300000, monthlyRent: 2450, occupancy: "100%" },
    },
    {
      name: "Harbor View Condo 4B", symbol: "HARBOR", maxSupply: 5000n,
      info: { spvName: "Harbor View 4B LLC", jurisdiction: "US-FL", location: "1200 Harbor Blvd #4B, Tampa, FL 33602", metadataURI: "ipfs://demo-harbor" },
      price: 100, fill: { [alice.address]: 900, [carol.address]: 700 }, // still raising
      details: { type: "Condo", beds: 2, baths: 2, sqft: 1240, yearBuilt: 2019, purchasePrice: 500000, monthlyRent: 3900, occupancy: "Vacant – listing" },
    },
  ];

  const deployed = [];
  for (const p of properties) {
    const tx = await factory.createProperty({
      name: p.name,
      symbol: p.symbol,
      maxSupply: p.maxSupply,
      info: p.info,
      compliance: { maxHolders: 2000, maxHoldingBps: 4000, accreditedOnly: false, lockupUntil: 0 },
      terms: {
        price: USDC(p.price), softCap: Number(p.maxSupply) / 2, hardCap: p.maxSupply, minPurchase: 5,
        startTime: now, endTime: now + 30 * 86400,
      },
      issuer: issuer.address,
      initialNavPerToken: USDC(p.price),
    });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "PropertyCreated");
    const token = await ethers.getContractAt("PropertyToken", ev.args.token);
    const offering = await ethers.getContractAt("PrimaryOffering", ev.args.offering);

    for (const [addr, amount] of Object.entries(p.fill)) {
      const s = signers.find((x) => x.address === addr);
      await (await usdc.connect(s).approve(offering, USDC(p.price * amount))).wait();
      await (await offering.connect(s).subscribe(amount)).wait();
    }
    if ((await offering.totalSubscribed()) === p.maxSupply) {
      await (await offering.finalize()).wait();
      for (const addr of Object.keys(p.fill)) await (await offering.claimFor(addr)).wait();
    }
    deployed.push({ symbol: p.symbol, token: await token.getAddress(), offering: await offering.getAddress(), details: p.details });
    console.log(`${p.symbol.padEnd(7)} token ${await token.getAddress()}  offering ${await offering.getAddress()}`);
  }

  // Seed some market activity on the two funded properties.
  for (const s of signers.slice(0, 8)) await (await usdc.connect(s).approve(exchange, ethers.MaxUint256)).wait();
  const [maple, cedar] = deployed.map((d) => d.token);
  const place = async (s, token, isBuy, price, amount) =>
    (await exchange.connect(s).placeOrder(token, isBuy, USDC(price), amount, false, 20)).wait();

  await place(alice, maple, false, 104, 60);
  await place(bob, maple, false, 106, 120);
  await place(eve, maple, false, 109, 80);
  await place(carol, maple, true, 103, 50); // no cross
  await place(carol, maple, true, 104, 40); // trades with alice @104
  await place(bob, maple, true, 99, 100);
  await place(eve, maple, true, 97, 150);
  await place(alice, maple, false, 102, 25); // crosses carol's 103 bid
  await place(eve, maple, true, 106, 30); // lifts alice @104 then bob @106

  await place(alice, cedar, false, 52.5, 200);
  await place(carol, cedar, false, 54, 150);
  await place(bob, cedar, true, 51, 300);
  await place(eve, cedar, true, 53, 100); // trades @52.5

  // Two months of rent, net of expenses, paid to holders.
  for (const [i, d] of deployed.slice(0, 2).entries()) {
    const token = await ethers.getContractAt("PropertyToken", d.token);
    await (await usdc.connect(issuer).approve(token, ethers.MaxUint256)).wait();
    const net = d.details.monthlyRent * 0.72; // after mgmt fee, taxes, insurance, reserves
    for (const month of ["Sep 2026", "Oct 2026"]) {
      await (await token.connect(issuer).distribute(USDC(net.toFixed(2)), `Net rent ${month}`)).wait();
    }
    await (await token.connect(admin).updateValuation(USDC(i === 0 ? 103.5 : 51.75), "ipfs://demo-bpo-2026q3")).wait();
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    contracts: {
      usdc: await usdc.getAddress(),
      identityRegistry: await registry.getAddress(),
      exchange: await exchange.getAddress(),
      factory: await factory.getAddress(),
    },
    users: users.map((u) => ({ name: u.name, role: u.role, address: u.signer.address })),
    properties: deployed,
  };
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
