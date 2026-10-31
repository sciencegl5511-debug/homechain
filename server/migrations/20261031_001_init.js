// Initial schema. Works on both SQLite and MySQL via Knex.
// Addresses are stored checksummed (42 chars); money columns are in USDC units with 6 decimals.

exports.up = async (knex) => {
  // ---- Off-chain records (system of record lives here, not on-chain) ----

  await knex.schema.createTable("investors", (t) => {
    t.string("address", 42).primary();
    t.string("name", 120).notNullable();
    t.string("email", 255);
    t.string("role", 20).notNullable().defaultTo("investor"); // admin | issuer | investor
    t.string("kyc_status", 20).notNullable().defaultTo("pending"); // pending | verified | revoked
    t.boolean("accredited").notNullable().defaultTo(false);
    t.integer("country"); // ISO 3166-1 numeric
    t.string("kyc_ref", 66); // hash written on-chain
    t.bigInteger("kyc_expires_at"); // unix seconds
    t.timestamps(true, true);
  });

  await knex.schema.createTable("properties", (t) => {
    t.string("token", 42).primary();
    t.string("offering", 42).notNullable();
    t.string("symbol", 16).notNullable().unique();
    t.string("name", 120).notNullable();
    t.string("location", 255);
    t.string("spv_name", 120);
    t.string("jurisdiction", 16);
    t.string("property_type", 40);
    t.decimal("beds", 4, 1);
    t.decimal("baths", 4, 1);
    t.integer("sqft");
    t.integer("year_built");
    t.decimal("purchase_price", 18, 2);
    t.decimal("monthly_rent", 18, 2);
    t.string("occupancy", 60);
    t.text("description");
    t.timestamps(true, true);
  });

  await knex.schema.createTable("activity_log", (t) => {
    t.increments("id");
    t.string("actor", 42);
    t.string("action", 60).notNullable();
    t.text("params"); // JSON
    t.string("status", 10).notNullable(); // ok | error
    t.string("tx_hash", 66);
    t.text("error");
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["actor", "created_at"]);
  });

  // ---- Indexed chain data (rebuildable from events at any time) ----

  await knex.schema.createTable("orders", (t) => {
    t.bigInteger("id").primary(); // on-chain order id
    t.string("token", 42).notNullable();
    t.string("trader", 42).notNullable();
    t.string("side", 4).notNullable(); // buy | sell
    t.decimal("price", 20, 6).notNullable();
    t.bigInteger("amount").notNullable();
    t.bigInteger("remaining").notNullable();
    t.string("status", 12).notNullable(); // open | filled | cancelled
    t.string("cancel_reason", 20);
    t.bigInteger("placed_block").notNullable();
    t.string("placed_tx", 66).notNullable();
    t.bigInteger("placed_at").notNullable();
    t.bigInteger("updated_at").notNullable();
    t.index(["trader", "status"]);
    t.index(["token", "status"]);
  });

  const eventColumns = (t) => {
    t.bigInteger("block_number").notNullable();
    t.string("tx_hash", 66).notNullable();
    t.integer("log_index").notNullable();
    t.bigInteger("block_time").notNullable();
    t.unique(["tx_hash", "log_index"]);
  };

  await knex.schema.createTable("trades", (t) => {
    t.increments("id");
    t.string("token", 42).notNullable();
    t.bigInteger("maker_order_id").notNullable();
    t.bigInteger("taker_order_id").notNullable();
    t.string("buyer", 42).notNullable();
    t.string("seller", 42).notNullable();
    t.decimal("price", 20, 6).notNullable();
    t.bigInteger("amount").notNullable();
    t.decimal("buyer_fee", 20, 6).notNullable();
    t.decimal("seller_fee", 20, 6).notNullable();
    eventColumns(t);
    t.index(["token", "block_number"]);
    t.index(["buyer"]);
    t.index(["seller"]);
  });

  await knex.schema.createTable("distributions", (t) => {
    t.increments("id");
    t.string("token", 42).notNullable();
    t.decimal("amount", 20, 6).notNullable();
    t.decimal("per_token", 24, 10).notNullable();
    t.string("memo", 255);
    eventColumns(t);
    t.index(["token"]);
  });

  await knex.schema.createTable("valuations", (t) => {
    t.increments("id");
    t.string("token", 42).notNullable();
    t.decimal("nav_per_token", 20, 6).notNullable();
    t.string("report_uri", 255);
    eventColumns(t);
    t.index(["token"]);
  });

  await knex.schema.createTable("sync_state", (t) => {
    t.string("key", 64).primary();
    t.text("value");
  });
};

exports.down = async (knex) => {
  for (const table of ["sync_state", "valuations", "distributions", "trades", "orders", "activity_log", "properties", "investors"]) {
    await knex.schema.dropTableIfExists(table);
  }
};
