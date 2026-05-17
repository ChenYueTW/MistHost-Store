import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { paths } from "./config.js";

const databaseFile = path.resolve(paths.rootDir, config.database.file);
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

export const db = new Database(databaseFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function normalizeResult(result) {
  return {
    affectedRows: result.changes,
    insertId: Number(result.lastInsertRowid)
  };
}

function executeStatement(sql, params = {}) {
  const statement = db.prepare(sql);
  if (statement.reader) return [statement.all(params)];
  return [normalizeResult(statement.run(params))];
}

export const pool = {
  async getConnection() {
    return {
      async beginTransaction() {
        db.prepare("BEGIN").run();
      },
      async commit() {
        db.prepare("COMMIT").run();
      },
      async rollback() {
        db.prepare("ROLLBACK").run();
      },
      async execute(sql, params = {}) {
        return executeStatement(sql, params);
      },
      release() {}
    };
  }
};

export async function query(sql, params = {}) {
  const [rows] = executeStatement(sql, params);
  return rows;
}

export async function findProduct(id) {
  const rows = await query("SELECT * FROM products WHERE id = :id AND active = 1", { id });
  return rows[0] ?? null;
}

export async function getActiveProducts() {
  return query("SELECT * FROM products WHERE active = 1 ORDER BY sort_order ASC, id ASC");
}

export async function getProductsByCategory(category) {
  return query("SELECT * FROM products WHERE active = 1 AND category = :category ORDER BY sort_order ASC, id ASC", { category });
}
