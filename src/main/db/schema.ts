import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { runMigrations } from './migrations';

let db: Database.Database;

function getDbPath(): string {
  try {
    
    const { app } = require('electron') as typeof import('electron');
    if (app && app.getPath) {
      return path.join(app.getPath('userData'), 'seivapes.db');
    }
  } catch {
    
  }
  return path.join(__dirname, '../../seivapes.db');
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    runMigrations(db);
    bootstrapFirstRun(db);
  }
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('manager','cashier')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      vendor TEXT,
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      low_stock_threshold INTEGER NOT NULL DEFAULT 5,
      age_restricted INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      dob TEXT,
      license_number TEXT,
      notes TEXT,
      opt_in_sms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id),
      subtotal REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0.0825,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT CHECK(payment_method IN ('cash','card','split')),
      payment_status TEXT DEFAULT 'pending',
      terminal_ref TEXT,
      cash_tendered REAL,
      change_given REAL,
      auth_code TEXT,
      last4 TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      product_id INTEGER REFERENCES products(id),
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier TEXT NOT NULL,
      invoice_number TEXT,
      date TEXT,
      total_cost REAL DEFAULT 0,
      received_by INTEGER REFERENCES users(id),
      pdf_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      product_id INTEGER REFERENCES products(id),
      qty_received INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sms_blasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      sent_by INTEGER REFERENCES users(id),
      recipient_count INTEGER DEFAULT 0,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shift_totals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER REFERENCES users(id),
      cash_total REAL DEFAULT 0,
      card_total REAL DEFAULT 0,
      sale_count INTEGER DEFAULT 0,
      tax_total REAL DEFAULT 0,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS drawer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER REFERENCES users(id),
      cashier_name TEXT,
      event TEXT NOT NULL,
      amount REAL DEFAULT 0,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS receipt_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      store_name TEXT DEFAULT 'My Store',
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      footer_message TEXT DEFAULT 'Thank you for your purchase!',
      tax_rate REAL DEFAULT 0.0825,
      min_age INTEGER DEFAULT 21
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      transaction_id INTEGER REFERENCES transactions(id),
      change INTEGER NOT NULL,
      reason TEXT NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      sku TEXT UNIQUE,
      label TEXT NOT NULL,
      barcode TEXT,
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      kind TEXT NOT NULL DEFAULT 'birthday',
      discount_pct REAL NOT NULL DEFAULT 15,
      benefit_kind TEXT,
      benefit_value REAL DEFAULT 0,
      benefit_category TEXT,
      expires_at TEXT,
      used INTEGER NOT NULL DEFAULT 0,
      redeemed_at TEXT,
      redeemed_txn_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS loyalty_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      point_cost INTEGER NOT NULL,
      benefit_kind TEXT NOT NULL,
      benefit_value REAL DEFAULT 0,
      benefit_category TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS age_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER REFERENCES transactions(id),
      customer_id INTEGER REFERENCES customers(id),
      cashier_id INTEGER REFERENCES users(id),
      cashier_name TEXT,
      customer_name TEXT,
      dob TEXT,
      age_at_sale INTEGER,
      min_age INTEGER,
      result TEXT,
      method TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS z_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT NOT NULL,
      generated_by INTEGER REFERENCES users(id),
      shift_opened_at TEXT,
      cash_total REAL DEFAULT 0,
      card_total REAL DEFAULT 0,
      split_total REAL DEFAULT 0,
      sale_count INTEGER DEFAULT 0,
      tax_total REAL DEFAULT 0,
      discount_total REAL DEFAULT 0,
      gross_sales REAL DEFAULT 0,
      net_sales REAL DEFAULT 0,
      report_json TEXT
    );

    INSERT OR IGNORE INTO receipt_config (id) VALUES (1);
    INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_expiry_days', '365');
    INSERT OR IGNORE INTO loyalty_rewards (id, name, point_cost, benefit_kind, benefit_value, benefit_category) VALUES
      (1, '$5 off', 100, 'discount_amount', 5, NULL),
      (2, 'Free drink', 250, 'free_category', 0, 'Beverages'),
      (3, 'BOGO disposable', 500, 'bogo_category', 0, 'Vape');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_type', 'mock');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_ip', '192.168.1.100');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_port', '9100');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_mid', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_tid', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('printer_interface', 'printer');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('printer_type', 'star');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('merchant_fee_credit_pct', '0');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('merchant_fee_debit_pct', '0');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('merchant_fee_flat_cents', '0');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_account_sid', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_auth_token', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_from_number', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('zebra_ip', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('zebra_port', '9100');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('cash_float', '200');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('drawer_auto_pop', '1');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('drawer_type', 'printer');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('drawer_com_port', '');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('drawer_baud', '9600');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('drawer_kick_hex', '1B 70 00 19 FA');
  `);

  
  try { db.exec(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`); } catch {  }
  try { db.exec(`ALTER TABLE transactions ADD COLUMN tip_amount REAL DEFAULT 0`); } catch {  }
  try { db.exec(`ALTER TABLE transactions ADD COLUMN signature_data TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE transactions ADD COLUMN card_type TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE products ADD COLUMN vendor TEXT`); } catch {  }
  let addedAgeCol = false;
  try { db.exec(`ALTER TABLE products ADD COLUMN age_restricted INTEGER NOT NULL DEFAULT 0`); addedAgeCol = true; } catch {  }
  
  
  if (addedAgeCol) { try { db.exec(`UPDATE products SET age_restricted = 1`); } catch {  } }
  try { db.exec(`ALTER TABLE customers ADD COLUMN license_number TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN address TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN city TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN state TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN zip TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN dob TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE receipt_config ADD COLUMN min_age INTEGER DEFAULT 21`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN lifetime_points INTEGER NOT NULL DEFAULT 0`); } catch {  }
  try { db.exec(`ALTER TABLE transaction_items ADD COLUMN variant_id INTEGER`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN gold_member INTEGER NOT NULL DEFAULT 0`); } catch {  }
  try { db.exec(`ALTER TABLE promo_codes ADD COLUMN benefit_kind TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE promo_codes ADD COLUMN benefit_value REAL DEFAULT 0`); } catch {  }
  try { db.exec(`ALTER TABLE promo_codes ADD COLUMN benefit_category TEXT`); } catch {  }
  
  try { db.exec(`UPDATE customers SET gold_member = 1 WHERE lifetime_points >= 1500`); } catch {  }

  
  db.exec(`UPDATE receipt_config SET tax_rate = 0.0825 WHERE id = 1 AND tax_rate = 0.08`);

  
  
  db.exec(`UPDATE receipt_config SET store_name = 'My Store' WHERE id = 1 AND store_name = 'SEI Vapes'`);
  db.exec(`UPDATE receipt_config SET address = '' WHERE id = 1 AND address = '716 E Tyler St Athens TX 75751'`);
  db.exec(`UPDATE receipt_config SET phone = '' WHERE id = 1 AND phone = '+1 (903) 675-5173'`);

  
  db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('printer_type', 'star')`);

  
  try { db.exec(`ALTER TABLE shift_totals ADD COLUMN starting_cash REAL DEFAULT 200`); } catch {  }
  try { db.exec(`ALTER TABLE transaction_items ADD COLUMN description TEXT`); } catch {  }
  
  try { db.exec(`ALTER TABLE transaction_items ADD COLUMN category TEXT`); } catch {  }

  
  try { db.exec(`ALTER TABLE products ADD COLUMN low_stock_alert INTEGER NOT NULL DEFAULT 1`); } catch {  }

  
  
  try { db.exec(`ALTER TABLE customers ADD COLUMN sms_consent_at TEXT`); } catch {  }
  try { db.exec(`ALTER TABLE customers ADD COLUMN sms_consent_signature TEXT`); } catch {  }

  
  
  
  
}


export function bootstrapFirstRun(db: Database.Database): void {
  if (process.env.RACKD_DEV_SEED !== '1') return;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return;
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(
    "INSERT INTO users (username, name, password_hash, role, is_active, must_change_password, must_change_pin) VALUES ('admin', 'Admin', ?, 'admin', 1, 1, 1)"
  ).run(hash);
  console.log('[dev] seeded default admin (admin/admin123) — RACKD_DEV_SEED=1');
}
