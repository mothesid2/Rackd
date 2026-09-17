import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration021: Migration = {
  id: 21,
  name: 'categories',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const existing = db.prepare(
      `SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND trim(category) <> '' ORDER BY category`
    ).all() as { category: string }[];
    const insert = db.prepare(`INSERT OR IGNORE INTO categories (name) VALUES (?)`);
    for (const row of existing) insert.run(row.category.trim());
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS categories;`);
  },
};
