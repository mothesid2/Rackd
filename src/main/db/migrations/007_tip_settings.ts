import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Customer-facing tip prompt settings (Option B).
 *
 * The tip is collected on the customer display BEFORE the card is charged, so the
 * terminal captures base + tip in a single Sale (the VP100's own tip prompt should
 * be turned off to avoid a double-ask). These settings drive that prompt:
 *   tip_enabled — show the tip screen on card sales at all.
 *   tip_presets — comma-separated percentages of the pre-tax subtotal (e.g. 15,18,20).
 */
export const migration007: Migration = {
  id: 7,
  name: 'tip_settings',

  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(receipt_config)`).all() as { name: string }[];
    if (!cols.length) return; // receipt_config not present yet (created in schema.ts before migrations)
    if (!cols.some((c) => c.name === 'tip_enabled')) {
      db.exec(`ALTER TABLE receipt_config ADD COLUMN tip_enabled INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!cols.some((c) => c.name === 'tip_presets')) {
      db.exec(`ALTER TABLE receipt_config ADD COLUMN tip_presets TEXT;`);
    }
    try {
      db.prepare(`UPDATE receipt_config SET tip_presets = ? WHERE id = 1 AND (tip_presets IS NULL OR tip_presets = '')`)
        .run('15,18,20');
    } catch { /* row not present yet */ }
  },

  down(db: Database.Database) {
    // SQLite can't drop columns pre-3.35; leaving them is harmless.
  },
};
