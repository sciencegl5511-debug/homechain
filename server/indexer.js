// Copies on-chain events (orders, trades, distributions, valuations) into the database.
// The chain stays the source of truth; these tables are a read model that can be rebuilt
// from scratch at any time by clearing them and resetting the cursor.
const path = require("path");
const { ethers } = require("ethers");

const artifact = (file, name = file) =>
  require(path.join(__dirname, "..", "artifacts", "contracts", `${file}.sol`, `${name}.json`)).abi;

const exchangeIface = new ethers.Interface(artifact("PropertyExchange"));
const tokenIface = new ethers.Interface(artifact("PropertyToken"));
const factoryAbi = artifact("PropertyFactory");

const INDEXED_TABLES = ["trades", "orders", "distributions", "valuations"];
const CANCEL_REASONS = ["user", "ioc", "self_trade", "ineligible", "operator"];
const BATCH = 2000;
const D = 6;
const fmt = (v) => Number(ethers.formatUnits(v, D));

class Indexer {
  constructor({ db, provider, exchange, factory, log = console.log }) {
    this.db = db;
    this.provider = provider;
    this.exchange = ethers.getAddress(exchange);
    this.factory = new ethers.Contract(factory, factoryAbi, provider);
    this.log = log;
    this.lock = Promise.resolve();
    this.blockTimes = new Map();
  }

  async getState(key) {
    const row = await this.db("sync_state").where({ key }).first();
    return row ? row.value : null;
  }

  async setState(key, value, trx = this.db) {
    await trx("sync_state").insert({ key, value: String(value) }).onConflict("key").merge();
  }

  get lastBlock() {
    return this.getState("last_block").then((v) => (v == null ? -1 : Number(v)));
  }

  /// A restarted local node (or a different deployment) invalidates everything indexed so far.
  async checkChain() {
    const [net, genesis] = await Promise.all([this.provider.getNetwork(), this.provider.getBlock(0)]);
    const fingerprint = `${net.chainId}:${genesis.hash}:${await this.factory.getAddress()}`;
    const stored = await this.getState("chain_fingerprint");
    const latest = await this.provider.getBlockNumber();
    if (stored !== fingerprint || (await this.lastBlock) > latest) {
      if (stored) this.log("Indexer: chain changed or was reset, rebuilding indexed tables");
      await this.db.transaction(async (trx) => {
        for (const t of INDEXED_TABLES) await trx(t).del();
        await this.setState("chain_fingerprint", fingerprint, trx);
        await this.setState("last_block", -1, trx);
      });
    }
  }

  /// Index everything up to the latest block (or at least `minBlock`). Calls are serialised.
  sync(minBlock = 0) {
    const run = () => this._sync(minBlock);
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  async _sync(minBlock) {
    const latest = Math.max(await this.provider.getBlockNumber(), minBlock);
    let from = (await this.lastBlock) + 1;
    if (from > latest) return 0;
    const tokens = (await this.factory.allProperties()).map((p) => p.token);
    const addresses = [this.exchange, ...tokens];
    let count = 0;
    while (from <= latest) {
      const to = Math.min(from + BATCH - 1, latest);
      const logs = await this.provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
      await this.db.transaction(async (trx) => {
        for (const log of logs) count += await this.apply(trx, log);
        await this.setState("last_block", to, trx);
      });
      from = to + 1;
    }
    return count;
  }

  async blockTime(n) {
    if (!this.blockTimes.has(n)) this.blockTimes.set(n, (await this.provider.getBlock(n)).timestamp);
    return this.blockTimes.get(n);
  }

  async apply(trx, log) {
    const isExchange = ethers.getAddress(log.address) === this.exchange;
    let ev;
    try {
      ev = (isExchange ? exchangeIface : tokenIface).parseLog(log);
    } catch {
      return 0;
    }
    if (!ev) return 0;
    const time = await this.blockTime(log.blockNumber);
    const meta = { block_number: log.blockNumber, tx_hash: log.transactionHash, log_index: log.index, block_time: time };
    const a = ev.args;

    if (isExchange && ev.name === "OrderPlaced") {
      await trx("orders").insert({
        id: Number(a.id), token: a.token, trader: a.trader, side: a.isBuy ? "buy" : "sell",
        price: fmt(a.price), amount: Number(a.amount), remaining: Number(a.amount), status: "open",
        placed_block: log.blockNumber, placed_tx: log.transactionHash, placed_at: time, updated_at: time,
      }).onConflict("id").ignore();
    } else if (isExchange && ev.name === "Trade") {
      await trx("trades").insert({
        token: a.token, maker_order_id: Number(a.makerOrderId), taker_order_id: Number(a.takerOrderId),
        buyer: a.buyer, seller: a.seller, price: fmt(a.price), amount: Number(a.amount),
        buyer_fee: fmt(a.buyerFee), seller_fee: fmt(a.sellerFee), ...meta,
      });
      for (const id of [a.makerOrderId, a.takerOrderId]) {
        await trx("orders").where({ id: Number(id) })
          .update({ remaining: trx.raw("remaining - ?", [Number(a.amount)]), updated_at: time });
        await trx("orders").where({ id: Number(id) }).where("remaining", "<=", 0).update({ status: "filled" });
      }
    } else if (isExchange && ev.name === "OrderCancelled") {
      await trx("orders").where({ id: Number(a.id) }).update({
        status: "cancelled", cancel_reason: CANCEL_REASONS[Number(a.reason)] ?? String(a.reason),
        remaining: Number(a.remaining), updated_at: time,
      });
    } else if (!isExchange && ev.name === "Distributed") {
      const token = new ethers.Contract(log.address, tokenIface, this.provider);
      const supply = await token.totalSupply({ blockTag: log.blockNumber });
      await trx("distributions").insert({
        token: ethers.getAddress(log.address), amount: fmt(a.amount), memo: a.memo,
        per_token: supply > 0n ? fmt(a.amount) / Number(supply) : 0, ...meta,
      });
    } else if (!isExchange && ev.name === "ValuationUpdated") {
      await trx("valuations").insert({
        token: ethers.getAddress(log.address), nav_per_token: fmt(a.navPerToken), report_uri: a.reportURI, ...meta,
      });
    } else {
      return 0;
    }
    return 1;
  }

  start(intervalMs = 2000) {
    const tick = () => this.sync().catch((e) => this.log(`Indexer error: ${e.shortMessage || e.message}`));
    this.timer = setInterval(tick, intervalMs);
    return tick();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Indexer };
