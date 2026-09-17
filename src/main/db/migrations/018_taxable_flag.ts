import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration018: Migration = {
  id: 18,
  name: 'taxable_flag',

  up(db: Database.Database) {
    const productCols = db.prepare(`PRAGMA table_info(products)`).all() as { name: string }[];
    if (!productCols.some((c) => c.name === 'is_taxable')) {
      db.exec(`ALTER TABLE products ADD COLUMN is_taxable INTEGER NOT NULL DEFAULT 1;`);
    }

    const ruleCols = db.prepare(`PRAGMA table_info(rebate_rules)`).all() as { name: string }[];
    if (!ruleCols.some((c) => c.name === 'is_taxable_discount')) {
      db.exec(`ALTER TABLE rebate_rules ADD COLUMN is_taxable_discount INTEGER NOT NULL DEFAULT 1;`);
      
      
      db.exec(`UPDATE rebate_rules SET is_taxable_discount = CASE WHEN is_manufacturer_funded = 1 THEN 0 ELSE 1 END;`);
    }
  },

  down(db: Database.Database) {
    
    
    
    
  },
};
