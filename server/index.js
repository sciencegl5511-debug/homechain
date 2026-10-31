// Demo API + static web app for the HomeChain platform.
// It signs transactions with the Hardhat node's unlocked accounts so the UI can switch between
// demo users without a wallet. In production the browser signs with the user's own wallet
// (or an MPC custody provider) and this service is a read-only indexer + KYC/off-chain workflow API.
//
// Storage: balances and the live order book are read from the chain. Investor/KYC records,
// property details, the activity log and an index of chain events (orders, trades,
// distributions, valuations) live in the database (SQLite by default, MySQL via DATABASE_URL).
const path = require("path");
const fs = require("fs");
const express = require("express");
const { ethers } = require("ethers");
const { createDb, migrate, describe } = require("./db");
const { Indexer } = require("./indexer");
const { seed, reconcileKyc, propertyDetails } = require("./store");

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
const errorIface = new ethers.Interface(
  [...ABI.token, ...ABI.offering, ...ABI.exchange, ...ABI.usdc].filter((f) => f.type === "error"),
);

if (!fs.existsSync(DEPLOYMENT)) {
  console.error(`No deployment at ${DEPLOYMENT}. Run: npm run deploy`);
  process.exit(1);
}
const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const db = createDb();
const indexer = new Indexer({ db, provider, exchange: dep.contracts.exchange, factory: dep.contracts.factory });

const usdc = new ethers.Contract(dep.contracts.usdc, ABI.usdc, provider);
const registry = new ethers.Contract(dep.contracts.identityRegistry, ABI.registry, provider);
const exchange = new ethers.Contract(dep.contracts.exchange, ABI.exchange, provider);
const factory = new ethers.Contract(dep.contracts.factory, ABI.factory, provider);
const tokenAt = (a) => new ethers.Contract(a, ABI.token, provider);
const offeringAt = (a) => new ethers.Contract(a, ABI.offering, provider);

const D = 6; // stablecoin decimals
const fmt = (v) => Number(ethers.formatUnits(v, D));
const parse = (v) => ethers.parseUnits(String(v), D);
const OFFERING_STATE = ["Active", "Succeeded", "Failed"];
const adminAddress = dep.users.find((u) => u.role === "admin").address;

