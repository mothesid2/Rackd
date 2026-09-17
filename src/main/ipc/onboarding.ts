import { ipcMain } from 'electron';
import { getDb } from '../db/schema';



interface StageDef {
  key: string;
  label: string;
  optional?: boolean;
  done: (db: ReturnType<typeof getDb>) => boolean;
  next: string; 
}

function count(db: ReturnType<typeof getDb>, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
}
function setting(db: ReturnType<typeof getDb>, key: string): string {
  return ((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '').trim();
}

const STAGES: StageDef[] = [
  {
    key: 'account_created', label: 'Account created',
    done: () => true,
    next: 'Welcome to Rackd! Let’s get your store live.',
  },
  {
    key: 'store_profile_complete', label: 'Store profile',
    done: (db) => {
      const c = db.prepare('SELECT store_name, address, phone, tax_rate FROM receipt_config LIMIT 1')
        .get() as { store_name?: string; address?: string; phone?: string; tax_rate?: number } | undefined;
      const named = !!c?.store_name && c.store_name.trim() !== '' && c.store_name.trim().toLowerCase() !== 'my store';
      return named && (!!c?.address?.trim() || !!c?.phone?.trim());
    },
    next: 'Add your store name, address, phone, and tax rate in Settings → Receipt Configuration.',
  },
  {
    key: 'first_product_added', label: 'First product added',
    done: (db) => count(db, 'SELECT COUNT(*) AS n FROM products') > 0,
    next: 'Add your first product in Merchandise → Inventory (scan a barcode or enter it manually).',
  },
  {
    key: 'payment_terminal_connected', label: 'Payment terminal connected',
    done: (db) => { const t = setting(db, 'terminal_type'); return !!t && t !== 'mock'; },
    next: 'Connect your card terminal in Settings → Card Terminal (or keep Mock mode for testing).',
  },
  {
    key: 'first_transaction_complete', label: 'First sale rung up',
    done: (db) => count(db, 'SELECT COUNT(*) AS n FROM transactions') > 0,
    next: 'Ring up a test sale on the POS to confirm everything works end to end.',
  },
  {
    key: 'staff_invited', label: 'Staff account created',
    done: (db) => count(db, 'SELECT COUNT(*) AS n FROM users') > 1,
    next: 'Create at least one employee account in Settings → User Management.',
  },
  {
    key: 'loyalty_program_configured', label: 'Loyalty program', optional: true,
    done: (db) => count(db, 'SELECT COUNT(*) AS n FROM loyalty_rewards') > 0,
    next: 'Optional: set up loyalty rewards so customers earn points.',
  },
  {
    key: 'sms_marketing_configured', label: 'SMS marketing', optional: true,
    done: (db) => !!setting(db, 'twilio_account_sid'),
    next: 'Optional: connect Twilio in Settings → Twilio SMS to text customers.',
  },
];

const BOOKING_URL = 'https://rackd.io/setup-call';

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:status', () => {
    try {
      const db = getDb();
      const dismissed = setting(db, 'onboarding_dismissed') === '1';

      const stages = STAGES.map((s) => {
        const done = s.done(db);
        
        const stampKey = `onboarding_at_${s.key}`;
        let completed_at: string | null = setting(db, stampKey) || null;
        if (done && !completed_at) {
          completed_at = new Date().toISOString();
          db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(stampKey, completed_at);
        }
        return { key: s.key, label: s.label, optional: !!s.optional, done, completed_at, next: s.next };
      });

      
      const requiredDone = stages.filter((s) => !s.optional && s.done).length;
      const requiredTotal = stages.filter((s) => !s.optional).length;
      const coreComplete = requiredDone === requiredTotal;

      const doneCount = stages.filter((s) => s.done).length;
      const overall_progress = Math.round((doneCount / (STAGES.length + 1)) * 100) +
        (coreComplete ? Math.round((1 / (STAGES.length + 1)) * 100) : 0);

      
      const firstPending = stages.find((s) => !s.done);
      const checklist = stages.map((s) => ({
        label: s.label,
        optional: s.optional,
        status: s.done ? 'complete' : (s === firstPending ? 'current' : 'upcoming'),
        completed_at: s.completed_at,
      }));

      
      const addedProducts = !!stages.find((s) => s.key === 'first_product_added')?.done;
      const soldSomething = !!stages.find((s) => s.key === 'first_transaction_complete')?.done;
      const book_a_call = addedProducts && !soldSomething;

      return {
        success: true,
        complete: coreComplete,
        dismissed,
        overall_progress: Math.min(100, overall_progress),
        stages,
        checklist,
        next_action: coreComplete
          ? 'Your store is set up. You can hide this checklist.'
          : (firstPending?.next ?? 'Continue setup.'),
        book_a_call: book_a_call
          ? { message: 'Need a hand? Book a free 15-minute setup call and we’ll get your store live together.', booking_url: BOOKING_URL }
          : null,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('onboarding:dismiss', () => {
    try {
      getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('onboarding_dismissed', '1');
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
