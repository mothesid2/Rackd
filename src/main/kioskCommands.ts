import { app } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { getSupabase } from './supabase/client';
import { isDayOpen } from './daySession';
import { getCurrentSession } from './ipc/auth';

/**
 * Remote kiosk reset applier (spec item 5).
 *
 * The Owner Console queues a `reset` in `register_commands`, keyed by this kiosk's
 * machine_id. RLS returns only THIS kiosk's commands. We apply it under two guards:
 *
 *   DEFER — never interrupt a live shift. If the business day is open or an employee
 *           is signed in, we ack the command and wait (re-checked each sync cycle;
 *           it lands at the next idle / day close-out).
 *
 *   FLUSH-THEN-RESET — never lose an un-pushed sale. We reset only once the sync
 *           outbox is fully drained. If anything dead-lettered, we mark the command
 *           `blocked` with a note (surfaced in the Owner Console) instead of wiping.
 *
 * Applying the reset clears this install's activation + location lock and relaunches
 * into the setup flow. The machine_id is preserved, so re-activating onto a new
 * location updates the same seat rather than consuming a new one.
 */

// Settings cleared on reset — activation, cached token, license, and the location
// lock + day session. machine_id is intentionally kept (stable seat identity).
const RESET_KEYS = [
  'license_cache', 'license_key', 'auth_token', 'auth_token_exp', 'license_last_check',
  'kiosk_locked_location_id', 'kiosk_setup_complete',
  'day_session_open', 'day_session_opened_at', 'day_session_opened_by_id', 'day_session_opened_by_name',
];

interface CommandRow {
  id: string;
  command: string;
  status: string;
}

export type ResetAction = 'defer' | 'blocked' | 'draining' | 'reset';
export interface ResetDecision { action: ResetAction; note: string | null; status?: string }

/**
 * Pure policy: given the kiosk's live state, decide what to do with a reset command.
 * Order matters — defer past a live shift first, then hold on dead-letters, then
 * wait for the outbox to drain, else reset. Kept pure so every branch is testable.
 */
export function decideReset(state: {
  dayOpen: boolean;
  hasSession: boolean;
  deadLetters: number;
  pending: number;
}): ResetDecision {
  if (state.dayOpen || state.hasSession) return { action: 'defer', note: 'deferred: waiting for day close-out' };
  if (state.deadLetters > 0) {
    return { action: 'blocked', status: 'blocked', note: `blocked: ${state.deadLetters} unsynced record(s) need attention before reset` };
  }
  if (state.pending > 0) return { action: 'draining', note: `draining outbox (${state.pending} pending)` };
  return { action: 'reset', note: null };
}

function pendingSyncCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0 AND dead_letter = 0').get() as { n: number }).n;
}
function actionableDeadLetters(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0').get() as { n: number }).n;
}

function applyReset(db: Database.Database): void {
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const tx = db.transaction(() => { for (const k of RESET_KEYS) del.run(k); });
  tx();
  console.log('[kiosk-reset] local lock + activation cleared; relaunching into setup.');
  // Relaunch clean — isActivated() is now false, so the app boots to activation.
  try { app.relaunch(); } catch { /* ignore */ }
  app.exit(0);
}

/**
 * Called from the sync cycle after a successful reachable pass. Non-throwing —
 * any error is logged and retried next cycle. `supabase` is the authenticated
 * client; `db` the local database.
 */
export async function checkAndApplyResets(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database = getDb()
): Promise<void> {
  // RLS returns only this kiosk's commands (register_id claim = machine_id).
  const { data, error } = await supabase
    .from('register_commands')
    .select('id, command, status')
    .eq('command', 'reset')
    .in('status', ['pending', 'acked'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.warn('[kiosk-reset] check failed:', error.message); return; }
  const cmd = (data?.[0] as CommandRow | undefined);
  if (!cmd) return;

  const now = new Date().toISOString();
  // Ack on first sight so the Owner Console knows the kiosk received it.
  if (cmd.status === 'pending') {
    await supabase.from('register_commands').update({ status: 'acked', acked_at: now }).eq('id', cmd.id);
  }

  const decision = decideReset({
    dayOpen: isDayOpen(db),
    hasSession: !!getCurrentSession(),
    deadLetters: actionableDeadLetters(db),
    pending: pendingSyncCount(db),
  });

  if (decision.action !== 'reset') {
    // Defer / blocked / draining — surface the reason; re-checked next cycle.
    const patch: Record<string, unknown> = { note: decision.note };
    if (decision.status) patch.status = decision.status;
    await supabase.from('register_commands').update(patch).eq('id', cmd.id);
    return;
  }

  // Safe: mark done while still authenticated, THEN clear local state + relaunch.
  await supabase.from('register_commands').update({ status: 'done', note: null, completed_at: new Date().toISOString() }).eq('id', cmd.id);
  applyReset(db);
}
