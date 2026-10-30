// Demo API + static web app for the HomeChain platform.
// It signs transactions with the Hardhat node's unlocked accounts so the UI can switch between
// demo users without a wallet. In production the browser signs with the user's own wallet
// (or an MPC custody provider) and this service is a read-only indexer + KYC/off-chain workflow API.
const path = require("path");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT || 3000);
const DEPLOYMENT = process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", "localhost.json");

const abi = (name) =>
  require(path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`)).abi;
const ABI = {
  token: abi("PropertyToken"),
  offering: abi("PrimaryOffering"),
  exchange: abi("PropertyExchange"),
  registry: abi("IdentityRegistry"),
  factory: abi("PropertyFactory"),
  usdc: require(path.join(__dirname, "..", "artifacts", "contracts", "mocks", "MockUSDC.sol", "MockUSDC.json")).abi,
};
const errorIface = new ethers.Interface([...ABI.token, ...ABI.offering, ...ABI.exchange, ...ABI.usdc]);

if (!fs.existsSync(DEPLOYMENT)) {
  console.error(`No deployment at ${DEPLOYMENT}. Run: npm run deploy`);
  process.exit(1);
}
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });

const usdc = new ethers.Contract(dep.contracts.usdc, ABI.usdc, provider);
const registry = new ethers.Contract(dep.contracts.identityRegistry, ABI.registry, provider);
const exchange = new ethers.Contract(dep.contracts.exchange, ABI.exchange, provider);
const factory = new ethers.Contract(dep.contracts.factory, ABI.factory, provider);
const tokenAt = (a) => new ethers.Contract(a, ABI.token, provider);
const offeringAt = (a) => new ethers.Contract(a, ABI.offering, provider);
const detailsBySymbol = Object.fromEntries(dep.properties.map((p) => [p.symbol, p.details]));

const D = 6; // stablecoin decimals
const fmt = (v) => Number(ethers.formatUnits(v, D));
const parse = (v) => ethers.parseUnits(String(v), D);
const OFFERING_STATE = ["Active", "Succeeded", "Failed"];

const userByAddress = Object.fromEntries(dep.users.map((u) => [u.address.toLowerCase(), u]));
function userName(address) {
  return userByAddress[address.toLowerCase()]?.name ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Serialise writes so nonces from the shared JSON-RPC signers never collide.
let queue = Promise.resolve();
function send(userAddress, build) {
  const run = async () => {
    const signer = await provider.getSigner(userAddress);
    const tx = await build(signer);
    const rc = await tx.wait();
    return { hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function decodeError(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (data && typeof data === "string" && data.length >= 10) {
    try {
      const parsed = errorIface.parseError(data);
      if (parsed?.name === "TransferRestricted") {
        const code = Number(parsed.args[0]);
        const msg = await tokenAt(dep.properties[0].token).messageForTransferRestriction(code);
        return `Compliance check failed: ${msg} (code ${code})`;
      }
      if (parsed) return `${parsed.name}${parsed.args.length ? `(${parsed.args.join(", ")})` : ""}`;
    } catch {}
  }
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res.status(400).json({ error: await decodeError(e) });
  }
};

// ---------------------------------------------------------------- reads

app.get("/api/config", route(async () => ({
  chainId: dep.chainId,
  contracts: dep.contracts,
  users: dep.users,
  feeBps: Number(await exchange.feeBps()),
})));

async function propertySummary(p) {
  const token = tokenAt(p.token);
  const offering = offeringAt(p.offering);
  const [name, symbol, info, supply, maxSupply, nav, navAt, holders, distributed, closed, compliance, terms, state, subscribed, market, bids, asks] =
    await Promise.all([
      token.name(), token.symbol(), token.info(), token.totalSupply(), token.maxSupply(), token.navPerToken(),
      token.navUpdatedAt(), token.holderCount(), token.totalDistributed(), token.closed(), token.compliance(),
      offering.terms(), offering.state(), offering.totalSubscribed(), exchange.markets(p.token),
      exchange.getBook(p.token, true, 1), exchange.getBook(p.token, false, 1),
    ]);
  const details = detailsBySymbol[symbol] ?? {};
  const annualNet = details.monthlyRent ? details.monthlyRent * 12 * 0.72 : 0;
  return {
    token: p.token,
    offering: p.offering,
    name, symbol,
    info: { spvName: info.spvName, jurisdiction: info.jurisdiction, location: info.location, metadataURI: info.metadataURI },
    details,
    totalSupply: Number(supply),
    maxSupply: Number(maxSupply),
    navPerToken: fmt(nav),
    navUpdatedAt: Number(navAt),
    holders: Number(holders),
    totalDistributed: fmt(distributed),
    closed,
    compliance: {
      maxHolders: Number(compliance.maxHolders), maxHoldingBps: Number(compliance.maxHoldingBps),
      accreditedOnly: compliance.accreditedOnly, lockupUntil: Number(compliance.lockupUntil),
    },
    impliedYield: annualNet && nav > 0n ? annualNet / (fmt(nav) * Number(maxSupply)) : null,
    offeringState: OFFERING_STATE[Number(state)],
    offeringTerms: {
      price: fmt(terms.price), softCap: Number(terms.softCap), hardCap: Number(terms.hardCap),
      minPurchase: Number(terms.minPurchase), startTime: Number(terms.startTime), endTime: Number(terms.endTime),
    },
    totalSubscribed: Number(subscribed),
    market: {
      listed: market.listed,
      lastPrice: market.lastPrice > 0n ? fmt(market.lastPrice) : null,
      volume: fmt(market.volume),
      trades: Number(market.trades),
      bestBid: bids.length ? fmt(bids[0].price) : null,
      bestAsk: asks.length ? fmt(asks[0].price) : null,
    },
  };
}

async function allProperties() {
  const list = await factory.allProperties();
  return list.map((p) => ({ token: p.token, offering: p.offering }));
}

app.get("/api/properties", route(async () => Promise.all((await allProperties()).map(propertySummary))));

app.get("/api/properties/:token", route(async (req) => {
  const p = (await allProperties()).find((x) => x.token.toLowerCase() === req.params.token.toLowerCase());
  if (!p) throw new Error("Unknown property");
  const summary = await propertySummary(p);
  const token = tokenAt(p.token);

  const level = (orders) => {
    const map = new Map();
    for (const o of orders) {
      const price = fmt(o.price);
      const l = map.get(price) ?? { price, amount: 0, orders: 0 };
      l.amount += Number(o.remaining);
      l.orders += 1;
      map.set(price, l);
    }
    return [...map.values()];
  };
  const [bids, asks, tradeLogs, distLogs, valLogs] = await Promise.all([
    exchange.getBook(p.token, true, 200),
    exchange.getBook(p.token, false, 200),
    exchange.queryFilter(exchange.filters.Trade(p.token), 0),
    token.queryFilter(token.filters.Distributed(), 0),
    token.queryFilter(token.filters.ValuationUpdated(), 0),
  ]);
  const blockTimes = new Map();
  const ts = async (bn) => {
    if (!blockTimes.has(bn)) blockTimes.set(bn, (await provider.getBlock(bn)).timestamp);
    return blockTimes.get(bn);
  };
  const trades = await Promise.all(tradeLogs.map(async (l) => ({
    time: await ts(l.blockNumber), price: fmt(l.args.price), amount: Number(l.args.amount),
    buyer: userName(l.args.buyer), seller: userName(l.args.seller), tx: l.transactionHash,
  })));
  const distributions = await Promise.all(distLogs.map(async (l) => ({
    time: await ts(l.blockNumber), amount: fmt(l.args.amount), memo: l.args.memo,
    perToken: fmt(l.args.amount) / summary.totalSupply,
  })));
  const valuations = await Promise.all(valLogs.map(async (l) => ({
    time: await ts(l.blockNumber), navPerToken: fmt(l.args.navPerToken), reportURI: l.args.reportURI,
  })));
  return { ...summary, book: { bids: level(bids), asks: level(asks) }, trades: trades.reverse(), distributions: distributions.reverse(), valuations };
}));

app.get("/api/portfolio/:address", route(async (req) => {
  const addr = ethers.getAddress(req.params.address);
  const [cash, identity, props] = await Promise.all([usdc.balanceOf(addr), registry.identityOf(addr), allProperties()]);
  const verified = await registry.isVerified(addr);

  const holdings = await Promise.all(props.map(async (p) => {
    const token = tokenAt(p.token);
    const offering = offeringAt(p.offering);
    const [symbol, name, bal, locked, withdrawable, withdrawn, nav, sub, state, market] = await Promise.all([
      token.symbol(), token.name(), token.balanceOf(addr), token.lockedOf(addr), token.withdrawableOf(addr),
      token.withdrawnOf(addr), token.navPerToken(), offering.subscribedOf(addr), offering.state(), exchange.markets(p.token),
    ]);
    return {
      token: p.token, offering: p.offering, symbol, name,
      balance: Number(bal), locked: Number(locked),
      navPerToken: fmt(nav), lastPrice: market.lastPrice > 0n ? fmt(market.lastPrice) : null,
      value: Number(bal) * fmt(nav),
      claimableRent: fmt(withdrawable), rentReceived: fmt(withdrawn),
      pendingSubscription: Number(sub), offeringState: OFFERING_STATE[Number(state)],
    };
  }));

  const placed = await exchange.queryFilter(exchange.filters.OrderPlaced(null, null, addr), 0);
  const openOrders = [];
  for (const l of placed) {
    const o = await exchange.orders(l.args.id);
    if (o.trader === ethers.ZeroAddress) continue;
    const h = holdings.find((x) => x.token.toLowerCase() === o.token.toLowerCase());
    openOrders.push({
      id: Number(l.args.id), token: o.token, symbol: h?.symbol, side: o.isBuy ? "buy" : "sell",
      price: fmt(o.price), remaining: Number(o.remaining), original: Number(l.args.amount),
    });
  }

  return {
    address: addr,
    name: userName(addr),
    cash: fmt(cash),
    kyc: {
      verified, accredited: identity.accredited, country: Number(identity.country),
      expiresAt: Number(identity.expiresAt),
    },
    holdings: holdings.filter((h) => h.balance > 0 || h.pendingSubscription > 0 || h.claimableRent > 0 || h.rentReceived > 0),
    openOrders,
    totals: {
      propertyValue: holdings.reduce((s, h) => s + h.value, 0),
      claimableRent: holdings.reduce((s, h) => s + h.claimableRent, 0),
      rentReceived: holdings.reduce((s, h) => s + h.rentReceived, 0),
    },
  };
}));

app.get("/api/chain", route(async () => {
  const b = await provider.getBlock("latest");
  return { block: b.number, timestamp: b.timestamp };
}));

// ---------------------------------------------------------------- writes

const needUser = (req) => {
  const u = req.body.user;
  if (!u || !userByAddress[u.toLowerCase()]) throw new Error("Unknown demo user");
  return u;
};

async function ensureAllowance(user, spender, amount) {
  const current = await usdc.allowance(user, spender);
  if (current < amount) {
    await send(user, (s) => usdc.connect(s).approve(spender, ethers.MaxUint256));
  }
}

app.post("/api/orders", route(async (req) => {
  const user = needUser(req);
  const { token, side, price, amount, ioc } = req.body;
  const isBuy = side === "buy";
  const p = parse(price);
  const qty = BigInt(amount);
  if (qty <= 0n || p <= 0n) throw new Error("Price and amount must be positive");
  if (isBuy) {
    const fee = (p * qty * (await exchange.feeBps())) / 10_000n;
    await ensureAllowance(user, dep.contracts.exchange, p * qty + fee);
  }
  return send(user, (s) => exchange.connect(s).placeOrder(token, isBuy, p, qty, Boolean(ioc), 25));
}));

app.post("/api/orders/:id/cancel", route(async (req) => {
  const user = needUser(req);
  return send(user, (s) => exchange.connect(s).cancelOrder(BigInt(req.params.id)));
}));

app.post("/api/offerings/:offering/subscribe", route(async (req) => {
  const user = needUser(req);
  const offering = offeringAt(req.params.offering);
  const terms = await offering.terms();
  const qty = BigInt(req.body.amount);
  await ensureAllowance(user, req.params.offering, terms.price * qty);
  return send(user, (s) => offering.connect(s).subscribe(qty));
}));

app.post("/api/offerings/:offering/claim", route(async (req) => {
  const user = needUser(req);
  return send(user, (s) => offeringAt(req.params.offering).connect(s).claim());
}));

app.post("/api/offerings/:offering/finalize", route(async (req) => {
  const user = needUser(req);
  const offering = offeringAt(req.params.offering);
  const r = await send(user, (s) => offering.connect(s).finalize());
  // Push allocations to every subscriber, as the issuer's back office would.
  if ((await offering.state()) === 1n) {
    for (const inv of await offering.investors()) {
      if ((await offering.subscribedOf(inv)) > 0n) await send(user, (s) => offering.connect(s).claimFor(inv));
    }
  }
  return r;
}));

app.post("/api/tokens/:token/claim-rent", route(async (req) => {
  const user = needUser(req);
  return send(user, (s) => tokenAt(req.params.token).connect(s).claim());
}));

app.post("/api/tokens/:token/distribute", route(async (req) => {
  const user = needUser(req);
  const amount = parse(req.body.amount);
  await ensureAllowance(user, req.params.token, amount);
  return send(user, (s) => tokenAt(req.params.token).connect(s).distribute(amount, req.body.memo || "Net rent"));
}));

app.post("/api/tokens/:token/valuation", route(async (req) => {
  const user = needUser(req);
  return send(user, (s) => tokenAt(req.params.token).connect(s).updateValuation(parse(req.body.navPerToken), req.body.reportURI || "ipfs://appraisal"));
}));

app.post("/api/kyc", route(async (req) => {
  const admin = dep.users.find((u) => u.role === "admin").address;
  const { address, accredited } = req.body;
  const b = await provider.getBlock("latest");
  return send(admin, (s) => registry.connect(s).register(address, 840, Boolean(accredited), b.timestamp + 365 * 86400, ethers.id(`kyc:${address}:${Date.now()}`)));
}));

app.post("/api/faucet", route(async (req) => {
  const user = needUser(req);
  return send(user, (s) => usdc.connect(s).mint(user, parse(req.body.amount || 10_000)));
}));

app.post("/api/dev/advance-time", route(async (req) => {
  const seconds = Number(req.body.seconds || 86400);
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
  return { advanced: seconds };
}));

app.listen(PORT, () => {
  console.log(`HomeChain demo running at http://localhost:${PORT}  (RPC ${RPC_URL})`);
});
