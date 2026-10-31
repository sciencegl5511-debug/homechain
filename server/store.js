// Off-chain records: investors (KYC) and property details.
const { ethers } = require("ethers");

const num = (v) => (v == null ? null : Number(v));

function propertyDetails(row) {
  if (!row) return {};
  return {
    type: row.property_type,
    beds: num(row.beds),
    baths: num(row.baths),
    sqft: num(row.sqft),
    yearBuilt: num(row.year_built),
    purchasePrice: num(row.purchase_price),
    monthlyRent: num(row.monthly_rent),
    occupancy: row.occupancy,
    description: row.description,
  };
}

/// First run: copy the deployment's demo users and property details into the database.
/// Existing rows are kept, so edits made in the database survive restarts and redeploys.
async function seed(db, dep, { registry, tokenAt }) {
  for (const u of dep.users) {
    const exists = await db("investors").where({ address: u.address }).first();
    if (exists) continue;
    const id = await registry.identityOf(u.address);
    const verified = await registry.isVerified(u.address);
    await db("investors").insert({
      address: u.address,
      name: u.name,
      role: u.role,
      kyc_status: verified ? "verified" : "pending",
      accredited: verified && id.accredited,
      country: verified ? Number(id.country) : null,
      kyc_ref: verified ? id.kycRef : null,
      kyc_expires_at: verified ? Number(id.expiresAt) : null,
    });
  }

  for (const p of dep.properties) {
    const info = await tokenAt(p.token).info();
    const d = p.details || {};
    const row = {
      token: p.token,
      offering: p.offering,
      symbol: p.symbol,
      name: await tokenAt(p.token).name(),
      location: info.location,
      spv_name: info.spvName,
      jurisdiction: info.jurisdiction,
    };
    const existing = await db("properties").where({ symbol: p.symbol }).first();
    if (existing) {
      // A redeploy may move the contracts; keep the curated details, update the addresses.
      if (existing.token !== p.token) await db("properties").where({ symbol: p.symbol }).update({ token: p.token, offering: p.offering });
      continue;
    }
    await db("properties").insert({
      ...row,
      property_type: d.type,
      beds: d.beds,
      baths: d.baths,
      sqft: d.sqft,
      year_built: d.yearBuilt,
      purchase_price: d.purchasePrice,
      monthly_rent: d.monthlyRent,
      occupancy: d.occupancy,
    });
  }
}

/// The database is the system of record for KYC; the on-chain registry is derived from it.
/// After a local chain restart this re-registers everyone the database says is verified.
async function reconcileKyc(db, registry, register) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db("investors").where({ kyc_status: "verified" });
  let fixed = 0;
  for (const r of rows) {
    if (await registry.isVerified(r.address)) continue;
    const latest = await registry.runner.provider.getBlock("latest");
    const expires = Math.max(num(r.kyc_expires_at) ?? 0, latest.timestamp + 86400, now);
    await register(r.address, num(r.country) ?? 840, Boolean(r.accredited), expires, r.kyc_ref || ethers.ZeroHash);
    fixed++;
  }
  return fixed;
}

module.exports = { seed, reconcileKyc, propertyDetails };