// Display names come from the investors table; cached because every trade row needs them.
let names = new Map();
async function loadNames() {
  names = new Map((await db("investors").select("address", "name")).map((r) => [r.address.toLowerCase(), r.name]));
}
function userName(address) {
  return names.get(address.toLowerCase()) ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Serialise writes so nonces from the shared JSON-RPC signers never collide, and wait for the
// indexer to catch up so the next read already includes this transaction's events.
let queue = Promise.resolve();
function send(userAddress, build) {
  const run = async () => {
    const signer = await provider.getSigner(userAddress);
    const tx = await build(signer);
    const rc = await tx.wait();
    await indexer.sync(rc.blockNumber);
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

/// Like `route`, but records every attempt (successful or not) in the activity log.
const writeRoute = (action, fn, actorOf = (req) => req.body?.user ?? null) => async (req, res) => {
  const params = { ...req.params, ...req.body };
  delete params.user;
  const entry = { actor: actorOf(req), action, params: JSON.stringify(params) };
  try {
    const result = await fn(req);
    await db("activity_log").insert({ ...entry, status: "ok", tx_hash: result?.hash ?? null });
    res.json(result);
  } catch (e) {
    const error = await decodeError(e);
    await db("activity_log").insert({ ...entry, status: "error", error }).catch(() => {});
    res.status(400).json({ error });
  }
};

// ---------------------------------------------------------------- reads

app.get("/api/config", route(async () => ({
  chainId: dep.chainId,
  contracts: dep.contracts,
  users: dep.users.map((u) => ({ ...u, name: userName(u.address) })),
  feeBps: Number(await exchange.feeBps()),
})));

app.get("/api/status", route(async () => ({
  database: describe(db),
  indexedBlock: await indexer.lastBlock,
  chainBlock: await provider.getBlockNumber(),
  counts: Object.fromEntries(await Promise.all(
    ["investors", "properties", "orders", "trades", "distributions", "valuations", "activity_log"]
      .map(async (t) => [t, Number((await db(t).count({ n: "*" }))[0].n)]),
  )),
})));

async function propertySummary(p) {
  const token = tokenAt(p.token);
  const offering = offeringAt(p.offering);
  const [name, symbol, info, supply, maxSupply, nav, navAt, holders, distributed, closed, compliance, terms, state, subscribed, market, bids, asks, row] =
    await Promise.all([
      token.name(), token.symbol(), token.info(), token.totalSupply(), token.maxSupply(), token.navPerToken(),
      token.navUpdatedAt(), token.holderCount(), token.totalDistributed(), token.closed(), token.compliance(),
      offering.terms(), offering.state(), offering.totalSubscribed(), exchange.markets(p.token),
      exchange.getBook(p.token, true, 1), exchange.getBook(p.token, false, 1),
      db("properties").where({ token: p.token }).first(),
    ]);
  const details = propertyDetails(row);
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
  const [bids, asks, trades, distributions, valuations] = await Promise.all([
    exchange.getBook(p.token, true, 200),
    exchange.getBook(p.token, false, 200),
    db("trades").where({ token: p.token }).orderBy([{ column: "block_number", order: "desc" }, { column: "log_index", order: "desc" }]).limit(200),
    db("distributions").where({ token: p.token }).orderBy([{ column: "block_number", order: "desc" }, { column: "log_index", order: "desc" }]),
    db("valuations").where({ token: p.token }).orderBy(["block_number", "log_index"]),
  ]);
  return {
    ...summary,
    book: { bids: level(bids), asks: level(asks) },
    trades: trades.map((t) => ({
      time: Number(t.block_time), price: Number(t.price), amount: Number(t.amount),
      buyer: userName(t.buyer), seller: userName(t.seller), tx: t.tx_hash,
    })),
    distributions: distributions.map((x) => ({
      time: Number(x.block_time), amount: Number(x.amount), memo: x.memo, perToken: Number(x.per_token),
    })),
    valuations: valuations.map((v) => ({
      time: Number(v.block_time), navPerToken: Number(v.nav_per_token), reportURI: v.report_uri,
    })),
  };
}));

app.get("/api/portfolio/:address", route(async (req) => {
  const addr = ethers.getAddress(req.params.address);
  const [cash, identity, props, profile] = await Promise.all([
    usdc.balanceOf(addr), registry.identityOf(addr), allProperties(), db("investors").where({ address: addr }).first(),
  ]);
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
  const symbolOf = new Map(holdings.map((h) => [h.token.toLowerCase(), h.symbol]));

  const [openOrders, trades] = await Promise.all([
    db("orders").where({ trader: addr, status: "open" }).orderBy("id"),
    db("trades").where({ buyer: addr }).orWhere({ seller: addr })
      .orderBy([{ column: "block_number", order: "desc" }, { column: "log_index", order: "desc" }]).limit(50),
  ]);

  return {
    address: addr,
    name: userName(addr),
    email: profile?.email ?? null,
    cash: fmt(cash),
    kyc: {
      verified, accredited: identity.accredited, country: Number(identity.country),
      expiresAt: Number(identity.expiresAt), status: profile?.kyc_status ?? "pending",
    },
    holdings: holdings.filter((h) => h.balance > 0 || h.pendingSubscription > 0 || h.claimableRent > 0 || h.rentReceived > 0),
    openOrders: openOrders.map((o) => ({
      id: Number(o.id), token: o.token, symbol: symbolOf.get(o.token.toLowerCase()), side: o.side,
      price: Number(o.price), remaining: Number(o.remaining), original: Number(o.amount),
    })),
    trades: trades.map((t) => {
      const side = t.buyer === addr ? "buy" : "sell";
      const fee = Number(side === "buy" ? t.buyer_fee : t.seller_fee);
      return {
        time: Number(t.block_time), symbol: symbolOf.get(t.token.toLowerCase()), side,
        price: Number(t.price), amount: Number(t.amount), fee,
        counterparty: userName(side === "buy" ? t.seller : t.buyer), tx: t.tx_hash,
      };
    }),
    totals: {
      propertyValue: holdings.reduce((s, h) => s + h.value, 0),
      claimableRent: holdings.reduce((s, h) => s + h.claimableRent, 0),
      rentReceived: holdings.reduce((s, h) => s + h.rentReceived, 0),
    },
  };
}));

// MySQL returns Date objects; SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC.
const toIso = (v) => (v instanceof Date ? v : new Date(String(v).replace(" ", "T") + "Z")).toISOString();

app.get("/api/activity", route(async (req) => {
  const q = db("activity_log").orderBy("id", "desc").limit(Math.min(Number(req.query.limit) || 50, 500));
  if (req.query.actor) q.where({ actor: req.query.actor });
  return (await q).map((r) => ({
    id: r.id, actor: r.actor ? userName(r.actor) : null, action: r.action, params: JSON.parse(r.params || "{}"),
    status: r.status, tx: r.tx_hash, error: r.error, at: toIso(r.created_at),
  }));
}));

app.get("/api/chain", route(async () => {
  const b = await provider.getBlock("latest");
  return { block: b.number, timestamp: b.timestamp };
}));

// ---------------------------------------------------------------- writes

const needUser = (req) => {
  const u = req.body.user;
  if (!u || !names.has(u.toLowerCase())) throw new Error("Unknown demo user");
  return u;
};

async function ensureAllowance(user, spender, amount) {
  const current = await usdc.allowance(user, spender);
  if (current < amount) {
    await send(user, (s) => usdc.connect(s).approve(spender, ethers.MaxUint256));
  }
}

app.post("/api/orders", writeRoute("place_order", async (req) => {
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

app.post("/api/orders/:id/cancel", writeRoute("cancel_order", async (req) => {
  const user = needUser(req);
  return send(user, (s) => exchange.connect(s).cancelOrder(BigInt(req.params.id)));
}));

app.post("/api/offerings/:offering/subscribe", writeRoute("subscribe", async (req) => {
  const user = needUser(req);
  const offering = offeringAt(req.params.offering);
  const terms = await offering.terms();
  const qty = BigInt(req.body.amount);
  await ensureAllowance(user, req.params.offering, terms.price * qty);
  return send(user, (s) => offering.connect(s).subscribe(qty));
}));

app.post("/api/offerings/:offering/claim", writeRoute("claim_offering", async (req) => {
  const user = needUser(req);
  return send(user, (s) => offeringAt(req.params.offering).connect(s).claim());
}));

app.post("/api/offerings/:offering/finalize", writeRoute("finalize_offering", async (req) => {
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

app.post("/api/tokens/:token/claim-rent", writeRoute("claim_rent", async (req) => {
  const user = needUser(req);
  return send(user, (s) => tokenAt(req.params.token).connect(s).claim());
}));

app.post("/api/tokens/:token/distribute", writeRoute("distribute", async (req) => {
  const user = needUser(req);
  const amount = parse(req.body.amount);
  await ensureAllowance(user, req.params.token, amount);
  return send(user, (s) => tokenAt(req.params.token).connect(s).distribute(amount, req.body.memo || "Net rent"));
}));

app.post("/api/tokens/:token/valuation", writeRoute("update_valuation", async (req) => {
  const user = needUser(req);
  return send(user, (s) => tokenAt(req.params.token).connect(s).updateValuation(parse(req.body.navPerToken), req.body.reportURI || "ipfs://appraisal"));
}));

function registerOnChain(address, country, accredited, expiresAt, kycRef) {
  return send(adminAddress, (s) => registry.connect(s).register(address, country, accredited, expiresAt, kycRef));
}

app.post("/api/kyc", writeRoute("register_kyc", async (req) => {
  const address = ethers.getAddress(req.body.address);
  const accredited = Boolean(req.body.accredited);
  const b = await provider.getBlock("latest");
  const expiresAt = b.timestamp + 365 * 86400;
  const kycRef = ethers.id(`kyc:${address}:${Date.now()}`);
  // Record the decision off-chain first: the database is the system of record for KYC.
  await db("investors").where({ address }).update({
    kyc_status: "verified", accredited, country: 840, kyc_ref: kycRef, kyc_expires_at: expiresAt, updated_at: db.fn.now(),
  });
  return registerOnChain(address, 840, accredited, expiresAt, kycRef);
}, () => adminAddress));

app.post("/api/faucet", writeRoute("faucet", async (req) => {
  const user = needUser(req);
  return send(user, (s) => usdc.connect(s).mint(user, parse(req.body.amount || 10_000)));
}));

app.post("/api/dev/advance-time", writeRoute("advance_time", async (req) => {
  const seconds = Number(req.body.seconds || 86400);
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
  return { advanced: seconds };
}));

async function main() {
  await migrate(db);
  await seed(db, dep, { registry, tokenAt });
  await loadNames();
  await indexer.checkChain();
  const fixed = await reconcileKyc(db, registry, registerOnChain);
  if (fixed) console.log(`Re-registered ${fixed} verified investor(s) on-chain from the database`);
  await indexer.start();
  app.listen(PORT, () => {
    console.log(`HomeChain demo running at http://localhost:${PORT}  (RPC ${RPC_URL}, ${describe(db)})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
