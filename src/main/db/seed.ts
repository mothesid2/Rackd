import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { initSchema } from './schema';

function run() {
  
  
  let userDataDir: string;
  if (process.platform === 'win32' && process.env.APPDATA) {
    userDataDir = path.join(process.env.APPDATA, 'sei-vape-pos');
  } else if (process.platform === 'darwin') {
    userDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'sei-vape-pos');
  } else {
    userDataDir = path.join(os.homedir(), '.config', 'sei-vape-pos');
  }

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, 'seivapes.db');
  console.log('Seeding database at:', dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  
  const managerHash = bcrypt.hashSync('admin123', 10);
  const cashierHash = bcrypt.hashSync('cashier123', 10);

  db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`).run('admin', managerHash, 'manager');
  db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)`).run('cashier1', cashierHash, 'cashier');

  
  
  
  const products = [
    
    { barcode: '100000001', name: 'Disposable Vape — Mint', category: 'Vape', vendor: 'CloudLine', price: 14.99, cost: 6.00, stock_qty: 40, low_stock_threshold: 10, age_restricted: 1 },
    { barcode: '100000002', name: 'Disposable Vape — Berry', category: 'Vape', vendor: 'CloudLine', price: 14.99, cost: 6.00, stock_qty: 35, low_stock_threshold: 10, age_restricted: 1 },
    { barcode: '100000003', name: 'Pod Starter Device', category: 'Vape', vendor: 'CloudLine', price: 29.99, cost: 13.00, stock_qty: 12, low_stock_threshold: 5, age_restricted: 1 },
    
    { barcode: '100000010', name: 'Rolling Papers — King Size', category: 'Smoke', vendor: 'Ashford', price: 3.49, cost: 1.10, stock_qty: 60, low_stock_threshold: 15, age_restricted: 1 },
    { barcode: '100000011', name: 'Glass Hand Pipe', category: 'Smoke', vendor: 'Ashford', price: 24.99, cost: 9.50, stock_qty: 8, low_stock_threshold: 4, age_restricted: 1 },
    { barcode: '100000012', name: 'Butane Torch Lighter', category: 'Smoke', vendor: 'Ashford', price: 12.99, cost: 4.50, stock_qty: 20, low_stock_threshold: 6, age_restricted: 1 },
    
    { barcode: '100000020', name: 'Adult Novelty Item', category: 'Adult', vendor: 'Private Label', price: 39.99, cost: 16.00, stock_qty: 10, low_stock_threshold: 3, age_restricted: 1 },
    { barcode: '100000021', name: 'Personal Lubricant 4oz', category: 'Adult', vendor: 'Private Label', price: 14.99, cost: 5.00, stock_qty: 18, low_stock_threshold: 6, age_restricted: 1 },
    
    { barcode: '100000030', name: 'USB-C Charging Cable', category: 'Accessories', vendor: 'TechBasics', price: 9.99, cost: 3.00, stock_qty: 25, low_stock_threshold: 8, age_restricted: 0 },
    { barcode: '100000031', name: 'Energy Drink 16oz', category: 'Beverages', vendor: 'JoltCo', price: 2.99, cost: 1.10, stock_qty: 48, low_stock_threshold: 12, age_restricted: 0 },
    { barcode: '100000032', name: 'Bottled Water 20oz', category: 'Beverages', vendor: 'JoltCo', price: 1.49, cost: 0.40, stock_qty: 60, low_stock_threshold: 12, age_restricted: 0 },
    { barcode: '100000033', name: 'Snack Chips', category: 'Snacks', vendor: 'JoltCo', price: 2.49, cost: 0.90, stock_qty: 40, low_stock_threshold: 10, age_restricted: 0 },
  ];

  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products (barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of products) {
    insertProduct.run(p.barcode, p.name, p.category, p.vendor, p.price, p.cost, p.stock_qty, p.low_stock_threshold, p.age_restricted);
  }

  
  const customers = [
    { first_name: 'John', last_name: 'Smith', phone: '5551234567', email: 'john.smith@email.com', opt_in_sms: 1 },
    { first_name: 'Maria', last_name: 'Garcia', phone: '5552345678', email: 'maria.g@email.com', opt_in_sms: 1 },
    { first_name: 'Tyler', last_name: 'Johnson', phone: '5553456789', email: '', opt_in_sms: 0 },
    { first_name: 'Ashley', last_name: 'Williams', phone: '5554567890', email: 'ashley.w@email.com', opt_in_sms: 1 },
    { first_name: 'Chris', last_name: 'Brown', phone: '5555678901', email: '', opt_in_sms: 0 },
  ];

  const insertCustomer = db.prepare(`
    INSERT OR IGNORE INTO customers (first_name, last_name, phone, email, opt_in_sms)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const c of customers) {
    insertCustomer.run(c.first_name, c.last_name, c.phone, c.email, c.opt_in_sms);
  }

  
  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: number };
  db.prepare(`INSERT OR IGNORE INTO shift_totals (cashier_id, opened_at) VALUES (?, datetime('now'))`).run(adminUser.id);

  console.log('Database seeded successfully!');
  console.log('Users: admin (password: admin123), cashier1 (password: cashier123)');
  console.log('Products: sample products inserted');
  console.log('Customers: 5 sample customers inserted');
  db.close();
  process.exit(0);
}

run();
