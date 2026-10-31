// Database connection. SQLite (a single file, zero setup) by default; MySQL when DATABASE_URL
// is a mysql:// URL. Both use the same Knex queries and migrations.
//
//   (unset)                                  -> ./data/homechain.sqlite
//   DATABASE_URL=sqlite:///abs/path/file.db  -> that SQLite file
//   DATABASE_URL=sqlite::memory:             -> in-memory (tests)
//   DATABASE_URL=mysql://user:pass@host:3306/homechain
const fs = require("fs");
const path = require("path");
const knex = require("knex");

const MIGRATIONS = path.join(__dirname, "migrations");

function createDb(url = process.env.DATABASE_URL) {
  if (url && /^mysql2?:\/\//.test(url)) {
    return knex({
      client: "mysql2",
      connection: { uri: url.replace(/^mysql2:/, "mysql:"), decimalNumbers: true, supportBigNumbers: true },
      pool: { min: 0, max: 10 },
    });
  }
  let filename;
  if (url === "sqlite::memory:") filename = ":memory:";
  else if (url && url.startsWith("sqlite://")) filename = url.slice("sqlite://".length);
  else filename = path.join(__dirname, "..", "data", "homechain.sqlite");
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  return knex({ client: "better-sqlite3", connection: { filename }, useNullAsDefault: true });
}

async function migrate(db) {
  await db.migrate.latest({ directory: MIGRATIONS, loadExtensions: [".js"] });
}

function describe(db) {
  const client = db.client.config.client;
  if (client === "mysql2") {
    const u = new URL(db.client.config.connection.uri);
    return `MySQL ${u.host}${u.pathname}`;
  }
  return `SQLite ${db.client.config.connection.filename}`;
}

module.exports = { createDb, migrate, describe };
