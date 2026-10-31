const state = {
  config: null,
  user: null,
  view: "market",
  properties: [],
  selected: null, // token address
  detail: null,
  portfolio: null,
  side: "buy",
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n, d = 2) => n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (n) => Number(n).toLocaleString();
const pct = (n) => n == null ? "—" : (n * 100).toFixed(2) + "%";
const date = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const HERO = { MAPLE: "linear-gradient(135deg,#2f6f5e,#6aa88f)", CEDAR: "linear-gradient(135deg,#7a4e2d,#c08a5a)", HARBOR: "linear-gradient(135deg,#1e4f7a,#5b9bd5)" };

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), isErr ? 6000 : 3000);
}

async function action(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

// ------------------------------------------------------------------ data

async function refresh() {
  const [props, portfolio] = await Promise.all([api("/api/properties"), api(`/api/portfolio/${state.user}`)]);
  state.properties = props;
  state.portfolio = portfolio;
  if (state.selected) state.detail = await api(`/api/properties/${state.selected}`);
  render();
}

// ------------------------------------------------------------------ render

function render() {
  renderAccount();
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  for (const v of ["market", "portfolio", "admin"]) $(`#view-${v}`).classList.toggle("hidden", state.view !== v);
  if (state.view === "market") state.selected ? renderDetail() : renderGrid();
  if (state.view === "portfolio") renderPortfolio();
  if (state.view === "admin") renderAdmin();
}

function renderAccount() {
  const p = state.portfolio;
  $("#cash").textContent = usd(p.cash) + " USDC";
  const b = $("#kycBadge");
  b.textContent = p.kyc.verified ? (p.kyc.accredited ? "KYC ✓ Accredited" : "KYC ✓") : "Not verified";
  b.className = "badge " + (p.kyc.verified ? "ok" : "no");
}

function renderGrid() {
  $("#propertyDetail").classList.add("hidden");
  const grid = $("#propertyGrid");
  grid.classList.remove("hidden");
  grid.innerHTML = state.properties.map((p) => {
    const raising = p.offeringState === "Active";
    const progress = p.totalSubscribed / p.offeringTerms.hardCap;
    return `
      <article class="panel card" data-token="${p.token}">
        <div class="hero" style="background:${HERO[p.symbol] || "var(--accent)"}">
          ${esc(p.symbol)} <span class="status">${raising ? "Raising" : p.closed ? "Closed" : "Trading"}</span>
        </div>
        <div class="body">
          <div class="title">${esc(p.name)}</div>
          <div class="loc">${esc(p.info.location)} · ${esc(p.details.type || "")} · ${p.details.beds ?? "?"} bd / ${p.details.baths ?? "?"} ba</div>
          <div class="kv">
            <div><span>${raising ? "Offer price" : "Last price"}</span><b>${usd(raising ? p.offeringTerms.price : p.market.lastPrice ?? p.navPerToken)}</b></div>
            <div><span>NAV / token</span><b>${usd(p.navPerToken)}</b></div>
            <div><span>Est. net yield</span><b>${pct(p.impliedYield)}</b></div>
          </div>
          ${raising ? `<div class="progress"><div style="width:${(progress * 100).toFixed(1)}%"></div></div>
            <div class="muted" style="font-size:12px;margin-top:6px">${int(p.totalSubscribed)} / ${int(p.offeringTerms.hardCap)} tokens subscribed · closes ${date(p.offeringTerms.endTime)}</div>` :
            `<div class="muted" style="font-size:12px;margin-top:12px">${int(p.holders)} holders · ${usd(p.totalDistributed, 0)} distributed · bid ${usd(p.market.bestBid)} / ask ${usd(p.market.bestAsk)}</div>`}
        </div>
      </article>`;
  }).join("");
  grid.querySelectorAll(".card").forEach((c) => c.addEventListener("click", async () => {
    state.selected = c.dataset.token;
    state.detail = await api(`/api/properties/${state.selected}`);
    render();
  }));
}

function priceChart(d) {
  const pts = [...d.trades].reverse().map((t) => t.price);
  if (pts.length < 2) return `<div class="empty">Not enough trades yet to chart.</div>`;
  const navs = d.valuations.map((v) => v.navPerToken);
  const all = [...pts, ...navs];
  const min = Math.min(...all) * 0.995, max = Math.max(...all) * 1.005;
  const W = 600, H = 160, pad = 4;
  const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const nav = d.navPerToken;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trade price history">
      <line x1="0" x2="${W}" y1="${y(nav)}" y2="${y(nav)}" stroke="currentColor" stroke-dasharray="4 4" opacity="0.35"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="muted" style="font-size:11px;display:flex;justify-content:space-between"><span>${pts.length} trades</span><span>dashed = appraised NAV ${usd(nav)}</span></div>`;
}

function renderBook(d) {
  const asks = [...d.book.asks].slice(0, 8);
  const bids = d.book.bids.slice(0, 8);
  const maxQty = Math.max(1, ...asks.map((l) => l.amount), ...bids.map((l) => l.amount));
  let cum = 0;
  const askRows = asks.map((l) => ({ ...l, cum: (cum += l.amount) })).reverse();
  cum = 0;
  const bidRows = bids.map((l) => ({ ...l, cum: (cum += l.amount) }));
  const row = (l, cls) => `<div class="row ${cls}" data-price="${l.price}">
      <div class="bar" style="width:${(l.amount / maxQty) * 100}%"></div>
      <span class="p">${usd(l.price)}</span><span>${int(l.amount)}</span><span class="muted">${int(l.cum)}</span></div>`;
  const spread = d.market.bestAsk && d.market.bestBid ? `Spread ${usd(d.market.bestAsk - d.market.bestBid)} (${((d.market.bestAsk / d.market.bestBid - 1) * 100).toFixed(2)}%)` : "—";
  return `<div class="book">
      <div class="row head"><span>Price (USDC)</span><span>Tokens</span><span>Total</span></div>
      ${askRows.map((l) => row(l, "ask")).join("") || `<div class="empty" style="padding:6px 8px">No asks</div>`}
      <div class="spread">${spread}</div>
      ${bidRows.map((l) => row(l, "bid")).join("") || `<div class="empty" style="padding:6px 8px">No bids</div>`}
    </div>`;
}

function renderDetail() {
  $("#propertyGrid").classList.add("hidden");
  const el = $("#propertyDetail");
  el.classList.remove("hidden");
  const d = state.detail;
  const me = state.portfolio.holdings.find((h) => h.token === d.token);
  const raising = d.offeringState === "Active";
  const fee = state.config.feeBps / 10000;

  el.innerHTML = `
    <div class="detail-head">
      <button class="ghost small back" id="backBtn">← All properties</button>
      <div>
        <h2>${esc(d.name)} <span class="muted" style="font-weight:500;font-size:15px">${esc(d.symbol)}</span></h2>
        <div class="muted">${esc(d.info.location)} · held by ${esc(d.info.spvName)} (${esc(d.info.jurisdiction)})</div>
      </div>
    </div>
    <div class="detail-layout">
      <div class="stack">
        <div class="panel stats">
          <div class="stat"><span>Last trade</span><b>${usd(d.market.lastPrice)}</b></div>
          <div class="stat"><span>NAV / token</span><b>${usd(d.navPerToken)}</b></div>
          <div class="stat"><span>Implied property value</span><b>${usd(d.navPerToken * d.maxSupply, 0)}</b></div>
          <div class="stat"><span>Est. net yield</span><b>${pct(d.impliedYield)}</b></div>
          <div class="stat"><span>Tokens issued</span><b>${int(d.totalSupply)} / ${int(d.maxSupply)}</b></div>
          <div class="stat"><span>Holders</span><b>${int(d.holders)}</b></div>
          <div class="stat"><span>Volume</span><b>${usd(d.market.volume, 0)}</b></div>
          <div class="stat"><span>Rent distributed</span><b>${usd(d.totalDistributed, 0)}</b></div>
        </div>
        <div class="panel chart"><h3>Price history</h3>${priceChart(d)}</div>
        <div class="panel">
          <h3>Property</h3>
          <div class="facts">
            <div><span>Type</span>${esc(d.details.type)}</div>
            <div><span>Beds / baths</span>${d.details.beds} / ${d.details.baths}</div>
            <div><span>Living area</span>${int(d.details.sqft)} sq ft</div>
            <div><span>Year built</span>${d.details.yearBuilt}</div>
            <div><span>Purchase price</span>${usd(d.details.purchasePrice, 0)}</div>
            <div><span>Gross rent / mo</span>${usd(d.details.monthlyRent, 0)}</div>
            <div><span>Occupancy</span>${esc(d.details.occupancy)}</div>
            <div><span>Per-investor cap</span>${d.compliance.maxHoldingBps ? d.compliance.maxHoldingBps / 100 + "%" : "none"}</div>
            <div><span>Documents</span><span class="muted">${esc(d.info.metadataURI)}</span></div>
          </div>
        </div>
        <div class="panel">
          <h3>Distributions</h3>
          ${d.distributions.length ? `<table><thead><tr><th>Date</th><th>Memo</th><th class="r">Total</th><th class="r">Per token</th></tr></thead><tbody>
            ${d.distributions.map((x) => `<tr><td>${date(x.time)}</td><td>${esc(x.memo)}</td><td class="r">${usd(x.amount)}</td><td class="r">${usd(x.perToken, 4)}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty">No distributions yet.</div>`}
        </div>
      </div>

      <div class="stack">
        ${me ? `<div class="panel"><h3>Your position</h3><div class="facts">
          <div><span>Tokens</span>${int(me.balance)}</div>
          <div><span>Listed (locked)</span>${int(me.locked)}</div>
          <div><span>Claimable rent</span>${usd(me.claimableRent)}</div></div></div>` : ""}
        ${raising ? `
        <div class="panel">
          <h3>Primary offering</h3>
          <div class="progress"><div style="width:${(d.totalSubscribed / d.offeringTerms.hardCap * 100).toFixed(1)}%"></div></div>
          <div class="muted" style="font-size:12px;margin:6px 0 4px">${int(d.totalSubscribed)} of ${int(d.offeringTerms.hardCap)} tokens · soft cap ${int(d.offeringTerms.softCap)} · closes ${date(d.offeringTerms.endTime)}</div>
          <label for="subQty">Tokens (min ${d.offeringTerms.minPurchase}) at ${usd(d.offeringTerms.price)}</label>
          <input id="subQty" type="number" min="${d.offeringTerms.minPurchase}" step="1" value="10" />
          <div class="summary"><div><span>Cost</span><b id="subCost"></b></div></div>
          <button class="primary" id="subBtn" style="width:100%">Subscribe</button>
          <div class="notice">Funds are held in escrow by the offering contract. If the soft cap is not reached by the close date, every subscriber is refunded in full.</div>
        </div>` : `
        <div class="panel">
          <h3>Order book</h3>
          ${renderBook(d)}
        </div>
        <div class="panel">
          <h3>Place order</h3>
          <div class="side-toggle">
            <button class="b ${state.side === "buy" ? "on" : ""}" data-side="buy">Buy</button>
            <button class="s ${state.side === "sell" ? "on" : ""}" data-side="sell">Sell</button>
          </div>
          <label for="px">Limit price (USDC per token)</label>
          <input id="px" type="number" step="0.01" min="0.01" value="${(state.side === "buy" ? d.market.bestAsk : d.market.bestBid) ?? d.navPerToken}" />
          <label for="qty">Tokens</label>
          <input id="qty" type="number" step="1" min="1" value="10" />
          <label class="check"><input type="checkbox" id="ioc" /> Immediate-or-cancel (don't rest on the book)</label>
          <div class="summary">
            <div><span>Notional</span><span id="notional" class="num"></span></div>
            <div><span>Fee (${(fee * 100).toFixed(2)}%)</span><span id="feeAmt" class="num"></span></div>
            <div><b>${state.side === "buy" ? "Max cost" : "Min proceeds"}</b><b id="total" class="num"></b></div>
            ${state.side === "sell" && me ? `<div class="muted"><span>Available to sell</span><span>${int(me.balance - me.locked)}</span></div>` : ""}
          </div>
          <button class="${state.side}" id="orderBtn" style="width:100%">${state.side === "buy" ? "Buy" : "Sell"} ${esc(d.symbol)}</button>
          <div class="notice">Trades settle atomically on-chain: tokens and USDC swap in the same transaction. Each fill is re-checked against KYC, jurisdiction and holding caps.</div>
        </div>
        <div class="panel">
          <h3>Recent trades</h3>
          ${d.trades.length ? `<table><thead><tr><th>Time</th><th class="r">Price</th><th class="r">Qty</th><th>Buyer ← Seller</th></tr></thead><tbody>
            ${d.trades.slice(0, 12).map((t) => `<tr><td>${date(t.time)}</td><td class="r">${usd(t.price)}</td><td class="r">${int(t.amount)}</td><td class="muted">${esc(t.buyer)} ← ${esc(t.seller)}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty">No trades yet.</div>`}
        </div>`}
      </div>
    </div>`;

  $("#backBtn").onclick = () => { state.selected = null; state.detail = null; render(); };

  if (raising) {
    const upd = () => { $("#subCost").textContent = usd(Number($("#subQty").value || 0) * d.offeringTerms.price); };
    $("#subQty").oninput = upd; upd();
    $("#subBtn").onclick = () => action(() => api(`/api/offerings/${d.offering}/subscribe`, { user: state.user, amount: Number($("#subQty").value) }), "Subscription received");
    return;
  }

  el.querySelectorAll(".side-toggle button").forEach((b) => b.onclick = () => { state.side = b.dataset.side; renderDetail(); });
  el.querySelectorAll(".book .row[data-price]").forEach((r) => r.onclick = () => { $("#px").value = r.dataset.price; upd(); });
  const upd = () => {
    const n = Number($("#px").value || 0) * Number($("#qty").value || 0);
    const f = n * fee;
    $("#notional").textContent = usd(n);
    $("#feeAmt").textContent = usd(f);
    $("#total").textContent = usd(state.side === "buy" ? n + f : n - f);
  };
  $("#px").oninput = upd; $("#qty").oninput = upd; upd();
  $("#orderBtn").onclick = () => action(() => api("/api/orders", {
    user: state.user, token: d.token, side: state.side, price: $("#px").value, amount: Number($("#qty").value), ioc: $("#ioc").checked,
  }), "Order submitted");
}

function renderPortfolio() {
  const p = state.portfolio;
  const el = $("#view-portfolio");
  el.innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="muted" style="margin-bottom:16px">${esc(p.address)}</div>
    <div class="panel stats" style="margin-bottom:16px">
      <div class="stat"><span>Cash (USDC)</span><b>${usd(p.cash)}</b></div>
      <div class="stat"><span>Property value (NAV)</span><b>${usd(p.totals.propertyValue)}</b></div>
      <div class="stat"><span>Claimable rent</span><b>${usd(p.totals.claimableRent)}</b></div>
      <div class="stat"><span>Rent received</span><b>${usd(p.totals.rentReceived)}</b></div>
    </div>
    <div class="stack">
      <div class="panel">
        <h3>Holdings</h3>
        ${p.holdings.length ? `<table><thead><tr><th>Property</th><th class="r">Tokens</th><th class="r">Listed</th><th class="r">NAV</th><th class="r">Last</th><th class="r">Value</th><th class="r">Claimable rent</th><th></th></tr></thead><tbody>
          ${p.holdings.map((h) => `<tr>
            <td><b>${esc(h.symbol)}</b> <span class="muted">${esc(h.name)}</span>${h.pendingSubscription ? `<br><span class="muted" style="font-size:12px">${int(h.pendingSubscription)} subscribed · offering ${h.offeringState.toLowerCase()}</span>` : ""}</td>
            <td class="r">${int(h.balance)}</td><td class="r">${int(h.locked)}</td><td class="r">${usd(h.navPerToken)}</td>
            <td class="r">${usd(h.lastPrice)}</td><td class="r">${usd(h.value)}</td><td class="r">${usd(h.claimableRent)}</td>
            <td class="r">
              ${h.claimableRent > 0 ? `<button class="primary small" data-claim="${h.token}">Claim rent</button>` : ""}
              ${h.pendingSubscription && h.offeringState !== "Active" ? `<button class="ghost small" data-claim-off="${h.offering}">${h.offeringState === "Failed" ? "Refund" : "Claim tokens"}</button>` : ""}
            </td></tr>`).join("")}
        </tbody></table>` : `<div class="empty">No holdings yet. Browse the marketplace to invest.</div>`}
      </div>
      <div class="panel">
        <h3>Open orders</h3>
        ${p.openOrders.length ? `<table><thead><tr><th>#</th><th>Property</th><th>Side</th><th class="r">Price</th><th class="r">Filled</th><th class="r">Remaining</th><th></th></tr></thead><tbody>
          ${p.openOrders.map((o) => `<tr><td>${o.id}</td><td>${esc(o.symbol)}</td>
            <td style="color:var(--${o.side === "buy" ? "buy" : "sell"});font-weight:600">${o.side.toUpperCase()}</td>
            <td class="r">${usd(o.price)}</td><td class="r">${int(o.original - o.remaining)}</td><td class="r">${int(o.remaining)}</td>
            <td class="r"><button class="ghost small" data-cancel="${o.id}">Cancel</button></td></tr>`).join("")}
        </tbody></table>` : `<div class="empty">No open orders.</div>`}
      </div>
      <div class="panel">
        <h3>Trade history</h3>
        ${p.trades.length ? `<table><thead><tr><th>Date</th><th>Property</th><th>Side</th><th class="r">Price</th><th class="r">Qty</th><th class="r">Fee</th><th>Counterparty</th></tr></thead><tbody>
          ${p.trades.map((t) => `<tr><td>${date(t.time)}</td><td>${esc(t.symbol)}</td>
            <td style="color:var(--${t.side});font-weight:600">${t.side.toUpperCase()}</td>
            <td class="r">${usd(t.price)}</td><td class="r">${int(t.amount)}</td><td class="r">${usd(t.fee)}</td>
            <td class="muted">${esc(t.counterparty)}</td></tr>`).join("")}
        </tbody></table>` : `<div class="empty">No trades yet.</div>`}
      </div>
    </div>`;
  el.querySelectorAll("[data-claim]").forEach((b) => b.onclick = () => action(() => api(`/api/tokens/${b.dataset.claim}/claim-rent`, { user: state.user }), "Rent claimed"));
  el.querySelectorAll("[data-claim-off]").forEach((b) => b.onclick = () => action(() => api(`/api/offerings/${b.dataset.claimOff}/claim`, { user: state.user }), "Done"));
  el.querySelectorAll("[data-cancel]").forEach((b) => b.onclick = () => action(() => api(`/api/orders/${b.dataset.cancel}/cancel`, { user: state.user }), "Order cancelled"));
}

function renderAdmin() {
  const el = $("#view-admin");
  const role = state.config.users.find((u) => u.address === state.user)?.role;
  const opts = state.properties.map((p) => `<option value="${p.token}" data-offering="${p.offering}">${esc(p.symbol)} — ${esc(p.name)}</option>`).join("");
  const users = state.config.users.map((u) => `<option value="${u.address}">${esc(u.name)}</option>`).join("");
  el.innerHTML = `
    <h2>Operations</h2>
    <div class="muted" style="margin-bottom:16px">Issuer and platform actions. Contracts enforce roles: switch to <b>Issuer</b> to distribute rent, <b>Platform Admin</b> to update valuations. You are acting as <b>${esc(role)}</b>.</div>
    <div class="admin-grid">
      <div class="panel">
        <h3>Distribute rent (issuer)</h3>
        <label>Property</label><select id="distProp">${opts}</select>
        <label>Net amount (USDC)</label><input id="distAmt" type="number" value="2500" />
        <label>Memo</label><input id="distMemo" type="text" value="Net rent Nov 2026" />
        <button class="primary" id="distBtn">Distribute</button>
      </div>
      <div class="panel">
        <h3>Update valuation (appraiser)</h3>
        <label>Property</label><select id="navProp">${opts}</select>
        <label>NAV per token (USDC)</label><input id="navAmt" type="number" step="0.01" value="104" />
        <label>Appraisal report URI</label><input id="navUri" type="text" value="ipfs://appraisal-2026q4" />
        <button class="primary" id="navBtn">Publish valuation</button>
      </div>
      <div class="panel">
        <h3>Close primary offering</h3>
        <label>Property</label><select id="finProp">${opts}</select>
        <div class="notice">Finalizing is allowed once the hard cap is hit or the window has ended. Use "advance time" to simulate the close date on the local chain.</div>
        <button class="ghost" id="warpBtn" style="width:100%;margin-top:12px">Advance chain time 31 days</button>
        <button class="primary" id="finBtn">Finalize &amp; deliver tokens</button>
      </div>
      <div class="panel">
        <h3>KYC onboarding (KYC agent)</h3>
        <label>Investor</label><select id="kycUser">${users}</select>
        <label class="check"><input type="checkbox" id="kycAcc" /> Accredited investor</label>
        <div class="notice">In production this is triggered by the KYC provider's webhook after document + liveness checks; only a hash of the case ID goes on-chain.</div>
        <button class="primary" id="kycBtn">Register identity</button>
      </div>
    </div>
    <div class="stack" style="margin-top:16px">
      <div class="panel" id="dbPanel"><h3>Database</h3><div class="empty">Loading…</div></div>
      <div class="panel" id="activityPanel"><h3>Activity log</h3><div class="empty">Loading…</div></div>
    </div>`;
  loadAdminData();
  $("#distBtn").onclick = () => action(() => api(`/api/tokens/${$("#distProp").value}/distribute`, { user: state.user, amount: $("#distAmt").value, memo: $("#distMemo").value }), "Distribution sent");
  $("#navBtn").onclick = () => action(() => api(`/api/tokens/${$("#navProp").value}/valuation`, { user: state.user, navPerToken: $("#navAmt").value, reportURI: $("#navUri").value }), "Valuation updated");
  $("#warpBtn").onclick = () => action(() => api("/api/dev/advance-time", { seconds: 31 * 86400 }), "Advanced 31 days");
  $("#finBtn").onclick = () => action(() => api(`/api/offerings/${$("#finProp").selectedOptions[0].dataset.offering}/finalize`, { user: state.user }), "Offering finalized");
  $("#kycBtn").onclick = () => action(() => api("/api/kyc", { address: $("#kycUser").value, accredited: $("#kycAcc").checked }), "Identity registered");
}

async function loadAdminData() {
  const [status, activity] = await Promise.all([api("/api/status"), api("/api/activity?limit=25")]);
  if (state.view !== "admin") return;
  const lag = status.chainBlock - status.indexedBlock;
  $("#dbPanel").innerHTML = `<h3>Database</h3>
    <div class="facts">
      <div><span>Backend</span>${esc(status.database)}</div>
      <div><span>Indexed block</span>${int(status.indexedBlock)} of ${int(status.chainBlock)}${lag > 0 ? ` <span class="muted">(${lag} behind)</span>` : " ✓"}</div>
      ${Object.entries(status.counts).map(([t, n]) => `<div><span>${esc(t)}</span>${int(n)} rows</div>`).join("")}
    </div>`;
  $("#activityPanel").innerHTML = `<h3>Activity log</h3>
    ${activity.length ? `<table><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Details</th><th>Result</th></tr></thead><tbody>
      ${activity.map((a) => `<tr><td>${new Date(a.at).toLocaleString()}</td><td>${esc(a.actor ?? "—")}</td><td>${esc(a.action)}</td>
        <td class="muted">${esc(Object.entries(a.params).map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("0x") ? v.slice(0, 8) + "…" : v}`).join(" "))}</td>
        <td style="color:var(--${a.status === "ok" ? "buy" : "sell"})">${a.status === "ok" ? "ok" : esc(a.error)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">No activity yet. Actions taken through this app are recorded here.</div>`}`;
}

// ------------------------------------------------------------------ boot

async function boot() {
  state.config = await api("/api/config");
  const sel = $("#userSelect");
  sel.innerHTML = state.config.users.map((u) => `<option value="${u.address}">${esc(u.name)}</option>`).join("");
  state.user = state.config.users.find((u) => u.name === "Alice")?.address ?? state.config.users[0].address;
  sel.value = state.user;
  sel.onchange = () => { state.user = sel.value; refresh(); };
  document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { state.view = b.dataset.view; render(); });
  $("#faucetBtn").onclick = () => action(() => api("/api/faucet", { user: state.user, amount: 10000 }), "Minted 10,000 test USDC");
  await refresh();
}

boot().catch((e) => toast(e.message, true));
